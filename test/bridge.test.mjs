import assert from 'node:assert/strict'
import test from 'node:test'

import { EventEmitter } from 'node:events'

import { createApi, createBridgeServer, handleJsonRpc, parseCodexOutput, resolveCodex, runCodex } from '../index.js'

const SESSION_ID = 'session-test'
const TOKEN = 'k'.repeat(32)

/**
 * Build a Host context stand-in with one scripted session.
 * @param options - scripted prompt behaviour.
 * @returns `{ ctx, calls }`.
 */
function fakeHost(options = {}) {
  const calls = { prompt: [], list: 0 }
  const events = [
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '早先的回复' }] } } },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '派活之后的回复' }] } } },
    { seq: 13, type: 'tool/call', data: {} },
  ]
  const state = { running: true }
  const session = { seq: 10, snapshotEvents: () => events }
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          list: async () => {
            calls.list += 1
            return {
              items: [
                { sessionId: SESSION_ID, cwd: '/tmp', running: true, blank: false, updatedAt: 1792670000, projections: { secret: 'history' } },
                { sessionId: 'session-cold', running: false, blank: true, updatedAt: 1792660000 },
              ],
            }
          },
          prompt: async (request, signal) => {
            calls.prompt.push({ request, hasSignal: signal instanceof AbortSignal })
            if (options.reject === true) throw new Error('agent is unavailable')
            session.seq = 13
            return { accepted: true }
          },
        }
      }
      if (name === 'sessions') return { get: (id) => (id === SESSION_ID ? session : undefined) }
      if (name === 'sessionTitle') return { get: () => ({ title: '演示会话' }) }
      if (name === 'agents') return { get: (id) => (id === SESSION_ID ? { status: state.running ? 'running' : 'idle' } : undefined) }
      return undefined
    },
  }
  return { ctx, calls, events, state, session }
}

/**
 * Build the api under test.
 * @param options - scripted host behaviour.
 * @returns the api plus its context and recorded calls.
 */
function apiUnderTest(options = {}) {
  const state = { dispatched: new Set() }
  const host = fakeHost(options)
  const api = createApi(host.ctx, state, { maxResultChars: 100 })
  return { api, ...host }
}

test('reports the MCP handshake for a supported version', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, api)
  assert.equal(reply.result.protocolVersion, '2025-03-26')
  assert.equal(reply.result.serverInfo.name, 'dsh-subagent-bridge')
  assert.deepEqual(reply.result.capabilities.tools, { listChanged: false })
})

test('falls back to the newest version it knows', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, api)
  assert.equal(reply.result.protocolVersion, '2025-06-18')
})

test('answers notifications with nothing', async () => {
  const { api } = apiUnderTest()
  assert.equal(await handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, api), null)
})

test('lists the bridge tools', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, api)
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), ['dsh_task', 'dsh_spawn', 'dsh_followup', 'dsh_close', 'dsh_list_workers', 'dsh_dispatch', 'dsh_wait', 'dsh_read_result', 'dsh_list_sessions'])
  assert.deepEqual(reply.result.tools[0].inputSchema.required, ['prompt'])
  assert.match(reply.result.tools[0].description, /subagent/)
})

test('rejects an unknown method', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, api)
  assert.equal(reply.error.code, -32601)
})

test('rejects an unknown tool inside the tool result', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, api)
  assert.equal(reply.error.code, -32602)
})

test('reports missing arguments as a tool error, not a protocol error', async () => {
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dsh_dispatch', arguments: { sessionId: SESSION_ID } } }, api)
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /text must be a non-empty string/)
})

test('lists session metadata without message content', async () => {
  const { api, calls } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'dsh_list_sessions', arguments: {} } }, api)
  const items = JSON.parse(reply.result.content[0].text)
  assert.equal(calls.list, 1)
  assert.deepEqual(items[0], { sessionId: SESSION_ID, title: '演示会话', cwd: '/tmp', running: true, blank: false, updatedAt: 1792670000 })
  assert.equal(JSON.stringify(items).includes('history'), false)
})

test('dispatches a prompt through the session controller', async () => {
  const { api, calls } = apiUnderTest()
  const result = await api.dispatch({ sessionId: SESSION_ID, text: '把它交给 DSH', mode: 'queue' })
  assert.equal(result.accepted, true)
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.seqAtDispatch, 10)
  assert.match(result.requestId, /^[0-9a-f-]{36}$/)
  const [{ request, hasSignal }] = calls.prompt
  assert.equal(hasSignal, true)
  assert.deepEqual(request.content, [{ type: 'text', text: '把它交给 DSH' }])
  assert.equal(request.mode, 'queue')
})

test('surfaces a refused dispatch', async () => {
  const { api } = apiUnderTest({ reject: true })
  await assert.rejects(() => api.dispatch({ sessionId: SESSION_ID, text: 'x', mode: 'queue' }), /agent is unavailable/)
})

test('reads only assistant text produced after the dispatch', async () => {
  const { api } = apiUnderTest()
  const dispatched = await api.dispatch({ sessionId: SESSION_ID, text: 'go', mode: 'queue' })
  const result = await api.readResult({ sessionId: SESSION_ID, sinceSeq: dispatched.seqAtDispatch })
  assert.deepEqual(result.text, '派活之后的回复')
  assert.equal(result.lastSeq, 13)
})

test('refuses to read a session it never dispatched to', async () => {
  const { api } = apiUnderTest()
  await assert.rejects(() => api.readResult({ sessionId: SESSION_ID, sinceSeq: 0 }), /has not dispatched/)
})

test('serves JSON-RPC over HTTP with the capability token', async () => {
  const { api } = apiUnderTest()
  const bridge = createBridgeServer({ api, token: TOKEN, port: 0 })
  await bridge.listen()
  try {
    const unauthorized = await fetch(bridge.url.replace(TOKEN, 'x'.repeat(32)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(unauthorized.status, 404)

    const listed = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(listed.status, 200)
    const reply = await listed.json()
    assert.equal(reply.result.tools.length, 9)

    const notification = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(notification.status, 202)

    const viaBearer = await fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    })
    assert.deepEqual((await viaBearer.json()).result, {})

    const get = await fetch(bridge.url)
    assert.equal(get.status, 405)
  } finally {
    await bridge.close()
  }
})

test('long-polls for late text and returns as soon as it lands', async () => {
  const state = { dispatched: new Set() }
  const host = fakeHost()
  host.events.length = 0
  const api = createApi(host.ctx, state, { maxResultChars: 100, readWaitSeconds: 5 })
  await api.dispatch({ sessionId: SESSION_ID, text: 'go', mode: 'queue' })
  setTimeout(() => {
    host.events.push({ seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '晚到的回复' }] } } })
    host.session.seq = 14
    host.state.running = false
  }, 120)
  const started = Date.now()
  const result = await api.readResult({ sessionId: SESSION_ID, sinceSeq: 10, waitSeconds: 5 })
  assert.equal(result.text, '晚到的回复')
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - started < 3000)
})

test('gives up when the wait expires with nothing new', async () => {
  const state = { dispatched: new Set() }
  const host = fakeHost()
  host.events.length = 0
  const api = createApi(host.ctx, state, { maxResultChars: 100, readWaitSeconds: 5 })
  await api.dispatch({ sessionId: SESSION_ID, text: 'go', mode: 'queue' })
  const started = Date.now()
  const result = await api.readResult({ sessionId: SESSION_ID, sinceSeq: 10, waitSeconds: 0.4 })
  assert.equal(result.text, '')
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started >= 350)
})

test('stops waiting when the caller cancels', async () => {
  const state = { dispatched: new Set() }
  const host = fakeHost()
  host.events.length = 0
  const api = createApi(host.ctx, state, { maxResultChars: 100, readWaitSeconds: 5 })
  await api.dispatch({ sessionId: SESSION_ID, text: 'go', mode: 'queue' })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await api.readResult({ sessionId: SESSION_ID, sinceSeq: 10, waitSeconds: 5, signal: controller.signal })
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, true)
})

test('parses the codex event stream and prefers the last-message file', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"01a163a2-3f0b-7882-8af9-1d9a60e1baff"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":26102,"output_tokens":5}}',
  ].join('\n')
  assert.deepEqual(parseCodexOutput(stdout, undefined), { text: 'OK', threadId: '01a163a2-3f0b-7882-8af9-1d9a60e1baff' })
  assert.deepEqual(parseCodexOutput(stdout, '最终答案\n').text, '最终答案')
  assert.equal(parseCodexOutput('{"type":"turn.failed","error":{"message":"boom"}}', undefined).error, 'boom')
})

test('resolves an explicit codex path and rejects a missing one', () => {
  assert.equal(resolveCodex(process.execPath), process.execPath)
  assert.equal(resolveCodex('/definitely/not/here/codex'), undefined)
})

/**
 * Build one fake child process.
 * @param options - emitted lines, exit code, and whether it ever closes.
 * @returns an EventEmitter shaped like a child process.
 */
function fakeChild({ lines = [], code = 0, close = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    if (close) child.emit('close', null)
  }
  if (close) {
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`))
      child.emit('close', code)
    })
  }
  return child
}

test('runs codex and returns its answer', async () => {
  const result = await runCodex({
    bin: '/fake/codex',
    prompt: 'hi',
    cwd: '/tmp',
    sandbox: 'read-only',
    timeoutMs: 5000,
    spawnImpl: () =>
      fakeChild({
        lines: [
          '{"type":"thread.started","thread_id":"t-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"答案在这里"}}',
        ],
      }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, '答案在这里')
  assert.equal(result.threadId, 't-1')
  assert.equal(result.exitCode, 0)
})

test('reports a failing codex run', async () => {
  const result = await runCodex({
    bin: '/fake/codex',
    prompt: 'hi',
    sandbox: 'read-only',
    timeoutMs: 5000,
    spawnImpl: () => fakeChild({ lines: [], code: 2 }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /codex exited with 2/)
})

test('kills codex when the run times out', async () => {
  const child = fakeChild({ close: false })
  const result = await runCodex({
    bin: '/fake/codex',
    prompt: 'slow',
    sandbox: 'read-only',
    timeoutMs: 1000,
    spawnImpl: () => child,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/)
  assert.equal(child.killed, true)
})

test('a resumed run returns lossless JSON even without a thread id', async () => {
  const result = await runCodex({
    bin: '/fake/codex',
    prompt: 'again',
    resume: 't-1',
    sandbox: 'read-only',
    timeoutMs: 5000,
    spawnImpl: () =>
      fakeChild({
        lines: [
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"续上了"}}',
        ],
      }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, '续上了')
  assert.equal('threadId' in result, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('resume omits the flags its subcommand rejects', async () => {
  let recorded
  await runCodex({
    bin: '/fake/codex',
    prompt: 'again',
    cwd: '/tmp',
    resume: 't-1',
    sandbox: 'read-only',
    timeoutMs: 5000,
    spawnImpl: (_bin, args) => {
      recorded = args
      return fakeChild({ lines: ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'] })
    },
  })
  assert.equal(recorded.includes('-s'), false)
  assert.equal(recorded.includes('-C'), false)
  assert.deepEqual(recorded.slice(0, 3), ['exec', 'resume', 't-1'])
  assert.equal(recorded.includes('--json'), true)
})

/**
 * Build a host whose session controller opens a worker that finishes a turn.
 * @param options - whether the turn ever ends.
 * @returns `{ api, created, events }`.
 */
function taskHost(options = {}) {
  const events = []
  const listeners = new Set()
  const created = []
  const session = { id: 'session-worker', seq: 0, snapshotEvents: () => events }
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === 'session-worker' ? session : undefined) }
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async (path) => (options.workspaceByPath?.[path] ?? undefined),
          create: async (path, title) => {
            calls.workspaceCreate.push({ path, title })
            const workspace = {
              id: `ws-${String(calls.workspaceCreate.length)}`,
              path,
              title: title ?? path.split('/').filter(Boolean).pop() ?? path,
              attached: [],
              attachSession: async (id) => { workspace.attached.push(id) },
            }
            calls.workspaceAttached.push(workspace)
            return workspace
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => options.defaultSelection ?? { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }
      }
      if (name === 'sessionController') {
        return {
          create: async (request) => {
            created.push(request)
            return { sessionId: 'session-worker' }
          },
          prompt: async () => {
            events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } })
            events.push({
              seq: 2,
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '实施完成' }] } },
            })
            session.seq = 2
            if (options.finish !== false) {
              setTimeout(() => {
                session.seq = 3
                for (const listener of listeners) {
                  listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
                }
              }, 20)
            }
            return { accepted: true }
          },
          list: async () => ({ items: [] }),
        }
      }
      return undefined
    },
  }
  return { api: createApi(ctx, { dispatched: new Set() }, { maxResultChars: 1000, taskTimeoutSeconds: 5 }), created, events }
}

test('dsh_task opens a worker, waits for its turn, and returns the answer', async () => {
  const { api, created } = taskHost()
  const result = await api.task({ prompt: '实现 X', cwd: '/tmp' })
  assert.equal(result.sessionId, 'session-worker')
  assert.equal(result.created, true)
  assert.equal(result.status, 'completed')
  assert.equal(result.text, '实施完成')
  assert.equal(result.turns, 1)
  assert.deepEqual(created[0], { cwd: '/tmp' })
})

test('dsh_task reports a timeout instead of hanging', async () => {
  const { api } = taskHost({ finish: false })
  const result = await api.task({ prompt: 'never ends', timeoutSeconds: 1 })
  assert.equal(result.status, 'timeout')
  assert.equal(result.text, '实施完成')
})

test('dsh_task delivers only the final answer, not the whole turn', async () => {
  const events = []
  const listeners = new Set()
  const session = { id: 'session-worker', seq: 0, snapshotEvents: () => events }
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === 'session-worker' ? session : undefined) }
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async (path) => (options.workspaceByPath?.[path] ?? undefined),
          create: async (path, title) => {
            calls.workspaceCreate.push({ path, title })
            const workspace = {
              id: `ws-${String(calls.workspaceCreate.length)}`,
              path,
              title: title ?? path.split('/').filter(Boolean).pop() ?? path,
              attached: [],
              attachSession: async (id) => { workspace.attached.push(id) },
            }
            calls.workspaceAttached.push(workspace)
            return workspace
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => options.defaultSelection ?? { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }
      }
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'session-worker' }),
          prompt: async () => {
            events.push({ seq: 1, type: 'turn/start', data: { turn: 1 } })
            events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先看一下文件。' }] } } })
            events.push({ seq: 3, type: 'tool/call', data: {} })
            events.push({ seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '改好了：修了 3 个用例。' }] } } })
            session.seq = 5
            setTimeout(() => {
              for (const listener of listeners) {
                listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
              }
            }, 20)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  const api = createApi(ctx, { dispatched: new Set() }, { maxResultChars: 1000, taskTimeoutSeconds: 5 })
  const result = await api.task({ prompt: '实现 X' })
  assert.equal(result.text, '改好了：修了 3 个用例。')
})

/**
 * Host whose two workers finish at different times.
 * @param options - which workers exist and how they end.
 * @returns an api plus the machine to drive it.
 */
function waitHost(options = {}) {
  const listeners = new Set()
  const sessions = new Map()
  const make = (id, kind) => {
    const events = []
    sessions.set(id, { id, seq: 0, snapshotEvents: () => events, events, kind })
    return sessions.get(id)
  }
  make('session-slow', 'running')
  if (options.fastCompletes !== false) make('session-fast', 'completed')
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return { get: (id) => ({ status: sessions.get(id)?.kind === 'running' ? 'running' : 'idle' }) }
      return undefined
    },
  }
  const state = { dispatched: new Set(['session-slow', 'session-fast']), baseline: new Map([['session-slow', 0], ['session-fast', 0]]) }
  const fast = sessions.get('session-fast')
  if (fast !== undefined) {
    fast.events.push({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先看看。' }] } } })
    fast.events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这个函数有越界风险。' }] } } })
    fast.events.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  return { api: createApi(ctx, state, { maxResultChars: 1000 }), sessions }
}

test('dsh_wait returns as soon as one worker finishes, with its final answer', async () => {
  const { api } = waitHost()
  const started = Date.now()
  const result = await api.wait({ targets: ['session-slow', 'session-fast'], timeoutMs: 5000 })
  assert.equal(result.timedOut, false)
  assert.equal(result.status['session-slow'], 'running')
  assert.deepEqual(result.status['session-fast'], { completed: '这个函数有越界风险。' })
  assert.ok(Date.now() - started < 1000)
})

test('dsh_wait times out when nothing finishes and reports current states', async () => {
  const { api } = waitHost({ fastCompletes: false })
  const result = await api.wait({ targets: ['session-slow'], timeoutMs: 400 })
  assert.equal(result.timedOut, true)
  assert.equal(result.status['session-slow'], 'running')
})

test('dsh_wait marks sessions this bridge never dispatched and reports errors', async () => {
  const { api, sessions } = waitHost({ fastCompletes: false })
  const broken = sessions.get('session-slow')
  broken.kind = 'failed'
  broken.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  const result = await api.wait({ targets: ['session-slow', 'session-unknown'], timeoutMs: 500 })
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.status['session-slow'], { errored: 'error' })
  assert.equal(result.status['session-unknown'], 'not_found')
})

/**
 * Host that can open workers and fork sessions.
 * @param options - worker limit and fork behaviour.
 * @returns an api plus the recorded calls.
 */
function workerHost(options = {}) {
  const calls = { create: [], fork: [], prompt: [], selectModel: [], workspaceCreate: [], workspaceAttached: [] }
  const sessions = new Map()
  const listeners = new Set()
  let counter = 0
  const make = (id) => {
    const session = { id, seq: 0, snapshotEvents: () => session.events, events: [] }
    sessions.set(id, session)
    return session
  }
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async (path) => (options.workspaceByPath?.[path] ?? undefined),
          create: async (path, title) => {
            calls.workspaceCreate.push({ path, title })
            const workspace = {
              id: `ws-${String(calls.workspaceCreate.length)}`,
              path,
              title: title ?? path.split('/').filter(Boolean).pop() ?? path,
              attached: [],
              attachSession: async (id) => { workspace.attached.push(id) },
            }
            calls.workspaceAttached.push(workspace)
            return workspace
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => options.defaultSelection ?? { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }
      }
      if (name === 'sessionController') {
        return {
          create: async (request) => {
            calls.create.push(request)
            counter += 1
            const id = `session-new${String(counter)}`
            make(id)
            return { sessionId: id }
          },
          fork: async (request) => {
            calls.fork.push(request)
            counter += 1
            const id = `session-fork${String(counter)}`
            make(id)
            return { sessionId: id }
          },
          selectModel: async (request) => {
            calls.selectModel.push(request)
            return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
          },
          prompt: async (request) => {
            calls.prompt.push(request)
            const session = sessions.get(request.sessionId)
            const turn = calls.prompt.filter((call) => call.sessionId === request.sessionId).length
            const base = session.seq
            session.events.push({ seq: base + 1, type: 'turn/start', data: { turn } })
            session.events.push({ seq: base + 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${String(turn)}轮结果` }] } } })
            session.events.push({ seq: base + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
            session.seq = base + 3
            for (const listener of listeners) {
              listener(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
            }
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  const api = createApi(ctx, { dispatched: new Set() }, {
    maxResultChars: 1000,
    maxWorkers: options.maxWorkers ?? 4,
    maxWorkersPerRoot: options.maxWorkersPerRoot ?? 4,
    workerTtlMs: options.workerTtlMs ?? 24 * 60 * 60 * 1000,
    maxHops: options.maxHops ?? 1,
    dispatchPerMinute: options.dispatchPerMinute ?? 1000,
    dispatchWindowMs: options.dispatchWindowMs ?? 60000,
    codexBin: '/definitely/not/here/codex',
    codexTimeoutMs: 5000,
  })
  return { api, calls, sessions, ctx }
}

test('dsh_spawn returns immediately and registers the worker', async () => {
  const { api, calls } = workerHost()
  const spawned = await api.spawn({ taskName: 'review_pr', message: '审一下这个 PR', forkTurns: 'none', cwd: '/tmp' })
  assert.equal(spawned.task_name, 'review_pr')
  assert.equal(spawned.accepted, true)
  assert.match(spawned.sessionId, /^session-new/)
  assert.deepEqual(calls.create[0], { cwd: '/tmp' })
  const listed = await api.listWorkers()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].task_name, 'review_pr')
  assert.deepEqual(listed[0].status, { completed: '第1轮结果' })
})

test('dsh_spawn with fork_turns all forks the named session', async () => {
  const { api, calls } = workerHost()
  await api.spawn({ taskName: 'cont', message: '接着干', forkTurns: 'all', from: 'session-parent' })
  assert.deepEqual(calls.fork[0], { sessionId: 'session-parent' })
  assert.equal(calls.create.length, 0)
})

test('dsh_spawn enforces the worker limit until one is closed', async () => {
  const { api } = workerHost({ maxWorkers: 1 })
  await api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  await assert.rejects(() => api.spawn({ taskName: 'two', message: 'b', forkTurns: 'none' }), /worker limit reached/)
  await api.close({ worker: 'one' })
  const spawned = await api.spawn({ taskName: 'two', message: 'b', forkTurns: 'none' })
  assert.equal(spawned.task_name, 'two')
})

test('dsh_followup reuses the worker session and rebases its final answer', async () => {
  const { api, calls, sessions } = workerHost()
  const spawned = await api.spawn({ taskName: 'w1', message: '第一件事', forkTurns: 'none' })
  const before = calls.prompt.length
  const followup = await api.followup({ worker: 'w1', message: '第二件事' })
  assert.equal(followup.sessionId, spawned.sessionId)
  assert.equal(calls.prompt.length, before + 1)
  const status = await api.listWorkers()
  assert.deepEqual(status[0].status, { completed: '第2轮结果' })
  void sessions
})

test('dsh_wait settles immediately on unknown or closed targets', async () => {
  const { api } = workerHost()
  const started = Date.now()
  const unknown = await api.wait({ targets: ['nope'], timeoutMs: 5000 })
  assert.equal(unknown.timedOut, false)
  assert.equal(unknown.status.nope, 'not_found')
  await api.spawn({ taskName: 'w9', message: 'a', forkTurns: 'none' })
  await api.close({ worker: 'w9' })
  const closed = await api.wait({ targets: ['w9'], timeoutMs: 5000 })
  assert.equal(closed.timedOut, false)
  assert.equal(closed.status.w9, 'closed')
  assert.ok(Date.now() - started < 1000)
})

test('dsh_wait accepts task names and marks closed workers', async () => {
  const { api } = workerHost()
  await api.spawn({ taskName: 'w2', message: 'a', forkTurns: 'none' })
  const waited = await api.wait({ targets: ['w2'], timeoutMs: 1000 })
  assert.deepEqual(waited.status.w2, { completed: '第1轮结果' })
  await api.close({ worker: 'w2' })
  assert.equal((await api.wait({ targets: ['w2'], timeoutMs: 1000 })).status.w2, 'closed')
  assert.equal((await api.wait({ targets: ['nope'], timeoutMs: 1000 })).status.nope, 'not_found')
})

test('the worker registry survives a restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadWorkers, saveWorkers } = await import('../index.js')

  const dir = await mkdtemp(join(tmpdir(), 'bridge-registry-'))
  const settings = { workersFile: join(dir, 'workers.json') }
  try {
    const state = { dispatched: new Set(), baseline: new Map(), workers: new Map() }
    await loadWorkers(settings, state)
    state.workers.set('persisted', { taskName: 'persisted', sessionId: 'session-done', status: 'open', createdAt: 1, updatedAt: 1, outcome: { completed: '旧答案' } })
    state.baseline.set('session-done', 7)
    state.dispatched.add('session-done')
    await saveWorkers(settings, state)

    const restored = { dispatched: new Set(), baseline: new Map(), workers: new Map() }
    await loadWorkers(settings, restored)
    assert.equal(restored.workers.size, 1)
    assert.deepEqual(restored.workers.get('persisted').outcome, { completed: '旧答案' })
    assert.equal(restored.baseline.get('session-done'), 7)
    assert.equal(restored.dispatched.has('session-done'), true)

    /* A cold session with a cached outcome still answers from the cache. */
    const coldCtx = { on: () => () => {}, get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined) }
    const api = createApi(coldCtx, restored, { maxResultChars: 1000 })
    const waited = await api.wait({ targets: ['persisted'], timeoutMs: 5000 })
    assert.deepEqual(waited.status.persisted, { completed: '旧答案' })
    assert.equal(waited.timedOut, false)

    /* A cold session without a cached outcome reports offline and settles. */
    restored.workers.set('lost', { taskName: 'lost', sessionId: 'session-lost', status: 'open', createdAt: 1, updatedAt: 1 })
    restored.dispatched.add('session-lost')
    const offline = await api.wait({ targets: ['lost'], timeoutMs: 5000 })
    assert.equal(offline.status.lost, 'offline')
    assert.equal(offline.timedOut, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the persisted registry drops the oldest closed workers first', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadWorkers, saveWorkers } = await import('../index.js')

  const dir = await mkdtemp(join(tmpdir(), 'bridge-prune-'))
  const settings = { workersFile: join(dir, 'workers.json') }
  try {
    const state = { dispatched: new Set(), baseline: new Map(), workers: new Map() }
    for (let index = 0; index < 205; index += 1) {
      state.workers.set(`w${String(index)}`, {
        taskName: `w${String(index)}`,
        sessionId: `session-${String(index)}`,
        status: index < 200 ? 'closed' : 'open',
        createdAt: index,
        updatedAt: index,
      })
    }
    state.workers.set('open_one', { taskName: 'open_one', sessionId: 'session-open', status: 'open', createdAt: 999, updatedAt: 999 })
    await saveWorkers(settings, state)
    const restored = { dispatched: new Set(), baseline: new Map(), workers: new Map() }
    await loadWorkers(settings, restored)
    assert.ok(restored.workers.size <= 200)
    assert.equal(restored.workers.has('open_one'), true)
    assert.equal(restored.workers.has('w204'), true)
    assert.equal(restored.workers.has('w0'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('maxHops 1 allows the first cross-tool delegation but not a return hop', async () => {
  const { api } = workerHost()
  await api.spawn({ taskName: 'first', message: 'a', forkTurns: 'none' })

  /* A bridge worker trying to delegate back would be depth 2. */
  const workerSession = (await api.listWorkers())[0].sessionId
  await assert.rejects(
    () => api.dispatchCodex({ prompt: '回去问问' }, { agent: { id: workerSession } }),
    /delegation depth 2, but maxHops is 1/,
  )

  /* A user session (not a worker) may still delegate one level. */
  const result = await api.dispatchCodex({ prompt: 'x', cwd: '/tmp' }, { agent: { id: 'session-user' } })
  assert.equal(typeof result.ok, 'boolean')
})

test('an in-flight outbound run blocks nested inbound delegations', async () => {
  const { ctx } = workerHost()
  const { enterChain, leaveChain } = await import('../index.js')
  const state = { dispatched: new Set(), baseline: new Map(), workers: new Map(), chain: { depth: 0, active: 0, until: 0 }, recent: [] }
  const nested = createApi(ctx, state, { maxResultChars: 1000, maxHops: 1, dispatchPerMinute: 1000, dispatchWindowMs: 60000 })

  enterChain(state, 1, 5000)
  await assert.rejects(() => nested.spawn({ taskName: 'nested', message: 'a', forkTurns: 'none' }), /delegation depth 2/)
  leaveChain(state)
  const ok = await nested.spawn({ taskName: 'after', message: 'a', forkTurns: 'none' })
  assert.equal(ok.task_name, 'after')
})

test('the rolling rate limit refuses the burst and mentions the retry window', async () => {
  const { api } = workerHost({ dispatchPerMinute: 2 })
  await api.spawn({ taskName: 'r1', message: 'a', forkTurns: 'none' })
  await api.spawn({ taskName: 'r2', message: 'b', forkTurns: 'none' })
  await assert.rejects(() => api.spawn({ taskName: 'r3', message: 'c', forkTurns: 'none' }), /rate limit: 2 dispatches per 60s reached; retry in \d+s/)
})

test('the rate window expires', async () => {
  const { api } = workerHost({ dispatchPerMinute: 1, dispatchWindowMs: 300 })
  await api.spawn({ taskName: 'e1', message: 'a', forkTurns: 'none' })
  await assert.rejects(() => api.spawn({ taskName: 'e2', message: 'b', forkTurns: 'none' }), /rate limit/)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const ok = await api.spawn({ taskName: 'e2', message: 'b', forkTurns: 'none' })
  assert.equal(ok.task_name, 'e2')
})

test('follow-ups count against the same budget', async () => {
  const { api } = workerHost({ dispatchPerMinute: 2 })
  await api.spawn({ taskName: 'f1', message: 'a', forkTurns: 'none' })
  await api.followup({ worker: 'f1', message: 'b' })
  await assert.rejects(() => api.followup({ worker: 'f1', message: 'c' }), /rate limit/)
})

test('the handshake reports the manifest version', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const { api } = apiUnderTest()
  const reply = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, api)
  assert.equal(reply.result.serverInfo.version, manifest.version)
})

test('blocking tasks do not consume the spawn budget', async () => {
  const { api } = workerHost({ maxWorkers: 2 })
  for (const name of ['t1', 't2', 't3']) {
    const result = await api.task({ prompt: name, timeoutSeconds: 5 })
    assert.equal(result.status, 'completed')
  }
  const spawned = await api.spawn({ taskName: 's1', message: 'a', forkTurns: 'none' })
  assert.equal(spawned.task_name, 's1')
  /* Two spawned workers still hit the limit. */
  await api.spawn({ taskName: 's2', message: 'b', forkTurns: 'none' })
  await assert.rejects(() => api.spawn({ taskName: 's3', message: 'c', forkTurns: 'none' }), /worker limit reached/)
})

test('stale worker records stop holding a slot after the TTL', async () => {
  const { api } = workerHost({ maxWorkers: 4, maxWorkersPerRoot: 2 })
  /* Fill both slots of one root, then age them past the TTL. */
  await api.spawn({ taskName: 'a1', message: 'a', forkTurns: 'none', cwd: '/repo/a' })
  await api.spawn({ taskName: 'a2', message: 'b', forkTurns: 'none', cwd: '/repo/a' })
  await assert.rejects(() => api.spawn({ taskName: 'a3', message: 'c', forkTurns: 'none', cwd: '/repo/a' }), /worker limit reached for \/repo\/a \(2\)/)

  const stale = workerHost({ maxWorkers: 4, maxWorkersPerRoot: 2, workerTtlMs: 1000 })
  await stale.api.spawn({ taskName: 'old1', message: 'a', forkTurns: 'none', cwd: '/repo/a' })
  const record = (await stale.api.listWorkers()).find((row) => row.task_name === 'old1')
  assert.ok(record)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const fresh = await stale.api.spawn({ taskName: 'new1', message: 'b', forkTurns: 'none', cwd: '/repo/a' })
  assert.equal(fresh.task_name, 'new1')
})

test('each working directory gets its own budget up to the global ceiling', async () => {
  const { api } = workerHost({ maxWorkers: 4, maxWorkersPerRoot: 2 })
  await api.spawn({ taskName: 'a1', message: 'a', forkTurns: 'none', cwd: '/repo/a' })
  await api.spawn({ taskName: 'a2', message: 'b', forkTurns: 'none', cwd: '/repo/a' })
  /* Another project still has room. */
  await api.spawn({ taskName: 'b1', message: 'c', forkTurns: 'none', cwd: '/repo/b' })
  await api.spawn({ taskName: 'b2', message: 'd', forkTurns: 'none', cwd: '/repo/b' })
  /* The global ceiling of 4 is now reached. */
  await assert.rejects(
    () => api.spawn({ taskName: 'c1', message: 'e', forkTurns: 'none', cwd: '/repo/c' }),
    /global worker limit reached \(4\)/,
  )
})

test('a timed-out task reports that the worker is still running', async () => {
  const events = []
  const session = { id: 'session-slow', seq: 0, snapshotEvents: () => events }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === 'session-slow' ? session : undefined) }
      if (name === 'agents') return { get: () => ({ status: 'running' }) }
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'session-slow' }),
          /* Never finishes: the call has to time out. */
          prompt: async () => ({ accepted: true }),
        }
      }
      return undefined
    },
  }
  const api = createApi(ctx, { dispatched: new Set() }, { maxResultChars: 1000, taskTimeoutSeconds: 1, maxHops: 1, dispatchPerMinute: 100 })
  const result = await api.task({ prompt: '长任务' })
  assert.equal(result.status, 'timeout')
  assert.equal(result.running, true)
  assert.match(result.next, /do not end the turn/)
  assert.match(result.next, /dsh_wait/)
})

test('blocking durations stay under the MCP client timeout', async () => {
  const { api } = workerHost()
  /* A caller asking for an hour gets clamped, not a client-side timeout error. */
  const waited = await api.wait({ targets: ['nobody'], timeoutMs: 3_600_000 })
  assert.equal(waited.timedOut, false)
  assert.equal(waited.status.nobody, 'not_found')
  const task = await api.task({ prompt: 'x', timeoutSeconds: 3600 })
  assert.equal(task.status, 'completed')
})

test('a spawned worker is attached to the workspace its directory belongs to', async () => {
  const attached = []
  const host = workerHost()
  const workspace = { id: 'ws-clawer', attachSession: async (id) => { attached.push(id) } }
  const ctx = {
    ...host.ctx,
    get(name) {
      if (name === 'workspaceRegistry') {
        return { resolveByPath: async (path) => (path === '/repo/clawer' ? workspace : undefined) }
      }
      return host.ctx.get(name)
    },
  }
  const api = createApi(ctx, { dispatched: new Set() }, { maxResultChars: 1000, maxWorkers: 4, maxHops: 1, dispatchPerMinute: 100 })
  const spawned = await api.spawn({ taskName: 'w', message: 'a', forkTurns: 'none', cwd: '/repo/clawer' })
  assert.deepEqual(attached, [spawned.sessionId])

  /* A directory outside every workspace stays ungrouped instead of throwing. */
  const outside = await api.spawn({ taskName: 'w2', message: 'b', forkTurns: 'none', cwd: '/elsewhere' })
  assert.equal(attached.length, 1)
  assert.ok(outside.sessionId)
})

test('dsh_task switches the worker to the requested provider/model', async () => {
  const { api, calls } = workerHost()
  const result = await api.task({ prompt: '做点事', cwd: '/tmp', model: 'zai-coding-cn/glm-5.3', reasoningEffort: 'max' })
  assert.equal(calls.selectModel.length, 1)
  assert.deepEqual(calls.selectModel[0], {
    sessionId: result.sessionId,
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    reasoningEffort: 'max',
  })
  assert.equal(result.model.provider, 'zai-coding-cn')
  assert.equal(result.model.model, 'glm-5.3')
  /* The selection must land before the prompt, otherwise the first turn runs on the old model. */
  assert.equal(calls.prompt.length, 1)
})

test('a bare model id keeps the default provider', async () => {
  const { api, calls } = workerHost()
  await api.spawn({ taskName: 'w', message: 'a', forkTurns: 'none', cwd: '/tmp', model: 'glm-5.3' })
  assert.equal(calls.selectModel[0].provider, 'opencode-go')
  assert.equal(calls.selectModel[0].model, 'glm-5.3')
})

test('dsh_spawn carries the model onto the forked worker too', async () => {
  const { api, calls } = workerHost()
  await api.spawn({ taskName: 'w', message: 'a', forkTurns: 'none', cwd: '/tmp' })
  await api.followup({ worker: 'w', message: '继续', model: 'deepseek-account/deepseek-flash' })
  assert.equal(calls.selectModel.length, 1)
  assert.equal(calls.selectModel[0].provider, 'deepseek-account')
  assert.equal(calls.selectModel[0].model, 'deepseek-flash')
  assert.equal(calls.selectModel[0].reasoningEffort, undefined)
})

test('an unusable model spec fails the dispatch with a clear message', async () => {
  const { api, calls } = workerHost()
  await assert.rejects(
    () => api.task({ prompt: 'x', cwd: '/tmp', model: '/glm-5.3' }),
    /model must look like "provider\/model"/,
  )
  assert.equal(calls.prompt.length, 0)
})

test('no model argument leaves the session untouched', async () => {
  const { api, calls } = workerHost()
  await api.task({ prompt: 'x', cwd: '/tmp' })
  assert.equal(calls.selectModel.length, 0)
})

test('workspace: true creates a project for the directory and groups the worker in it', async () => {
  const { api, calls } = workerHost()
  const result = await api.task({ prompt: 'x', cwd: '/repo/new-project', workspace: true })
  assert.deepEqual(calls.workspaceCreate, [{ path: '/repo/new-project', title: undefined }])
  assert.deepEqual(calls.workspaceAttached[0].attached, [result.sessionId])
  assert.equal(result.workspace.title, 'new-project')
})

test('a workspace title is passed through', async () => {
  const { api, calls } = workerHost()
  const result = await api.spawn({ taskName: 'w', message: 'x', forkTurns: 'none', cwd: '/repo/p', workspace: 'Clawer' })
  assert.deepEqual(calls.workspaceCreate, [{ path: '/repo/p', title: 'Clawer' }])
  assert.equal(result.workspace.title, 'Clawer')
})

test('without the flag an unowned directory leaves the worker ungrouped, and is never created', async () => {
  const { api, calls } = workerHost()
  const result = await api.task({ prompt: 'x', cwd: '/repo/loose' })
  assert.equal(calls.workspaceCreate.length, 0)
  assert.equal(result.workspace, undefined)
})

test('an existing project is reused instead of created', async () => {
  const existing = { id: 'ws-known', path: '/repo/known', title: 'Known', attached: [], attachSession: async (id) => { existing.attached.push(id) } }
  const { api, calls } = workerHost({ workspaceByPath: { '/repo/known': existing } })
  const result = await api.task({ prompt: 'x', cwd: '/repo/known' })
  assert.equal(calls.workspaceCreate.length, 0)
  assert.deepEqual(existing.attached, [result.sessionId])
  assert.equal(result.workspace.title, 'Known')
})
