import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi, loadWorkers, saveWorkers } from '../index.js'

/**
 * Fresh empty bookkeeping state.
 * @returns `{ dispatched, baseline, workers }`.
 */
const emptyState = () => ({ dispatched: new Set(), baseline: new Map(), workers: new Map() })

/**
 * Run one test with a private directory.
 * @param run - callback receiving the directory and its workers file path.
 */
async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-persist-'))
  try {
    await run({ dir, file: join(dir, 'workers.json') })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A Host whose controller opens workers and finishes them immediately.
 * @returns `{ ctx, sessions }`.
 */
function liveHost() {
  const sessions = new Map()
  let counter = 0
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'sessionController') {
        return {
          create: async () => {
            counter += 1
            const id = `session-${String(counter)}`
            const session = { id, seq: 0, events: [], snapshotEvents: () => session.events }
            sessions.set(id, session)
            return { sessionId: id }
          },
          prompt: async (request) => {
            const session = sessions.get(request.sessionId)
            const base = session.seq
            session.events.push({ seq: base + 1, type: 'turn/start', data: { turn: 1 } })
            session.events.push({ seq: base + 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好了' }] } } })
            session.events.push({ seq: base + 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
            session.seq = base + 3
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, sessions }
}

test('writes the registry with owner-only permissions', async () => {
  await withDir(async ({ file }) => {
    const state = emptyState()
    state.workers.set('w', { taskName: 'w', sessionId: 's', status: 'open', createdAt: 1, updatedAt: 1 })
    await saveWorkers({ workersFile: file }, state)
    const info = await stat(file)
    assert.equal(info.mode & 0o077, 0, `expected no group/other access, got ${String(info.mode.toString(8))}`)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.workers.length, 1)
  })
})

test('loading a missing or corrupt registry leaves an empty state', async () => {
  await withDir(async ({ dir, file }) => {
    const missing = emptyState()
    await loadWorkers({ workersFile: file }, missing)
    assert.equal(missing.workers.size, 0)

    await saveWorkers({ workersFile: join(dir, 'other.json') }, emptyState())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{ not json', 'utf8')
    const corrupt = emptyState()
    await loadWorkers({ workersFile: file }, corrupt)
    assert.equal(corrupt.workers.size, 0)
  })
})

test('loading skips malformed records instead of throwing', async () => {
  await withDir(async ({ file }) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        workers: [null, 7, { taskName: 42 }, { taskName: 'ok', sessionId: 'session-ok', status: 'open', createdAt: '1' }],
        baselines: { 'session-ok': 'not-a-number', 'session-bad': 3 },
      }),
      'utf8',
    )
    const state = emptyState()
    await loadWorkers({ workersFile: file }, state)
    assert.deepEqual([...state.workers.keys()], ['ok'])
    assert.equal(state.workers.get('ok').sessionId, 'session-ok')
    assert.equal(Number.isFinite(state.workers.get('ok').createdAt), true)
    /* A numeric baseline is kept even for an unknown session; a non-numeric one is dropped. */
    assert.equal(state.baseline.get('session-bad'), 3)
    assert.equal(state.baseline.has('session-ok'), false)
  })
})

test('a spawned worker is on disk before it finishes, and reloads as open', async () => {
  await withDir(async ({ file }) => {
    const settings = { workersFile: file, maxResultChars: 1000, maxWorkers: 4 }
    const { ctx } = liveHost()
    const state = emptyState()
    const api = createApi(ctx, state, settings)
    const spawned = await api.spawn({ taskName: 'early', message: '跑起来', forkTurns: 'none' })

    /* Read the file immediately: the worker has not produced an answer yet. */
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(persisted.workers.length, 1)
    assert.equal(persisted.workers[0].status, 'open')
    assert.equal('outcome' in persisted.workers[0], false)
    assert.equal(persisted.baselines[spawned.sessionId], 0)

    const restored = emptyState()
    await loadWorkers(settings, restored)
    assert.equal(restored.workers.get('early').sessionId, spawned.sessionId)
  })
})

test('completion caches the final answer and a follow-up clears it', async () => {
  await withDir(async ({ file }) => {
    const settings = { workersFile: file, maxResultChars: 1000, maxWorkers: 4 }
    const { ctx } = liveHost()
    const state = emptyState()
    const api = createApi(ctx, state, settings)
    await api.spawn({ taskName: 'w1', message: '第一件事', forkTurns: 'none' })
    await api.wait({ targets: ['w1'], timeoutMs: 1000 })

    const cached = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(cached.workers[0].outcome, { completed: '好了' })

    await api.followup({ worker: 'w1', message: '第二件事' })
    const cleared = JSON.parse(await readFile(file, 'utf8'))
    assert.equal('outcome' in cleared.workers[0], false)
  })
})

test('closing is persisted and survives a reload', async () => {
  await withDir(async ({ file }) => {
    const settings = { workersFile: file, maxResultChars: 1000, maxWorkers: 4 }
    const { ctx } = liveHost()
    const state = emptyState()
    const api = createApi(ctx, state, settings)
    await api.spawn({ taskName: 'w2', message: 'a', forkTurns: 'none' })
    await api.close({ worker: 'w2' })

    const restored = emptyState()
    await loadWorkers(settings, restored)
    assert.equal(restored.workers.get('w2').status, 'closed')

    /* A closed worker stays outside the concurrency budget after a restart. */
    const coldCtx = { on: () => () => {}, get: () => undefined }
    const coldApi = createApi(coldCtx, restored, settings)
    const listed = await coldApi.listWorkers()
    assert.equal(listed[0].status, 'closed')
  })
})

test('a reloaded worker whose session is cold answers from the cache, or reports offline', async () => {
  await withDir(async ({ file }) => {
    const settings = { workersFile: file, maxResultChars: 1000, maxWorkers: 4 }
    const { ctx } = liveHost()
    const state = emptyState()
    const api = createApi(ctx, state, settings)
    await api.spawn({ taskName: 'done', message: 'a', forkTurns: 'none' })
    await api.wait({ targets: ['done'], timeoutMs: 1000 })

    const restored = emptyState()
    await loadWorkers(settings, restored)
    restored.workers.set('mid', { taskName: 'mid', sessionId: 'session-mid', status: 'open', createdAt: 2, updatedAt: 2 })
    restored.dispatched.add('session-mid')

    const coldCtx = { on: () => () => {}, get: () => undefined }
    const coldApi = createApi(coldCtx, restored, settings)
    const waited = await coldApi.wait({ targets: ['done', 'mid'], timeoutMs: 5000 })
    assert.deepEqual(waited.status.done, { completed: '好了' })
    assert.equal(waited.status.mid, 'offline')
    assert.equal(waited.timedOut, false)
  })
})

test('concurrent saves serialize into one parseable document', async () => {
  await withDir(async ({ file }) => {
    const state = emptyState()
    for (let index = 0; index < 20; index += 1) {
      state.workers.set(`w${String(index)}`, { taskName: `w${String(index)}`, sessionId: `session-${String(index)}`, status: 'open', createdAt: index, updatedAt: index })
    }
    await Promise.all(Array.from({ length: 20 }, () => saveWorkers({ workersFile: file }, state)))
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.workers.length, 20)
  })
})
