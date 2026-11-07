import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runChild } from '../src/runners/process.js'
import { runCodex } from '../src/runners/codex.js'
import { parseClaudeOutput, runClaude } from '../src/runners/claude.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  return child
}

for (const [label, run] of [['codex', runCodex], ['claude', runClaude]]) {
  test(`${label} does not spawn an already cancelled request`, async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const result = await run({ bin: '/fake', prompt: 'x', signal: controller.signal,
      spawnImpl: () => { calls++; return fakeChild() } })
    assert.equal(calls, 0)
    assert.match(result.error, /cancelled/)
  })

  test(`${label} waits for close before cancellation settles and removes tracking`, async () => {
    const child = fakeChild()
    const controller = new AbortController(), children = new Set()
    let spawned
    const ready = new Promise((resolve) => { spawned = resolve })
    let settled = false, outputPath
    const pending = run({ bin: '/fake', prompt: 'x', signal: controller.signal, children,
      spawnImpl: (_bin, args) => { outputPath = args[args.indexOf('-o') + 1]; spawned(); return child },
    }).then((value) => { settled = true; return value })
    await ready
    controller.abort()
    await delay(10)
    assert.equal(settled, false)
    assert.equal(children.has(child), true)
    child.emit('close', null)
    assert.match((await pending).error, /cancelled/)
    assert.equal(children.size, 0)
    if (label === 'codex') await assert.rejects(readFile(outputPath), { code: 'ENOENT' })
  })
}

test('cancellation waits for descendants after the direct child closes', { skip: process.platform === 'win32' }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const child = fakeChild(); child.pid = 4242
  const children = new Set(), controller = new AbortController(), signals = []
  let exists = true, settled = false
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -4242)
    signals.push(signal)
    if (!exists) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (signal === 'SIGTERM') child.emit('close', null)
    if (signal === 'SIGKILL') exists = false
    return true
  })
  const pending = runChild({ bin: '/fake', args: [], signal: controller.signal, children,
    spawnImpl: () => child, label: 'dummy' }).then((result) => { settled = true; return result })
  controller.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(children.has(child), true)
  t.mock.timers.tick(5000)
  assert.match((await pending).error, /cancelled/)
  assert.ok(signals.includes('SIGKILL'))
  assert.equal(children.size, 0)
})

test('unconfirmed termination warns, retains tracking, and later close clears it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const child = fakeChild(), children = new Set(), controller = new AbortController()
  const signals = []
  child.kill = (signal) => { signals.push(signal); return true }
  const pending = runChild({ bin: '/fake', args: [], signal: controller.signal, children,
    spawnImpl: () => child, label: 'dummy' })
  controller.abort()
  t.mock.timers.tick(10000)
  const result = await pending
  assert.match(result.terminationWarning, /termination could not be confirmed/)
  assert.equal(children.has(child), true)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  child.emit('close', null)
  assert.equal(children.size, 0)
})

test('plugin termination uses the shared cancellation lifecycle', async () => {
  const child = fakeChild(), children = new Set()
  const pending = runChild({ bin: '/fake', args: [], children, spawnImpl: () => child, label: 'dummy' })
  child.bridgeTerminate()
  assert.equal(children.has(child), true)
  child.emit('close', null)
  assert.match((await pending).error, /plugin stopped/)
  assert.equal(children.size, 0)
})

test('spawn errors settle without retaining children', async () => {
  const children = new Set()
  const thrown = await runChild({ bin: '/fake', args: [], children, label: 'dummy',
    spawnImpl: () => { throw new Error('spawn failed') } })
  assert.match(thrown.error, /spawn failed/)
  const child = fakeChild()
  const pending = runChild({ bin: '/fake', args: [], children, label: 'dummy', spawnImpl: () => child })
  child.emit('error', new Error('ENOENT'))
  assert.match((await pending).error, /ENOENT/)
  assert.equal(children.size, 0)
})

test('Claude accepts whole JSON and requires a valid result or error envelope', () => {
  assert.equal(parseClaudeOutput(JSON.stringify({ type: 'result', result: 'pretty' }, null, 2)).text, 'pretty')
  assert.match(parseClaudeOutput('{"type":"result","subtype":"success"}').error, /no result envelope/)
  assert.match(parseClaudeOutput('{"type":"result","result":42}').error, /no result envelope/)
  assert.match(parseClaudeOutput('{"type":"system"}\n{"type":"system"}').error, /no result envelope/)
  assert.equal(parseClaudeOutput('{"type":"result","result":"answer"}\n{"type":"system"}').text, 'answer')
  assert.match(parseClaudeOutput('{"type":"result","is_error":true}').error, /reported/)
  assert.match(parseClaudeOutput('{"type":"result","subtype":"error_max_turns"}').error, /error_max_turns/)
})

for (const ignoreTerm of [false, true]) {
  test(`dummy CLI process group is stopped${ignoreTerm ? ' with SIGKILL escalation' : ''}`, { skip: process.platform === 'win32' }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-runner-test-'))
    const marker = join(dir, 'survived')
    let child
    t.after(async () => {
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone. */ }
      }
      await rm(dir, { recursive: true, force: true })
    })
    // Both programs are local inert Node snippets; no model CLI or sockets are used.
    const ignore = ignoreTerm ? "process.on('SIGTERM', () => {});" : ''
    const grandchild = `${ignore}setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'); process.exit(0) }, ${ignoreTerm ? 7000 : 1800})`
    const wrapper = `${ignore}require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); setTimeout(() => process.exit(0), 9000)`
    const children = new Set()
    const result = await runCodex({ bin: '/fake', prompt: 'dummy', timeoutMs: 1000, children,
      spawnImpl: (_bin, _args, options) => { child = spawn(process.execPath, ['-e', wrapper], options); return child },
    })
    assert.match(result.error, /timed out/)
    assert.doesNotMatch(result.error, /could not|unavailable/)
    assert.equal(children.size, 0)
    await delay(ignoreTerm ? 1300 : 1100)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  })
}
