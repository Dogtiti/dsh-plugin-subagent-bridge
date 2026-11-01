export function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Build a JSON-RPC success response.
 * @param id - request id.
 * @param result - result payload.
 * @returns the response.
 */

export function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build a JSON-RPC error response.
 * @param id - request id.
 * @param code - JSON-RPC error code.
 * @param message - human readable message.
 * @returns the response.
 */

export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Merge row configuration over the defaults.
 * @param config - row configuration.
 * @returns resolved settings.
 */

export function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

/**
 * Wait one short interval.
 * @param ms - milliseconds.
 * @returns a promise that settles after the interval.
 */

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Wrap a JSON value as MCP text content.
 * @param value - JSON-serializable value.
 * @returns the tool result.
 */
