import { resolveWorker } from './registry.js'
import { text } from './utils.js'

export function attachQuestionAnswerer(state, agent) {
  if (agent?.ctx === undefined || typeof agent.ctx.on !== 'function') return
  state.openQuestions ??= new Map()
  state.questionAnswerers ??= new Map()
  const sessionId = String(agent.id)
  if (state.questionAnswerers.has(sessionId)) return
  const handler = (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()
    return new Promise((resolve, reject) => {
      const waiter = {
        questions,
        settle(answer) {
          state.openQuestions.delete(sessionId)
          waiter.cleanup()
          resolve(answer)
        },
        fail(error) {
          state.openQuestions.delete(sessionId)
          waiter.cleanup()
          reject(error)
        },
      }
      const signal = request?.signal
      const onAbort = () => waiter.fail(new Error('the question was withdrawn'))
      waiter.cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      if (signal?.aborted === true) {
        waiter.fail(new Error('the question was withdrawn'))
        return
      }
      signal?.addEventListener?.('abort', onAbort)
      state.openQuestions.set(sessionId, waiter)
    })
  }
  try {
    const off = agent.ctx.on('user-questions/request', handler)
    state.questionAnswerers.set(sessionId, typeof off === 'function' ? off : () => {})
  } catch {
    /* An older Host without the waterfall: the continued-state path still works. */
  }
}

/**
 * The question a worker is currently blocked on, if any.
 * `ask_user_question` records a tool call and waits for an answer; while it waits the call
 * has no result yet, which is exactly the signal used here.
 * @param ctx - Host context.
 * @param sessionId - session to inspect.
 * @returns the pending call and its questions, or undefined.
 */

export function askable(state, ctx, targets) {
  for (const target of targets) {
    const resolved = resolveWorker(state, target)
    const sessionId = resolved === undefined ? target : resolved.sessionId
    const asked = pendingQuestion(ctx, sessionId, state)
    if (asked !== undefined) return { worker: target, ...asked }
  }
  return undefined
}

export function pendingQuestion(ctx, sessionId, state) {
  const open = state?.openQuestions?.get(sessionId)
  if (open !== undefined) {
    return {
      callId: `open:${sessionId}`,
      questions: open.questions.map((question) => ({
        id: String(question?.id ?? ''),
        question: String(question?.question ?? ''),
        ...(typeof question?.header === 'string' ? { header: question.header } : {}),
        ...(question?.multiSelect === true ? { multiSelect: true } : {}),
        ...(Array.isArray(question?.options)
          ? {
              options: question.options.map((option) => ({
                label: String(option?.label ?? ''),
                ...(typeof option?.description === 'string' ? { description: option.description } : {}),
              })),
            }
          : {}),
      })),
    }
  }
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return undefined
  const settled = new Set()
  let waiting
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/result' && typeof event.data?.callId === 'string') settled.add(event.data.callId)
    if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') waiting = event.data
  }
  if (waiting === undefined || settled.has(waiting.callId)) return undefined
  let parsed
  try {
    parsed = JSON.parse(typeof waiting.arguments === 'string' ? waiting.arguments : '{}')
  } catch {
    return undefined
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  if (questions.length === 0) return undefined
  return {
    callId: String(waiting.callId),
    questions: questions.map((question) => ({
      id: String(question?.id ?? ''),
      question: String(question?.question ?? ''),
      ...(typeof question?.header === 'string' ? { header: question.header } : {}),
      ...(question?.multi_select === true ? { multiSelect: true } : {}),
      ...(Array.isArray(question?.options)
        ? {
            options: question.options.map((option) => ({
              label: String(option?.label ?? ''),
              ...(typeof option?.description === 'string' ? { description: option.description } : {}),
            })),
          }
        : {}),
    })),
  }
}

/**
 * Sequence number of the first message the caller itself delivered after `sinceSeq`.
 * With steer the reply shares the running turn, so "the last assistant text of the turn"
 * can be a step of the original task; anchoring on our own message keeps it exact.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - sequence captured before the prompt was delivered.
 * @returns the sequence, or the original value when nothing matches.
 */
