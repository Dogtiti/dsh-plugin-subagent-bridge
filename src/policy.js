import { ASSUMPTION_POLICY } from './constants.js'

export function withAssumptionPolicy(settings, message) {
  if (settings.assumeDefaults !== true) return message
  if (message.includes('ask_user_question')) return message
  const custom = typeof settings.assumptionPolicy === 'string' ? settings.assumptionPolicy.trim() : ''
  const policy = custom === '' ? ASSUMPTION_POLICY : custom
  return `${message}\n\n（${policy}）`
}

/**
 * Take over the questions a worker asks, so the calling agent can answer them.
 *
 * `ask_user_question` pauses the tool call until something answers on the
 * `user-questions/request` waterfall. The Web UI answers from the browser; for a worker
 * nobody is watching, the bridge answers instead and forwards the question to its caller.
 * @param state - bridge state.
 * @param agent - live agent of the worker session.
 */
