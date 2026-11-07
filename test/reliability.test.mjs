import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { createApi } from '../src/api.js'
import { loadWorkers, saveWorkers } from '../src/registry.js'

async function host(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-reliability-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const settings = {
    workersFile: join(dir, 'workers.json'), maxResultChars: 5000, maxWorkers: options.maxWorkers ?? 4,
    maxWorkersPerRoot: 4, workerTtlMs: 86400000, maxHops: 1, dispatchPerMinute: 100,
    dispatchWindowMs: 60000, waitTimeoutMs: 1000, taskTimeoutSeconds: 10, readWaitSeconds: 10,
    assumeDefaults: false,
  }
  const sessions = new Map(), prompts = [], listeners = new Set(), logs = []
  let counter = 0, releaseCreate
  let createGate = options.blockCreate ? new Promise((resolve) => { releaseCreate = resolve }) : undefined
  let createFails = false, promptMode = 'complete', running = false
  const add = (id, events = []) => {
    const session = { id, seq: events.length ? Math.max(...events.map((event) => event.seq)) : 0, events, snapshotEvents() { return this.events } }
    sessions.set(id, session)
    return session
  }
  const service = {
    create: async () => {
      if (createFails) throw new Error('create refused')
      const sessionId = `session-${++counter}`
      add(sessionId)
      if (createGate !== undefined) await createGate
      return { sessionId }
    },
    prompt: async ({ sessionId }) => {
      prompts.push(sessionId)
      if (promptMode === 'throw') throw new Error('response lost')
      if (promptMode === 'reject') return { accepted: false }
      const session = sessions.get(sessionId)
      const turn = prompts.filter((value) => value === sessionId).length
      const before = session.seq
      session.events.push({ seq: before + 1, type: 'turn/start', data: { turn } })
      session.seq = before + 1
      if (promptMode === 'running') { running = true; return { accepted: true } }
      session.events.push({ seq: before + 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer-${turn}` }] } } })
      const end = { seq: before + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
      session.events.push(end)
      session.seq = end.seq
      for (const listener of listeners) listener(session, end)
      return { accepted: true }
    },
  }
  const ctx = {
    logger: { warn: (message) => logs.push(message) },
    on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    get: (name) => {
      if (name === 'sessionController') return service
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return { get: () => ({ status: running ? 'running' : 'idle' }) }
    },
  }
  const state = { dispatched: new Set() }
  return {
    api: createApi(ctx, state, settings), state, settings, sessions, prompts, listeners, logs, dir, add, ctx, service,
    release: () => { releaseCreate?.(); createGate = undefined },
    setCreateFails: (value) => { createFails = value },
    setPromptMode: (value) => { promptMode = value },
  }
}

test('parallel spawns reserve capacity and names before session creation', async (t) => {
  const limited = await host(t, { maxWorkers: 1, blockCreate: true })
  const first = limited.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  await assert.rejects(limited.api.spawn({ taskName: 'two', message: 'b', forkTurns: 'none' }), /worker limit/)
  limited.release()
  assert.equal((await first).accepted, true)
  assert.equal(limited.prompts.length, 1)

  const names = await host(t, { blockCreate: true })
  const original = names.api.spawn({ taskName: 'same', message: 'a', forkTurns: 'none' })
  await assert.rejects(names.api.spawn({ taskName: 'same', message: 'b', forkTurns: 'none' }), /already in use/)
  names.release()
  await original
  assert.equal(names.prompts.length, 1)
})

test('spawn releases reservations when creation fails or dispatch is refused', async (t) => {
  const h = await host(t, { maxWorkers: 1 })
  h.setCreateFails(true)
  await assert.rejects(h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' }), /create refused/)
  assert.equal(h.state.workers.size, 0)
  h.setCreateFails(false)
  h.setPromptMode('reject')
  assert.equal((await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })).accepted, false)
  assert.equal(h.state.workers.size, 0)
  h.setPromptMode('complete')
  assert.equal((await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })).accepted, true)
})

test('an uncertain dispatch keeps a persisted session and request id for diagnosis', async (t) => {
  const h = await host(t)
  h.setPromptMode('throw')
  await assert.rejects(h.api.spawn({ taskName: 'uncertain', message: 'a', forkTurns: 'none' }), /outcome is unknown.*inspect it before retrying/)
  const row = (await h.api.listWorkers())[0]
  assert.equal(row.dispatchState, 'unknown')
  assert.match(row.requestId, /^[0-9a-f-]{36}$/)
  assert.match(row.dispatchError, /response lost/)
  await assert.rejects(h.api.spawn({ taskName: 'uncertain', message: 'again', forkTurns: 'none' }), /already in use/)
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  assert.equal(restored.workers.get('uncertain').requestId, row.requestId)
  assert.equal(restored.workers.get('uncertain').dispatchState, 'unknown')
})

test('followup by session id invalidates cached results across restart', async (t) => {
  const h = await host(t)
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  assert.equal((await h.api.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-1')
  await h.api.followup({ worker: worker.sessionId, message: 'b' })
  assert.equal((await h.api.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-2')
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  const cold = createApi({ get: () => undefined }, restored, h.settings)
  assert.equal((await cold.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-2')
})

test('result reads clamp to the first dispatch but retain older valid cursors', async (t) => {
  const h = await host(t)
  h.add('existing', [
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old private text' }] } } },
    { seq: 10, type: 'other', data: {} },
  ])
  const first = await h.api.dispatch({ sessionId: 'existing', text: 'one', mode: 'queue' })
  await h.api.dispatch({ sessionId: 'existing', text: 'two', mode: 'queue' })
  const all = await h.api.readResult({ sessionId: 'existing', sinceSeq: 0, waitSeconds: 0 })
  assert.doesNotMatch(all.text, /old private text/)
  assert.match(all.text, /answer-1/)
  assert.match(all.text, /answer-2/)
  assert.equal(first.seqAtDispatch, 10)
  assert.equal((await h.api.readResult({ sessionId: 'existing', sinceSeq: first.seqAtDispatch, waitSeconds: 0 })).text, all.text)
})

test('a refused task prompt immediately removes its turn listener', async (t) => {
  const h = await host(t)
  h.setPromptMode('throw')
  await assert.rejects(h.api.task({ prompt: 'a', timeoutSeconds: 10 }), /response lost/)
  assert.equal(h.listeners.size, 0)
})

test('registry writes report failures, recover, and leave no partial temporary files', async (t) => {
  const h = await host(t)
  h.settings.workersFile = h.dir // Rename onto an existing directory must fail.
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  assert.match(worker.persistenceWarning, /registry persistence failed/)
  assert.ok(h.logs.length > 0)
  h.settings.workersFile = join(h.dir, 'workers.json')
  await saveWorkers(h.settings, h.state)
  assert.equal(h.state.persistenceError, undefined)
  assert.equal((await stat(h.settings.workersFile)).mode & 0o077, 0)
  assert.equal((await readdir(h.dir)).some((name) => name.endsWith('.tmp')), false)
  assert.equal(JSON.parse(await readFile(h.settings.workersFile, 'utf8')).workers.length, 1)
})

test('an interrupted dispatching record reloads as an unknown outcome', async (t) => {
  const h = await host(t)
  h.state.workers.set('pending', { taskName: 'pending', sessionId: 'session-pending', status: 'open', dispatchState: 'dispatching', requestId: 'req-1', createdAt: Date.now(), updatedAt: Date.now() })
  await saveWorkers(h.settings, h.state)
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  assert.equal(restored.workers.get('pending').dispatchState, 'unknown')
  assert.equal(restored.workers.get('pending').requestId, 'req-1')
})

test('legacy persisted baselines prevent pre-dispatch result reads', async (t) => {
  const h = await host(t)
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  h.state.readFloor.delete(worker.sessionId)
  h.state.baseline.set(worker.sessionId, 2)
  await saveWorkers(h.settings, h.state)
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  const api = createApi(h.ctx, restored, h.settings)
  const result = await api.readResult({ sessionId: worker.sessionId, sinceSeq: 0, waitSeconds: 0 })
  assert.equal(result.text, '')
})

test('an explicitly refused blocking task rolls back its provisional record', async (t) => {
  const h = await host(t)
  h.setPromptMode('reject')
  const result = await h.api.task({ prompt: 'a', timeoutSeconds: 10 })
  assert.equal(result.status, 'not-accepted')
  assert.equal(result.accepted, false)
  assert.equal(h.state.workers.size, 0)
  assert.equal(h.state.dispatched.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('blocking continuation invalidates the existing worker cache without adding a second record', async (t) => {
  const h = await host(t)
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  assert.equal((await h.api.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-1')
  const result = await h.api.task({ sessionId: worker.sessionId, prompt: 'b', timeoutSeconds: 1 })
  assert.equal(result.text, 'answer-2')
  assert.equal(h.state.workers.size, 1)
  assert.equal((await h.api.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-2')
})

test('closing a worker during model selection prevents a followup dispatch', async (t) => {
  const h = await host(t)
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.service.selectModel = async (request) => { await gate; return { selected: { provider: request.provider, model: request.model } } }
  const rejected = assert.rejects(h.api.followup({ worker: worker.sessionId, message: 'b', model: 'provider/model' }), /closed/)
  await delay(0)
  await h.api.close({ worker: 'one' })
  release()
  await rejected
  assert.equal(h.prompts.length, 1)
})

test('extra: task cancellation releases waiter promptly', async (t) => {
  const h = await host(t)
  h.setPromptMode('running')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 25)
  const start = Date.now()
  const result = await h.api.task({ prompt: 'a', timeoutSeconds: 1, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(Date.now() - start < 500)
  assert.equal(h.listeners.size, 0)
})
test('extra: continuation preserves fresh answer across cold restart', async (t) => {
  const h = await host(t)
  const worker = await h.api.spawn({ taskName: 'one', message: 'a', forkTurns: 'none' })
  await h.api.wait({ targets: ['one'], timeoutMs: 1000 })
  const result = await h.api.task({ sessionId: worker.sessionId, prompt: 'b', timeoutSeconds: 1 })
  assert.equal(result.text, 'answer-2')
  await h.api.wait({ targets: ['one'], timeoutMs: 1000 })
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  const cold = createApi({ get: () => undefined }, restored, h.settings)
  assert.equal((await cold.wait({ targets: ['one'], timeoutMs: 1000 })).status.one.completed, 'answer-2')
})
test('extra: repeated blocking task clears its own persisted cache', async (t) => {
  const h = await host(t)
  const first = await h.api.task({ prompt: 'a', timeoutSeconds: 1 })
  await h.api.wait({ targets: [first.sessionId], timeoutMs: 1000 })
  const second = await h.api.task({ sessionId: first.sessionId, prompt: 'b', timeoutSeconds: 1 })
  assert.equal(second.text, 'answer-2')
  await h.api.wait({ targets: [first.sessionId], timeoutMs: 1000 })
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  const cold = createApi({ get: () => undefined }, restored, h.settings)
  assert.equal((await cold.wait({ targets: [first.sessionId], timeoutMs: 1000 })).status[first.sessionId].completed, 'answer-2')
})

test('a refused followup preserves the previous cache and operation', async (t) => {
  const h = await host(t)
  const first = await h.api.spawn({ taskName: 'one', message: 'a' })
  await h.api.wait({ targets: ['one'], timeoutMs: 1000 })
  h.setPromptMode('reject')
  const result = await h.api.followup({ worker: 'one', message: 'b' })
  assert.equal(result.accepted, false)
  assert.notEqual(result.operationId, first.operationId)
  assert.equal(h.state.workers.get('one').operationId, first.operationId)
  assert.equal(h.state.workers.get('one').outcome.completed, 'answer-1')
  assert.equal(h.state.baseline.get(first.sessionId), 0)
})

test('a rejected or failed reopen leaves the worker closed and frees capacity', async (t) => {
  const h = await host(t, { maxWorkers: 1 })
  await h.api.spawn({ taskName: 'one', message: 'a' })
  await h.api.close({ worker: 'one' })
  await assert.rejects(h.api.followup({ worker: 'one', message: 'b', model: '/bad' }))
  assert.equal(h.state.workers.get('one').status, 'closed')
  h.setPromptMode('reject')
  const rejected = await h.api.followup({ worker: 'one', message: 'b' })
  assert.equal(rejected.accepted, false)
  assert.equal(h.state.workers.get('one').status, 'closed')
  h.setPromptMode('complete')
  await h.api.spawn({ taskName: 'two', message: 'a' })
})

test('spawn intent cannot be overwritten by a concurrent followup or dispatch', async (t) => {
  const h = await host(t)
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  h.service.prompt = async () => { entered(); return new Promise((resolve) => { release = resolve }) }
  const pending = h.api.spawn({ taskName: 'one', message: 'a' })
  await started
  await assert.rejects(h.api.followup({ worker: 'one', message: 'b' }), /still being accepted/)
  await assert.rejects(h.api.dispatch({ sessionId: 'session-1', text: 'b', mode: 'queue' }), /still being accepted/)
  release({ accepted: false })
  await pending
  assert.equal(h.state.workers.size, 0)
})

test('direct dispatch persists uncertain intent and keeps its request id', async (t) => {
  const h = await host(t)
  h.add('existing')
  h.setPromptMode('throw')
  await assert.rejects(h.api.dispatch({ sessionId: 'existing', text: 'one', mode: 'queue' }), /outcome is unknown/)
  const rows = await h.api.listWorkers()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].dispatchState, 'unknown')
  assert.equal(h.state.operations.get(rows[0].operationId).status, 'unknown')
  const restored = { workers: new Map(), baseline: new Map(), dispatched: new Set() }
  await loadWorkers(h.settings, restored)
  assert.equal([...restored.workers.values()][0].requestId, rows[0].requestId)
})

test('spawn and task operation ids remain attached to their worker reports', async (t) => {
  const h = await host(t)
  const spawned = await h.api.spawn({ taskName: 'one', message: 'a' })
  const wait = await h.api.wait({ targets: ['one'], timeoutMs: 1000 })
  assert.equal(wait.report.one.operationId, spawned.operationId)
  const task = await h.api.task({ sessionId: spawned.sessionId, prompt: 'b' })
  const follow = await h.api.wait({ targets: ['one'], timeoutMs: 1000 })
  assert.equal(follow.report.one.operationId, task.operationId)
  assert.notEqual(task.operationId, spawned.operationId)
  assert.equal(h.state.workers.size, 1)
})

test('implicit worker names cannot steal a pending spawn reservation', async (t) => {
  const h = await host(t, { blockCreate: true })
  const pending = h.api.spawn({ taskName: 'task_abc', message: 'one' })
  h.add('session-abc')
  h.state.dispatched.add('session-abc')
  await h.api.followup({ worker: 'session-abc', message: 'two' })
  assert.equal(h.state.workers.has('task_abc'), false)
  assert.equal(h.state.workers.get('task_abc_2').sessionId, 'session-abc')
  h.release()
  const spawned = await pending
  assert.equal(spawned.task_name, 'task_abc')
  assert.equal(h.state.workers.get(spawned.task_name).sessionId, spawned.sessionId)
})
