export function ambientDepth(state) {
  const chain = state.chain
  if (chain === undefined || chain.active <= 0) return 0
  return Date.now() < chain.until ? chain.depth : 0
}

/**
 * Mark one outbound delegation as in flight, so anything it triggers inherits its depth.
 * @param state - bridge bookkeeping.
 * @param depth - depth of the run that is starting.
 * @param ttlMs - how long the run may last.
 */

export function enterChain(state, depth, ttlMs) {
  const chain = state.chain
  chain.active += 1
  chain.depth = Math.max(chain.depth, depth)
  chain.until = Date.now() + ttlMs
}

/**
 * Release one outbound delegation, closing the chain when the last one ends.
 * @param state - bridge bookkeeping.
 */

export function leaveChain(state) {
  const chain = state.chain
  chain.active = Math.max(0, chain.active - 1)
  if (chain.active === 0) {
    chain.depth = 0
    chain.until = 0
  }
}

/**
 * Refuse a delegation that would exceed the configured depth.
 * @param state - bridge bookkeeping.
 * @param settings - resolved settings.
 * @param callerDepth - depth of the caller, when it is known to be a worker.
 * @param action - tool name used in the message.
 * @returns the depth this delegation would create.
 */

export function guardDepth(state, settings, callerDepth, action) {
  const depth = Math.max(ambientDepth(state), callerDepth ?? 0) + 1
  if (depth > settings.maxHops) {
    throw new Error(
      `${action} would create delegation depth ${String(depth)}, but maxHops is ${String(settings.maxHops)}. ` +
        'Carry the work out directly instead of delegating again.',
    )
  }
  return depth
}

/**
 * Charge one dispatch against the rolling rate limit.
 * @param state - bridge bookkeeping.
 * @param settings - resolved settings.
 */

export function takeDispatchSlot(state, settings) {
  const now = Date.now()
  const windowMs = settings.dispatchWindowMs
  state.recent = state.recent.filter((time) => now - time < windowMs)
  if (state.recent.length >= settings.dispatchPerMinute) {
    const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - state.recent[0])) / 1000))
    throw new Error(
      `rate limit: ${String(settings.dispatchPerMinute)} dispatches per ${String(Math.round(windowMs / 1000))}s reached; retry in ${String(retrySeconds)}s`,
    )
  }
  state.recent.push(now)
}

/**
 * Depth of a session the bridge already knows: workers start one level down.
 * @param state - bridge bookkeeping.
 * @param sessionId - calling session, when known.
 * @returns 1 for a bridge worker, otherwise 0.
 */

export function callerDepth(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 0
  for (const record of state.workers.values()) {
    if (record.sessionId === sessionId) return 1
  }
  return 0
}


/**
 * Read a `provider/model` spec. A bare model name keeps the provider of the current
 * default selection, so callers can say `model: "glm-5.3"` without repeating the
 * provider they already run.
 * @param ctx - Host context.
 * @param spec - `provider/model` or a bare model id.
 * @returns {{ provider: string, model: string }} resolved pair.
 */
