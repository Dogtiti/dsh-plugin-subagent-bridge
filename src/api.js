import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MAX_BLOCKING_SECONDS, MAX_WAIT_SECONDS } from './constants.js'
import { callerDepth, enterChain, guardDepth, leaveChain, takeDispatchSlot } from './guards.js'
import { beginOperation, finishOperation, modelInWindow, operationReport, sumUsage } from './operations.js'
import { withAssumptionPolicy } from './policy.js'
import { askable, attachQuestionAnswerer, pendingQuestion } from './questions.js'
import { assertCapacity, rememberOutcome, resolveWorker, saveWorkers } from './registry.js'
import { resolveClaude, runClaude } from './runners/claude.js'
import { resolveCodex, runCodex } from './runners/codex.js'
import { applyModelSpec, attachToWorkspace, finalAnswer, firstDeliveredMessageSeq, lastTurn, readOnce, resolveCwd, safeTitle, waitForTurnEnd, workerStatus, workspaceOptions } from './sessions.js'
import { requireString, sleep, text } from './utils.js'

export function createApi(ctx, state, settings) {
  /* Callers may hand in a bare bookkeeping object; fill in what the api needs. */
  state.dispatched = state.dispatched ?? new Set()
  state.baseline = state.baseline ?? new Map()
  state.readFloor ??= new Map()
  state.pendingDispatch ??= new Set()
  state.workers = state.workers ?? new Map()
  state.chain = state.chain ?? { depth: 0, active: 0, until: 0 }
  state.recent = state.recent ?? []
  state.onPersistenceError ??= (message) => {
    if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
    else console.warn(message)
  }
  const controller = () => ctx.get('sessionController')
  const sessions = () => ctx.get('sessions')
  const warning = () => state.persistenceError === undefined ? {} : { persistenceWarning: state.persistenceError }
  const markDispatched = (sessionId, before) => {
    state.dispatched.add(sessionId)
    state.baseline.set(sessionId, before)
    const floor = state.readFloor.get(sessionId)
    state.readFloor.set(sessionId, floor === undefined ? before : Math.min(floor, before))
  }
  const claimDispatch = (sessionId) => {
    if (state.pendingDispatch.has(sessionId) || resolveWorker(state, sessionId)?.record?.dispatchState === 'dispatching') throw new Error(`a dispatch to ${sessionId} is still being accepted; inspect it before retrying`)
    state.pendingDispatch.add(sessionId)
    return () => state.pendingDispatch.delete(sessionId)
  }
  const newRecord = (sessionId, root, taskName, countsTowardLimit = false) => {
    const baseName = taskName ?? `task_${sessionId.slice('session-'.length, 'session-'.length + 8)}`
    if (taskName !== undefined && state.workers.has(taskName)) throw new Error(`task_name ${JSON.stringify(taskName)} is already in use`)
    let name = baseName
    for (let suffix = 2; state.workers.has(name) || (taskName === undefined && state.reserved?.has(name)); suffix += 1) name = `${baseName}_${suffix}`
    return { taskName: name, sessionId, status: 'open', countsTowardLimit, root, createdAt: Date.now(), updatedAt: Date.now() }
  }
  /* Record intent before sending. A lost response is not proof the Host rejected a prompt. */
  const prepareDispatch = (record, before, kind, mode, previousRecord) => {
    const sessionId = record.sessionId
    const previous = {
      record: previousRecord,
      dispatched: state.dispatched.has(sessionId),
      baseline: state.baseline.get(sessionId),
      floor: state.readFloor.get(sessionId),
    }
    const operation = beginOperation(state, { sessionId, requestId: randomUUID(), kind, mode, seqStart: before })
    operation.status = 'dispatching'
    delete record.outcome
    delete record.dispatchError
    Object.assign(record, { requestId: operation.requestId, operationId: operation.operationId, dispatchState: 'dispatching', updatedAt: Date.now() })
    state.workers.set(record.taskName, record)
    markDispatched(sessionId, before)
    const rollback = (status = 'rejected') => {
      /* A concurrent close wins over the state captured before the request. */
      const closed = record.status === 'closed'
      if (previous.record === undefined) state.workers.delete(record.taskName)
      else {
        for (const key of Object.keys(record)) delete record[key]
        Object.assign(record, previous.record)
        if (closed) { record.status = 'closed'; record.updatedAt = Date.now() }
      }
      if (!previous.dispatched) state.dispatched.delete(sessionId)
      for (const [map, value] of [[state.baseline, previous.baseline], [state.readFloor, previous.floor]]) {
        if (value === undefined) map.delete(sessionId)
        else map.set(sessionId, value)
      }
      finishOperation(operation, { status })
    }
    const unknown = async (error) => {
      record.dispatchState = 'unknown'
      record.dispatchError = String(error?.message ?? error)
      record.updatedAt = Date.now()
      finishOperation(operation, { status: 'unknown' })
      await saveWorkers(settings, state)
      return new Error(`dispatch outcome is unknown for session ${sessionId}, request ${operation.requestId}; inspect it before retrying: ${record.dispatchError}`)
    }
    const accepted = (result) => {
      if (result?.accepted === false) rollback()
      else {
        record.dispatchState = result?.accepted === true ? 'accepted' : 'unknown'
        record.updatedAt = Date.now()
        finishOperation(operation, { status: record.dispatchState })
      }
    }
    return { operation, rollback, unknown, accepted }
  }

  return {
    async listSessions() {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      /* The service answers `{ items }`; older shapes returned the array itself. */
      const listed = await service.list({}, undefined)
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
      const titleService = ctx.get('sessionTitle')
      return items.map((item) => {
        /* A live session folds its title from the log; cold rows simply have none. */
        const live = sessions()?.get?.(item.sessionId)
        const derived = live === undefined || live === null ? undefined : safeTitle(titleService, live)
        const title = typeof item.title === 'string' ? item.title : derived
        return {
          sessionId: item.sessionId,
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
          running: item.running === true,
          blank: item.blank === true,
          updatedAt: item.updatedAt ?? null,
        }
      })
    },

    async spawn({ taskName, message, forkTurns, from, cwd, model, reasoningEffort, workspace, mode }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      state.reserved ??= new Map()
      if (state.workers.has(taskName) || state.reserved.has(taskName)) throw new Error(`task_name ${JSON.stringify(taskName)} is already in use`)
      const root = typeof cwd === 'string' && cwd !== '' ? cwd : forkTurns === 'all' ? `fork:${String(from)}` : '(default)'
      guardDepth(state, settings, 0, 'dsh_spawn')
      state.reserved.set(taskName, root)
      try {
        assertCapacity(state, settings, root, taskName)
        takeDispatchSlot(state, settings)
        let placed
        let sessionId
        if (forkTurns === 'all') {
          sessionId = (await service.fork({ sessionId: from }))?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('forking returned no session id')
        } else {
          sessionId = (await service.create(cwd === undefined ? {} : { cwd }))?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session controller did not return a session id')
          placed = await attachToWorkspace(ctx, sessionId, cwd, workspaceOptions(workspace))
        }
        const appliedModel = await applyModelSpec(ctx, sessionId, model, reasoningEffort)
        attachQuestionAnswerer(state, ctx.get('agents')?.get?.(sessionId))
        const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
        const deliveryMode = mode === 'steer' ? 'steer' : 'queue'
        const record = newRecord(sessionId, root, taskName, true)
        const transaction = prepareDispatch(record, before, 'spawn', deliveryMode)
        /* The registry now holds the slot; do not count the reservation twice. */
        state.reserved.delete(taskName)
        await saveWorkers(settings, state)
        if (record.status === 'closed') {
          transaction.rollback('cancelled')
          await saveWorkers(settings, state)
          throw new Error('that worker was closed before dispatch')
        }
        let accepted
        try {
          accepted = await service.prompt(
            { sessionId, requestId: transaction.operation.requestId, mode: deliveryMode, content: [{ type: 'text', text: withAssumptionPolicy(settings, message) }] },
            AbortSignal.timeout(30000),
          )
        } catch (error) { throw await transaction.unknown(error) }
        transaction.accepted(accepted)
        await saveWorkers(settings, state)
        return {
          task_name: taskName, sessionId, accepted: accepted?.accepted === true, fork_turns: forkTurns,
          ...(appliedModel === undefined ? {} : { model: appliedModel }),
          ...(placed === undefined ? {} : { workspace: placed }),
          ...operationReport(transaction.operation), ...warning(),
        }
      } finally { state.reserved.delete(taskName) }
    },

    async followup({ worker, message, model, reasoningEffort, mode }) {
      const target = resolveWorker(state, worker)
      if (target === undefined) throw new Error(`unknown worker ${JSON.stringify(worker)}`)
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      const release = claimDispatch(target.sessionId)
      const existing = target.record
      const previous = existing === undefined ? undefined : { ...existing }
      const record = existing ?? newRecord(target.sessionId, '(default)')
      let transaction
      try {
        /* Retain main's reopen behavior, but roll it back if no prompt is accepted. */
        if (record.status === 'closed' && record.countsTowardLimit !== false) assertCapacity(state, settings, record.root ?? '(default)')
        takeDispatchSlot(state, settings)
        record.status = 'open'
        record.updatedAt = Date.now()
        const appliedModel = await applyModelSpec(ctx, target.sessionId, model, reasoningEffort)
        if (record.status === 'closed') throw new Error('that worker was closed before dispatch')
        const before = Number(sessions()?.get?.(target.sessionId)?.seq ?? 0)
        const deliveryMode = mode === 'steer' ? 'steer' : 'queue'
        transaction = prepareDispatch(record, before, 'followup', deliveryMode, previous)
        await saveWorkers(settings, state)
        if (record.status === 'closed') {
          transaction.rollback('cancelled')
          await saveWorkers(settings, state)
          throw new Error('that worker was closed before dispatch')
        }
        let accepted
        try {
          accepted = await service.prompt(
            { sessionId: target.sessionId, requestId: transaction.operation.requestId, mode: deliveryMode, content: [{ type: 'text', text: withAssumptionPolicy(settings, message) }] },
            AbortSignal.timeout(30000),
          )
        } catch (error) { throw await transaction.unknown(error) }
        transaction.accepted(accepted)
        await saveWorkers(settings, state)
        return {
          worker: target.taskName ?? target.sessionId, sessionId: target.sessionId, accepted: accepted?.accepted === true,
          ...(appliedModel === undefined ? {} : { model: appliedModel }),
          ...operationReport(transaction.operation), ...warning(),
        }
      } catch (error) {
        if (transaction === undefined && previous !== undefined && record.status !== 'closed') {
          Object.assign(record, previous)
          await saveWorkers(settings, state)
        }
        throw error
      } finally { release() }
    },

    async close({ worker }) {
      const target = resolveWorker(state, worker)
      if (target === undefined) throw new Error(`unknown worker ${JSON.stringify(worker)}`)
      if (target.record !== undefined) {
        target.record.status = 'closed'
        target.record.updatedAt = Date.now()
        await saveWorkers(settings, state)
      }
      return { worker: target.taskName ?? target.sessionId, sessionId: target.sessionId, status: 'closed' }
    },

    async listWorkers() {
      const rows = []
      for (const record of state.workers.values()) {
        const status = record.status === 'closed' ? 'closed' : workerStatus(ctx, record.sessionId, state, settings)
        if (record.status !== 'closed') await rememberOutcome(settings, state, record.sessionId, status)
        rows.push({
          task_name: record.taskName, sessionId: record.sessionId, root: record.root ?? '(default)', status,
          ...(record.dispatchState === 'unknown' || record.dispatchState === 'dispatching'
            ? { dispatchState: record.dispatchState, requestId: record.requestId, operationId: record.operationId,
                ...(record.dispatchError === undefined ? {} : { dispatchError: record.dispatchError }) } : {}),
          ...warning(),
        })
      }
      return rows
    },

    async task({ prompt, cwd, sessionId, agentPreset, timeoutSeconds, model, reasoningEffort, workspace, mode, signal }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      if (signal?.aborted) throw new Error('caller cancelled before dispatch')
      const seconds = Math.min(MAX_BLOCKING_SECONDS,
        Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : Number.isFinite(settings.taskTimeoutSeconds) ? settings.taskTimeoutSeconds : MAX_BLOCKING_SECONDS))
      guardDepth(state, settings, 0, 'dsh_task')
      takeDispatchSlot(state, settings)
      const started = Date.now()
      let placed
      let targetId = sessionId
      const created = targetId === undefined
      if (created) {
        targetId = (await service.create(cwd === undefined ? {} : { cwd }))?.sessionId
        if (typeof targetId !== 'string' || targetId === '') throw new Error('session controller did not return a session id')
        placed = await attachToWorkspace(ctx, targetId, cwd, workspaceOptions(workspace))
      } else if (mode !== 'steer' && ctx.get('agents')?.get?.(targetId)?.status === 'running') {
        throw new Error('that session is running; pass mode:"steer" to insert into that turn, or use dsh_dispatch plus dsh_read_result')
      }
      const release = claimDispatch(targetId)
      const existing = resolveWorker(state, targetId)?.record
      const record = existing ?? newRecord(targetId, typeof cwd === 'string' && cwd !== '' ? cwd : '(default)')
      const deliveryMode = mode === 'steer' ? 'steer' : 'queue'
      let appliedModel, transaction, before, finished, accepted
      const waitController = new AbortController()
      try {
        if (record.status === 'closed') throw new Error('that worker is closed; reopen it with dsh_followup')
        appliedModel = await applyModelSpec(ctx, targetId, model, reasoningEffort)
        if (signal?.aborted) throw new Error('caller cancelled before dispatch')
        if (record.status === 'closed') throw new Error('that worker was closed before dispatch')
        attachQuestionAnswerer(state, ctx.get('agents')?.get?.(targetId))
        const turnBefore = lastTurn(ctx, targetId)
        const waitAfter = deliveryMode === 'steer' ? Math.max(0, turnBefore - 1) : turnBefore
        before = Number(sessions()?.get?.(targetId)?.seq ?? 0)
        transaction = prepareDispatch(record, before, created ? 'task' : 'task-continue', deliveryMode, existing === undefined ? undefined : { ...existing })
        await saveWorkers(settings, state)
        if (signal?.aborted || record.status === 'closed') {
          transaction.rollback('cancelled')
          await saveWorkers(settings, state)
          throw new Error(signal?.aborted ? 'caller cancelled before dispatch' : 'that worker was closed before dispatch')
        }
        const waitSignal = signal === undefined ? waitController.signal : AbortSignal.any([signal, waitController.signal])
        finished = waitForTurnEnd(ctx, targetId, waitAfter, seconds * 1000, waitSignal)
        try {
          const promptSignal = signal === undefined ? AbortSignal.timeout(30000) : AbortSignal.any([signal, AbortSignal.timeout(30000)])
          accepted = await service.prompt(
            { sessionId: targetId, requestId: transaction.operation.requestId, mode: deliveryMode, content: [{ type: 'text', text: withAssumptionPolicy(settings, prompt) }] },
            promptSignal,
          )
        } catch (error) { throw await transaction.unknown(error) }
        transaction.accepted(accepted)
        if (accepted?.accepted === false) waitController.abort()
        await saveWorkers(settings, state)
      } catch (error) {
        waitController.abort()
        throw error
      } finally { release() }
      const end = await finished
      const answerFrom = deliveryMode === 'steer' ? firstDeliveredMessageSeq(ctx, targetId, before) : before
      const collected = accepted?.accepted === false ? { text: '', truncated: false } : finalAnswer(ctx, targetId, answerFrom, settings)
      const turnReason = end?.reason?.kind ?? null
      const status = accepted?.accepted === false ? 'not-accepted' : end === undefined ? (signal?.aborted ? 'cancelled' : 'timeout') : turnReason === 'completed' ? 'completed' : `turn-${String(turnReason)}`
      const report = operationReport(finishOperation(transaction.operation, {
        status, seqEnd: Number(sessions()?.get?.(targetId)?.seq ?? 0), text: collected.text,
        model: modelInWindow(ctx, targetId, before), usage: sumUsage(ctx, targetId, before),
      }))
      return {
        sessionId: targetId, created, status,
        ...(status === 'timeout' ? {
          running: true,
          next: `the worker is still running; do not end the turn. Call dsh_wait({targets:["${targetId}"],timeoutMs:${String(MAX_BLOCKING_SECONDS * 1000)}}) and repeat until it is not "running".`,
        } : status === 'cancelled' ? {
          ...(ctx.get('agents')?.get?.(targetId)?.status === 'running' ? { running: true } : {}),
          next: 'waiting was cancelled; the worker may continue. Check it with dsh_wait before retrying.',
        } : {}),
        ...report,
        ...(appliedModel === undefined ? {} : { model: appliedModel }),
        ...(placed === undefined ? {} : { workspace: placed }),
        mode: deliveryMode, text: collected.text, truncated: collected.truncated, turns: lastTurn(ctx, targetId),
        accepted: accepted?.accepted === true, durationMs: Date.now() - started, ...warning(),
      }
    },

    async wait({ targets, timeoutMs, signal }) {
      const budget = Math.min(
        MAX_BLOCKING_SECONDS * 1000,
        Math.max(1000, Number.isFinite(timeoutMs) ? timeoutMs : settings.waitTimeoutMs),
      )
      const started = Date.now()
      const reports = {}
      for (;;) {
        if (signal?.aborted === true) throw new Error('cancelled by the caller')
        const status = {}
        let settled = false
        for (const target of targets) {
          const resolved = resolveWorker(state, target)
          if (resolved !== undefined) attachQuestionAnswerer(state, ctx.get('agents')?.get?.(resolved.sessionId))
          const sessionId = resolved === undefined ? target : resolved.sessionId
          const value = resolved === undefined ? 'not_found' : workerStatus(ctx, sessionId, state, settings)
          if (resolved !== undefined) {
            await rememberOutcome(settings, state, sessionId, value)
            if (typeof value !== 'string') {
              const record = resolved.record ?? [...state.workers.values()].find((candidate) => candidate.sessionId === sessionId)
              const operation = record?.operationId === undefined ? undefined : state.operations?.get(record.operationId)
              const sinceSeq = operation?.seqStart ?? Number(state.baseline.get(sessionId) ?? 0)
              reports[target] = {
                ...(operation === undefined ? {} : { operationId: operation.operationId, requestId: operation.requestId, seqStart: operation.seqStart }),
                ...(modelInWindow(ctx, sessionId, sinceSeq) === undefined ? {} : { model: modelInWindow(ctx, sessionId, sinceSeq) }),
                ...(sumUsage(ctx, sessionId, sinceSeq) === undefined ? {} : { usage: sumUsage(ctx, sessionId, sinceSeq) }),
              }
            }
          }
          status[target] = value
          /* `not_found`, `closed` and `offline` are final too: waiting cannot change them. */
          const final = value === 'not_found' || value === 'closed' || value === 'offline'
          if (typeof value !== 'string' || final) settled = true
        }
        const waitedMs = Date.now() - started
        const asked = askable(state, ctx, targets)
        if (settled) {
          return {
            status,
            timedOut: false,
            waitedMs,
            ...(asked === undefined ? {} : { pendingQuestion: asked }),
            ...(reports === undefined ? {} : { report: reports }),
          }
        }
        if (waitedMs >= budget) {
          const still = targets.filter((target) => status[target] === 'running' || status[target] === 'pending')
          return {
            status,
            timedOut: true,
            waitedMs,
            ...(asked === undefined ? {} : { pendingQuestion: asked }),
            ...(still.length === 0
              ? {}
              : {
                  running: true,
                  next:
                    asked === undefined
                      ? `still running: ${still.join(', ')}; call dsh_wait again with the same targets until none of them are "running"`
                      : `blocked on a question: answer it with dsh_answer, or call dsh_wait again`,
                }),
          }
        }
        await sleep(Math.min(300, budget - waitedMs))
      }
    },

    async answer({ worker, sessionId, answers }) {
      const target = worker === undefined ? sessionId : (resolveWorker(state, worker)?.sessionId ?? worker)
      if (typeof target !== 'string' || target === '') throw new Error('name a worker or a sessionId')
      const open = state.openQuestions?.get(target)
      if (open !== undefined) {
        /* The tool call is still blocked, so hand the batch straight to its waiter. */
        open.settle({ answers })
        return { answered: true, callId: `open:${target}`, sessionId: target }
      }
      const asked = pendingQuestion(ctx, target, state)
      if (asked === undefined) throw new Error('that worker is not waiting on a question')
      const service = ctx.get('userQuestions')
      const agent = ctx.get('agents')?.get?.(target)
      if (service === undefined || service === null || agent === undefined) {
        throw new Error('the question service is unavailable')
      }
      const accepted = service.answer(agent, asked.callId, { answers })
      return { answered: accepted === true, callId: asked.callId, sessionId: target }
    },

    async dispatch({ sessionId, text, mode }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      guardDepth(state, settings, 0, 'dsh_dispatch')
      const release = claimDispatch(sessionId)
      try {
        const existing = resolveWorker(state, sessionId)?.record
        const previous = existing === undefined ? undefined : { ...existing }
        const record = existing ?? newRecord(sessionId, '(default)')
        if (record.status === 'closed' && record.countsTowardLimit !== false) assertCapacity(state, settings, record.root ?? '(default)')
        takeDispatchSlot(state, settings)
        record.status = 'open'
        const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
        const transaction = prepareDispatch(record, before, 'dispatch', mode, previous)
        await saveWorkers(settings, state)
        if (record.status === 'closed') {
          transaction.rollback('cancelled')
          await saveWorkers(settings, state)
          throw new Error('that worker was closed before dispatch')
        }
        let result
        try {
          result = await service.prompt(
            { sessionId, requestId: transaction.operation.requestId, mode, content: [{ type: 'text', text }] },
            AbortSignal.timeout(30000),
          )
        } catch (error) { throw await transaction.unknown(error) }
        transaction.accepted(result)
        await saveWorkers(settings, state)
        return {
          accepted: result?.accepted === true, sessionId, mode, seqAtDispatch: before,
          ...operationReport(transaction.operation), ...warning(),
        }
      } finally { release() }
    },

    async readResult({ sessionId, sinceSeq, waitSeconds, signal }) {
      if (!state.dispatched.has(sessionId)) {
        throw new Error('refused: this bridge has not dispatched to that session')
      }
      sinceSeq = Math.max(Number.isFinite(sinceSeq) ? sinceSeq : 0, state.readFloor.get(sessionId) ?? state.baseline.get(sessionId) ?? 0)
      const requestedWait = waitSeconds === undefined ? settings.readWaitSeconds : waitSeconds
      const seconds = Number.isFinite(requestedWait) ? Math.max(0, requestedWait) : 0
      const budgetMs = Math.min(MAX_WAIT_SECONDS, seconds) * 1000
      const started = Date.now()
      for (;;) {
        const snapshot = readOnce(ctx, sessionId, sinceSeq, settings)
        const waitedMs = Date.now() - started
        if (snapshot.text !== '' || (!snapshot.running && Number(snapshot.lastSeq) > sinceSeq)) {
          return { ...snapshot, timedOut: false, waitedMs }
        }
        const remaining = budgetMs - waitedMs
        if (remaining <= 0) return { ...snapshot, timedOut: true, waitedMs }
        if (signal?.aborted === true) return { ...snapshot, timedOut: true, waitedMs, aborted: true }
        await sleep(Math.min(300, remaining))
      }
    },

    async dispatchClaude(args, exec) {
      const prompt = requireString(args?.prompt, 'prompt')
      const depth = guardDepth(state, settings, callerDepth(state, exec?.agent?.id), 'claude_dispatch')
      takeDispatchSlot(state, settings)
      const cwd = await resolveCwd(ctx, args?.cwd, exec)
      enterChain(state, depth, settings.claudeTimeoutMs + 5000)
      try {
        return await runClaude({
          bin: resolveClaude(settings.claudeBin),
          prompt,
          cwd,
          resume: typeof args?.resume === 'string' && args.resume !== '' ? args.resume : undefined,
          model: typeof args?.model === 'string' && args.model !== '' ? args.model : settings.claudeModel,
          timeoutMs: settings.claudeTimeoutMs,
          signal: exec?.signal,
          children: state.children,
        })
      } finally {
        leaveChain(state)
      }
    },

    async dispatchCodex(args, exec) {
      const prompt = requireString(args?.prompt, 'prompt')
      const depth = guardDepth(state, settings, callerDepth(state, exec?.agent?.id), 'codex_dispatch')
      takeDispatchSlot(state, settings)
      const cwd = await resolveCwd(ctx, args?.cwd, exec)
      enterChain(state, depth, settings.codexTimeoutMs + 5000)
      try {
        return await runCodex({
        bin: resolveCodex(settings.codexBin),
        prompt,
        cwd,
        resume: typeof args?.resume === 'string' && args.resume !== '' ? args.resume : undefined,
        sandbox: typeof args?.sandbox === 'string' ? args.sandbox : settings.codexSandbox,
        timeoutMs: settings.codexTimeoutMs,
          signal: exec?.signal,
          children: state.children,
        })
      } finally {
        leaveChain(state)
      }
    },
  }
}

/**
 * Highest turn number a session has started.
 * @param ctx - Host context.
 * @param sessionId - session to inspect.
 * @returns the turn number, or 0 when nothing has started.
 */
