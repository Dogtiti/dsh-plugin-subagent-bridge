import { mkdir } from 'node:fs/promises'
import { ok, text } from './utils.js'

export function lastTurn(ctx, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return 0
  let turn = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start' && Number(event.data?.turn) > turn) turn = Number(event.data.turn)
  }
  return turn
}

/**
 * Resolve when the session finishes the turn that this dispatch starts.
 * Subscribes before the prompt so a fast turn cannot be missed.
 * @param ctx - Host context.
 * @param sessionId - session to watch.
 * @param afterTurn - ignore turns at or below this number.
 * @param timeoutMs - bounded wait.
 * @returns the `turn/end` payload, or undefined on timeout.
 */

export function waitForTurnEnd(ctx, sessionId, afterTurn, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    let off = () => {}
    const abort = () => finish(undefined)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    off = ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event?.type !== 'turn/end') return
      if (Number(event.data?.turn) <= afterTurn) return
      finish(event.data)
    }) ?? (() => {})
    if (settled) return off()
    timer = setTimeout(() => finish(undefined), Math.max(1000, timeoutMs))
    if (signal?.aborted) finish(undefined)
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Collect assistant text produced after a sequence number.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - only count messages after this sequence.
 * @param settings - resolved settings.
 * @returns the joined text and whether it was trimmed.
 */

export function collectAssistant(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return { text: '', truncated: false }
  const texts = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type !== 'assistant/message') continue
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const value = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (value !== '') texts.push(value)
  }
  const joined = texts.join('\n\n')
  return {
    text: joined.length > settings.maxResultChars ? joined.slice(-settings.maxResultChars) : joined,
    truncated: joined.length > settings.maxResultChars,
  }
}


/** Deepest cross-tool delegation currently in flight, or 0 when no chain is open. */

export function firstDeliveredMessageSeq(ctx, sessionId, sinceSeq) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return sinceSeq
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type !== 'user/message') continue
    return Number(event.seq)
  }
  return sinceSeq
}

/**
 * Start the bridge.
 * @param ctx - Host context.
 * @param config - row configuration from the bundle patch.
 */

export function parseModelSpec(ctx, spec) {
  const raw = String(spec).trim()
  if (raw === '') throw new Error('model must not be empty')
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('//')) {
    throw new Error(`model must look like "provider/model", got ${JSON.stringify(spec)}`)
  }
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const provider = raw.slice(0, slash).trim()
    const model = raw.slice(slash + 1).trim()
    if (provider === '' || model === '') throw new Error(`model must look like "provider/model", got ${JSON.stringify(spec)}`)
    return { provider, model }
  }
  const current = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = typeof current?.provider === 'string' ? current.provider : ''
  if (provider === '') throw new Error('model without a provider needs a default selection; pass "provider/model"')
  return { provider, model: raw }
}

/**
 * Install a model selection on one session before its next turn.
 * `sessionController.selectModel` validates the pair and applies it to the next request.
 * @param ctx - Host context.
 * @param sessionId - session to switch.
 * @param spec - `provider/model` or a bare model id.
 * @param reasoningEffort - optional effort level.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} applied selection.
 */

export async function applyModelSpec(ctx, sessionId, spec, reasoningEffort) {
  if (typeof spec !== 'string' || spec.trim() === '') return undefined
  const service = ctx.get('sessionController')
  if (service === undefined || service === null) throw new Error('session controller is unavailable')
  if (typeof service.selectModel !== 'function') throw new Error('this Host does not expose selectModel; update DeepSeek Harness')
  const { provider, model } = parseModelSpec(ctx, spec)
  try {
    const result = await service.selectModel({
      sessionId,
      provider,
      model,
      ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
    })
    return result?.selected ?? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  } catch (error) {
    throw new Error(`cannot switch ${String(sessionId)} to ${provider}/${model}: ${String(error?.message ?? error)}`)
  }
}

/**
 * Translate the `workspace` argument into attach options.
 * - absent / `false` → never create, only reuse an existing project for the directory
 * - `true` → create a project titled after the directory when none owns it
 * - a string → same, with that title
 * @param workspace - raw argument from the tool call.
 * @returns options for {@link attachToWorkspace}.
 */

export function workspaceOptions(workspace) {
  if (workspace === true) return { create: true }
  if (typeof workspace === 'string' && workspace.trim() !== '') return { create: true, title: workspace.trim() }
  return {}
}

/**
 * Place a freshly created session in the workspace its directory belongs to.
 * `sessionController.create` only records a working directory; the sidebar groups
 * live in a separate registry, so without this step a worker shows up as ungrouped.
 * @param ctx - Host context.
 * @param sessionId - session just created.
 * @param cwd - directory the session was opened in.
 */

export async function attachToWorkspace(ctx, sessionId, cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || registry === null) return undefined

    /* Only create when the caller asked for it: an existing project is reused either way,
     * because `create` returns the record that already owns the canonical path. */
    let workspace
    if (options.create === true && typeof registry.create === 'function') {
      /* The registry rejects a directory that does not exist yet, and a brand-new project
       * is exactly that, so the path is materialised first. */
      await mkdir(cwd, { recursive: true }).catch(() => {})
      const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : undefined
      workspace = await registry.create(cwd, title)
    } else {
      workspace = await registry.resolveByPath?.(cwd)
    }

    await workspace?.attachSession?.(sessionId)
    return workspace === undefined || workspace === null
      ? undefined
      : { id: workspace.id, title: workspace.title, path: workspace.path }
  } catch {
    /* Grouping is cosmetic: a failure here must not fail the dispatch. */
    return undefined
  }
}


/**
 * Restore the worker registry written by a previous process.
 * @param settings - resolved settings.
 * @param state - worker bookkeeping to fill.
 */

export function finalAnswer(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return { text: '', truncated: false }
  let last = ''
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type !== 'assistant/message') continue
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const value = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (value !== '') last = value
  }
  if (last.length <= settings.maxResultChars) return { text: last, truncated: false }
  /* Keep the head: a conclusion states its verdict first. */
  return { text: `${last.slice(0, settings.maxResultChars)}\n\n…`, truncated: true }
}

/**
 * Describe one worker the way `wait_agent` does: a string state, or its final answer.
 * @param ctx - Host context.
 * @param sessionId - worker session.
 * @param state - dispatch bookkeeping.
 * @param settings - resolved settings.
 * @returns 'not_found' | 'running' | 'pending' | { completed } | { errored }.
 */

export function workerStatus(ctx, sessionId, state, settings) {
  if (!state.dispatched.has(sessionId)) return 'not_found'
  let record
  for (const candidate of state.workers.values()) {
    if (candidate.sessionId === sessionId) record = candidate
  }
  if (record?.status === 'closed') return 'closed'
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) {
    /* After a restart the session is cold; a cached terminal outcome is still valid. */
    if (record?.outcome !== undefined) return record.outcome
    return 'offline'
  }
  if (ctx.get('agents')?.get?.(sessionId)?.status === 'running') return 'running'
  const since = Number(state.baseline.get(sessionId) ?? 0)
  const end = lastTurnEnd(session, since)
  if (end === undefined) return 'pending'
  const reason = end.reason?.kind ?? 'unknown'
  if (reason !== 'completed') return { errored: String(reason) }
  const answer = finalAnswer(ctx, sessionId, since, settings)
  return { completed: answer.text }
}

/**
 * Latest `turn/end` after a sequence, with its reason.
 * @param session - live session.
 * @param sinceSeq - only consider turns that ended after this event.
 * @returns the payload, or undefined when the turn has not ended yet.
 */

export function lastTurnEnd(session, sinceSeq) {
  let found
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type === 'turn/end') found = event.data
  }
  return found
}

/**
 * Read one session snapshot without waiting.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - only count assistant messages after this sequence.
 * @param settings - resolved settings.
 * @returns text, run state, and the session head sequence.
 */

export function readOnce(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) throw new Error(`session ${sessionId} is not live`)
  const collected = collectAssistant(ctx, sessionId, sinceSeq, settings)
  return {
    sessionId,
    running: ctx.get('agents')?.get?.(sessionId)?.status === 'running',
    lastSeq: Number(session.seq ?? 0),
    truncated: collected.truncated,
    text: collected.text,
  }
}

/**
 * Resolve the directory Codex should run in.
 * @param ctx - Host context.
 * @param requested - explicit `cwd` argument.
 * @param exec - tool run context.
 * @returns the absolute directory.
 */

export async function resolveCwd(ctx, requested, exec) {
  if (typeof requested === 'string' && requested !== '') return requested
  const session = exec?.agent === undefined ? undefined : ctx.get('sessions')?.get?.(exec.agent.id)
  const working = ctx.get('workingDirectory')
  if (session !== undefined && session !== null && working !== undefined) {
    try {
      return working.get(session) ?? process.cwd()
    } catch {
      /* Fall through to the process directory. */
    }
  }
  return process.cwd()
}

/**
 * Run one `codex exec` and collect its answer.
 * @param options - binary, prompt, directory, sandbox, timeout, and cancellation.
 * @returns `{ ok, text, threadId, exitCode, durationMs, error? }`.
 */

export function safeTitle(service, session) {
  try {
    const snapshot = service?.get?.(session)
    return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : undefined
  } catch {
    return undefined
  }
}

/**
 * Accept a request only when it carries the capability token in the path or as a bearer.
 * @param request - node request.
 * @param url - parsed request URL.
 * @param token - expected token.
 * @returns whether the request may proceed.
 */
