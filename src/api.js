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
  state.workers = state.workers ?? new Map()
  state.chain = state.chain ?? { depth: 0, active: 0, until: 0 }
  state.recent = state.recent ?? []
  const controller = () => ctx.get('sessionController')
  const sessions = () => ctx.get('sessions')

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
      /* Older callers build a minimal state object; keep the reservation map optional. */
      state.reserved ??= new Map()
      if (state.workers.has(taskName) || state.reserved.has(taskName)) {
        throw new Error(`task_name ${JSON.stringify(taskName)} is already in use`)
      }
      const root = typeof cwd === 'string' && cwd !== '' ? cwd : forkTurns === 'all' ? `fork:${String(from)}` : '(default)'
      guardDepth(state, settings, 0, 'dsh_spawn')
      /* Everything from here to the registry write awaits, so claim the name and the slot
       * synchronously: two concurrent spawns must not both clear the checks above. */
      state.reserved.set(taskName, root)
      try {
        assertCapacity(state, settings, root, taskName)
        takeDispatchSlot(state, settings)

        let placed
        let sessionId
        if (forkTurns === 'all') {
          const parent = sessions()?.get?.(from)
          if (parent === undefined || parent === null) {
            /* Forking a cold session is fine: the controller reads it from storage. */
          }
          const forked = await service.fork({ sessionId: from })
          sessionId = forked?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('forking returned no session id')
        } else {
          const opened = await service.create(cwd === undefined ? {} : { cwd })
          sessionId = opened?.sessionId
          if (typeof sessionId === 'string' && sessionId !== '') {
            placed = await attachToWorkspace(ctx, sessionId, cwd ?? undefined, workspaceOptions(workspace))
          }
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session controller did not return a session id')
        }

        const appliedModel = await applyModelSpec(ctx, sessionId, model, reasoningEffort)
        attachQuestionAnswerer(state, ctx.get('agents')?.get?.(sessionId))
        const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
        const requestId = randomUUID()
        const accepted = await service.prompt(
          { sessionId, requestId, mode: mode === 'steer' ? 'steer' : 'queue', content: [{ type: 'text', text: withAssumptionPolicy(settings, message) }] },
          AbortSignal.timeout(30000),
        )
        state.dispatched.add(sessionId)
        state.baseline.set(sessionId, before)
        const spawnedOperation = beginOperation(state, {
          sessionId,
          requestId,
          kind: 'spawn',
          mode: mode === 'steer' ? 'steer' : 'queue',
          seqStart: before,
        })
        finishOperation(spawnedOperation, { status: 'accepted' })
        state.workers.set(taskName, {
          taskName,
          sessionId,
          status: 'open',
          countsTowardLimit: true,
          root,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await saveWorkers(settings, state)
        return {
          task_name: taskName,
          sessionId,
          accepted: accepted?.accepted === true,
          fork_turns: forkTurns,
          ...(appliedModel === undefined ? {} : { model: appliedModel }),
          ...(placed === undefined ? {} : { workspace: placed }),
          operationId: spawnedOperation.operationId,
          requestId,
          seqStart: before,
        }
      } finally {
        /* Released on success too: the worker record now holds the slot. */
        state.reserved.delete(taskName)
      }
    },

    async followup({ worker, message, model, reasoningEffort, mode }) {
      const target = resolveWorker(state, worker)
      if (target === undefined) throw new Error(`unknown worker ${JSON.stringify(worker)}`)
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      /* A closed worker keeps its session, so reopening is useful — but it has to pay for a
       * slot again, otherwise "closed" would be a way to run work outside the budget. */
      if (target.record?.status === 'closed') {
        state.reserved ??= new Map()
        const reservation = target.record.taskName ?? target.sessionId
        const root = target.record.root ?? '(default)'
        state.reserved.set(reservation, root)
        try {
          assertCapacity(state, settings, root, reservation)
        } finally {
          state.reserved.delete(reservation)
        }
        target.record.status = 'open'
      }
      takeDispatchSlot(state, settings)
      const appliedModel = await applyModelSpec(ctx, target.sessionId, model, reasoningEffort)
      const before = Number(sessions()?.get?.(target.sessionId)?.seq ?? 0)
      const requestId = randomUUID()
      const accepted = await service.prompt(
        { sessionId: target.sessionId, requestId, mode: mode === 'steer' ? 'steer' : 'queue', content: [{ type: 'text', text: withAssumptionPolicy(settings, message) }] },
        AbortSignal.timeout(30000),
      )
      state.baseline.set(target.sessionId, before)
      const operation = beginOperation(state, {
        sessionId: target.sessionId,
        requestId,
        kind: 'followup',
        mode: mode === 'steer' ? 'steer' : 'queue',
        seqStart: before,
      })
      finishOperation(operation, { status: 'accepted' })
      const report = { operationId: operation.operationId, requestId, seqStart: before }
      if (target.record !== undefined) {
        /* A new turn invalidates the cached answer. */
        delete target.record.outcome
        target.record.updatedAt = Date.now()
        target.record.operationId = operation.operationId
      }
      await saveWorkers(settings, state)
      return {
        worker: target.taskName ?? target.sessionId,
        sessionId: target.sessionId,
        accepted: accepted?.accepted === true,
        ...(appliedModel === undefined ? {} : { model: appliedModel }),
        ...report,
      }
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
        rows.push({ task_name: record.taskName, sessionId: record.sessionId, root: record.root ?? '(default)', status })
      }
      return rows
    },

    async task({ prompt, cwd, sessionId, agentPreset, timeoutSeconds, model, reasoningEffort, workspace, mode }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      const seconds = Math.min(
        MAX_BLOCKING_SECONDS,
        Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : settings.taskTimeoutSeconds),
      )
      guardDepth(state, settings, 0, 'dsh_task')
      takeDispatchSlot(state, settings)
      const started = Date.now()

      let placed
      let targetId = sessionId
      let created = false
      if (targetId === undefined) {
        const opened = await service.create(cwd === undefined ? {} : { cwd })
        targetId = opened?.sessionId
        if (typeof targetId === 'string' && targetId !== '') {
          placed = await attachToWorkspace(ctx, targetId, cwd ?? undefined, workspaceOptions(workspace))
        }
        if (typeof targetId !== 'string' || targetId === '') throw new Error('session controller did not return a session id')
        created = true
      } else if (mode !== 'steer' && ctx.get('agents')?.get?.(targetId)?.status === 'running') {
        /* Steering exists precisely to reach a running session; queueing into one would
         * silently wait for a turn this call is not tracking. */
        throw new Error('that session is running; pass mode:"steer" to insert into that turn, or use dsh_dispatch plus dsh_read_result')
      }

      const appliedModel = await applyModelSpec(ctx, targetId, model, reasoningEffort)
      /* DSH delivers a prompt either queued behind the running turn or steered into it. */
      const deliveryMode = mode === 'steer' ? 'steer' : 'queue'
      attachQuestionAnswerer(state, ctx.get('agents')?.get?.(targetId))
      const turnBefore = lastTurn(ctx, targetId)
      /* A steered message is absorbed by the turn that is already running, so waiting for
       * a strictly newer turn would hang until the timeout even after the answer landed. */
      const waitAfter = deliveryMode === 'steer' ? Math.max(0, turnBefore - 1) : turnBefore
      const before = Number(sessions()?.get?.(targetId)?.seq ?? 0)
      const finished = waitForTurnEnd(ctx, targetId, waitAfter, seconds * 1000)
      const requestId = randomUUID()
      const operation = beginOperation(state, {
        sessionId: targetId,
        requestId,
        kind: created ? 'task' : 'task-continue',
        mode: deliveryMode,
        seqStart: before,
      })
      const accepted = await service.prompt(
        { sessionId: targetId, requestId, mode: deliveryMode, content: [{ type: 'text', text: withAssumptionPolicy(settings, prompt) }] },
        AbortSignal.timeout(30000),
      )
      state.dispatched.add(targetId)
      state.baseline.set(targetId, before)
      /* A blocking task is not a spawned worker: it is recorded for later lookup but
       * must not consume one of the concurrency slots. */
      const implicitName = `task_${targetId.slice('session-'.length, 'session-'.length + 8)}`
      if (!state.workers.has(implicitName)) {
        state.workers.set(implicitName, {
          taskName: implicitName,
          sessionId: targetId,
          status: 'open',
          countsTowardLimit: false,
          root: typeof cwd === 'string' && cwd !== '' ? cwd : '(default)',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await saveWorkers(settings, state)
      }

      const end = await finished
      /* A steered reply lives inside the turn that was already running, so anchor the
       * answer on the message we delivered instead of the turn's last assistant text. */
      const answerFrom = deliveryMode === 'steer' ? firstDeliveredMessageSeq(ctx, targetId, before) : before
      const collected = finalAnswer(ctx, targetId, answerFrom, settings)
      const turnReason = end?.reason?.kind ?? null
      const durationMs = Date.now() - started
      const status = end === undefined ? 'timeout' : turnReason === 'completed' ? 'completed' : `turn-${String(turnReason)}`
      return {
        sessionId: targetId,
        created,
        status,
        /* A timeout means "still running": say so, and say what to call next. */
        ...(status === 'timeout'
          ? {
              running: true,
              next: `the worker is still running; do not end the turn. Call dsh_wait({targets:["${targetId}"],timeoutMs:${String(MAX_BLOCKING_SECONDS * 1000)}}) and repeat until it is not "running".`,
            }
          : {}),
        /* The operation report comes first so the caller's explicit model selection keeps its
         * established shape below. */
        ...operationReport(finishOperation(operation, {
          status,
          seqEnd: Number(sessions()?.get?.(targetId)?.seq ?? 0),
          text: collected.text,
          model: modelInWindow(ctx, targetId, before),
          usage: sumUsage(ctx, targetId, before),
        })),
        ...(appliedModel === undefined ? {} : { model: appliedModel }),
        ...(placed === undefined ? {} : { workspace: placed }),
        mode: deliveryMode,
        text: collected.text,
        truncated: collected.truncated,
        turns: lastTurn(ctx, targetId),
        accepted: accepted?.accepted === true,
        durationMs,
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
      takeDispatchSlot(state, settings)
      const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
      const requestId = randomUUID()
      const result = await service.prompt(
        { sessionId, requestId, mode, content: [{ type: 'text', text }] },
        AbortSignal.timeout(30000),
      )
      state.dispatched.add(sessionId)
      state.baseline.set(sessionId, before)
      const operation = beginOperation(state, { sessionId, requestId, kind: 'dispatch', mode, seqStart: before })
      finishOperation(operation, { status: 'accepted' })
      return {
        accepted: result?.accepted === true,
        sessionId,
        requestId,
        mode,
        seqAtDispatch: before,
        operationId: operation.operationId,
      }
    },

    async readResult({ sessionId, sinceSeq, waitSeconds, signal }) {
      if (!state.dispatched.has(sessionId)) {
        throw new Error('refused: this bridge has not dispatched to that session')
      }
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
