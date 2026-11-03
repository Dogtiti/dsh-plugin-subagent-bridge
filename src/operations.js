/**
 * Per-dispatch operation records.
 *
 * One session can serve several dispatches (followup, steer, parallel workers), so a single
 * per-session baseline cannot say which turn produced which answer. Each dispatch gets its
 * own record instead: an operation id the caller can quote, the request id the Host saw, and
 * the sequence window the answer was collected from.
 *
 * @module @deepseek-ai/dsh-plugin-subagent-bridge/operations
 */

/** How many operations to keep in memory before dropping the oldest. */
export const MAX_OPERATIONS = 200

/**
 * Open an operation record.
 * @param state - bridge state; the map is created on demand.
 * @param input - session, request id, delivery mode and the sequence window start.
 * @returns the record, also stored in `state.operations`.
 */
export function beginOperation(state, input) {
  state.operations ??= new Map()
  const operation = {
    operationId: `op-${String((state.operationCounter = (state.operationCounter ?? 0) + 1))}`,
    requestId: input.requestId,
    sessionId: input.sessionId,
    kind: input.kind,
    mode: input.mode,
    seqStart: input.seqStart,
    startedAt: Date.now(),
  }
  state.operations.set(operation.operationId, operation)
  if (state.operations.size > MAX_OPERATIONS) {
    const oldest = [...state.operations.values()].sort((left, right) => left.startedAt - right.startedAt)[0]
    if (oldest !== undefined) state.operations.delete(oldest.operationId)
  }
  return operation
}

/**
 * Close an operation record with what the run produced.
 * @param operation - record from {@link beginOperation}.
 * @param result - end sequence, terminal status, answer text, model and usage.
 * @returns the same record.
 */
export function finishOperation(operation, result) {
  operation.seqEnd = result.seqEnd
  operation.status = result.status
  operation.endedAt = Date.now()
  operation.durationMs = operation.endedAt - operation.startedAt
  if (typeof result.text === 'string') operation.text = result.text
  if (result.model !== undefined) operation.model = result.model
  if (result.usage !== undefined) operation.usage = result.usage
  return operation
}

/**
 * Sum the token usage the session reported inside a sequence window.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param fromSeq - first sequence to include (exclusive).
 * @param toSeq - last sequence to include, when known.
 * @returns `{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }`
 *   with only the counters the provider actually reported, or undefined when none did.
 */
export function sumUsage(ctx, sessionId, fromSeq, toSeq) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return undefined
  const total = {}
  let seen = false
  for (const event of session.snapshotEvents()) {
    const seq = Number(event.seq)
    if (seq <= fromSeq) continue
    if (toSeq !== undefined && seq > toSeq) continue
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      total[key] = (total[key] ?? 0) + value
      seen = true
    }
  }
  return seen ? total : undefined
}

/**
 * The provider and model the session actually used inside a window.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param fromSeq - first sequence to include (exclusive).
 * @returns `{ provider, model }`, or undefined when the session never recorded one.
 */
export function modelInWindow(ctx, sessionId, fromSeq) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return undefined
  let found
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= fromSeq) continue
    if (event.type !== 'request/context') continue
    const provider = event.data?.provider
    const model = event.data?.model
    if (typeof provider === 'string' && typeof model === 'string') found = { provider, model }
  }
  return found
}

/**
 * Public shape of one operation, as tools report it.
 * @param operation - record from {@link beginOperation}.
 * @returns the JSON-safe subset.
 */
export function operationReport(operation) {
  if (operation === undefined) return undefined
  return {
    operationId: operation.operationId,
    requestId: operation.requestId,
    seqStart: operation.seqStart,
    ...(operation.seqEnd === undefined ? {} : { seqEnd: operation.seqEnd }),
    ...(operation.durationMs === undefined ? {} : { durationMs: operation.durationMs }),
    ...(operation.model === undefined ? {} : { model: operation.model }),
    ...(operation.usage === undefined ? {} : { usage: operation.usage }),
  }
}
