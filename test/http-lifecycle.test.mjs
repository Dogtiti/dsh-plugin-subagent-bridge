import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createHandler, handleJsonRpc } from '../src/http.js'

const TOKEN = 'k'.repeat(32)
const toolMessage = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

function requestFor(message) {
  const request = new EventEmitter()
  Object.assign(request, { url: `/mcp/${TOKEN}`, method: 'POST', headers: {}, aborted: false })
  request[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(message)) }
  return request
}

function responseFor() {
  const response = new EventEmitter()
  Object.assign(response, { headersSent: false, writableEnded: false, destroyed: false, writes: 0 })
  response.writeHead = (status, headers) => {
    assert.equal(response.destroyed, false, 'must not write to a destroyed response')
    response.writes += 1
    response.status = status
    response.headers = headers
    response.headersSent = true
    return response
  }
  response.end = (body) => { response.body = body; response.writableEnded = true; return response }
  response.destroy = () => { response.destroyed = true; response.emit('close') }
  return response
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('malformed request target returns 400 without rejecting', async () => {
  const request = requestFor({})
  request.url = 'http://['
  const response = responseFor()
  await createHandler({}, TOKEN)(request, response)
  assert.equal(response.status, 400)
  assert.equal(response.body, 'invalid request target')
})

test('unexpected handler rejection returns a generic 500', async () => {
  const request = requestFor({})
  request.url = '/'
  Object.defineProperty(request, 'headers', { get() { throw new Error('private failure detail') } })
  const response = responseFor()
  await createHandler({}, TOKEN)(request, response)
  assert.equal(response.status, 500)
  assert.equal(response.body, 'internal server error')
})

test('failure after response headers destroys the response instead of writing twice', async () => {
  const response = responseFor()
  response.end = () => { throw new Error('write failed') }
  await createHandler({}, TOKEN)(requestFor({ id: 1, method: 'ping' }), response)
  assert.equal(response.destroyed, true)
  assert.equal(response.writes, 1)
})

for (const [tool, args, operation] of [
  ['dsh_task', { prompt: 'test' }, 'task'],
  ['dsh_wait', { targets: ['worker'] }, 'wait'],
  ['dsh_read_result', { sessionId: 'session', sinceSeq: 0 }, 'readResult'],
]) {
  test(`${tool} receives the caller signal`, async () => {
    const controller = new AbortController()
    let received
    await handleJsonRpc(toolMessage(tool, args), { [operation]: async (options) => { received = options.signal; return {} } }, { signal: controller.signal })
    assert.equal(received, controller.signal)
  })
}

for (const disconnect of ['response close', 'request aborted']) {
  test(`${disconnect} cancels a pending task and avoids writing a reply`, async () => {
    const started = deferred()
    const request = requestFor(toolMessage('dsh_task', { prompt: 'test' }))
    const response = responseFor()
    let signal
    const api = { task: async (options) => {
      signal = options.signal
      started.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {}
    } }
    const pending = createHandler(api, TOKEN)(request, response)
    await started.promise
    if (disconnect === 'response close') response.destroy()
    else { request.aborted = true; request.emit('aborted') }
    await pending
    assert.equal(signal.aborted, true)
    assert.equal(response.writes, 0)
    assert.equal(request.listenerCount('aborted'), 0)
    assert.equal(response.listenerCount('close'), 0)
  })
}

test('normal request close does not cancel a running task; listeners are cleaned up', async () => {
  const started = deferred()
  const finish = deferred()
  const request = requestFor(toolMessage('dsh_task', { prompt: 'test' }))
  const response = responseFor()
  let signal
  const pending = createHandler({ task: async (options) => {
    signal = options.signal
    started.resolve()
    await finish.promise
    return { answer: 'done' }
  } }, TOKEN)(request, response)
  await started.promise
  request.emit('close')
  assert.equal(signal.aborted, false)
  finish.resolve()
  await pending
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).result.isError, undefined)
  assert.equal(request.listenerCount('aborted'), 0)
  assert.equal(response.listenerCount('close'), 0)
  response.emit('close')
  assert.equal(signal.aborted, false)
})

for (const disconnected of ['request', 'response']) {
  test(`already disconnected ${disconnected} does not start a task`, async () => {
    const request = requestFor(toolMessage('dsh_task', { prompt: 'test' }))
    const response = responseFor()
    if (disconnected === 'request') request.aborted = true
    else response.destroyed = true
    let called = false
    await createHandler({ task: async () => { called = true } }, TOKEN)(request, response)
    assert.equal(called, false)
    assert.equal(response.writes, 0)
    assert.equal(request.listenerCount('aborted'), 0)
    assert.equal(response.listenerCount('close'), 0)
  })
}
