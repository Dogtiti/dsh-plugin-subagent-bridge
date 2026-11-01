import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_CANDIDATES } from '../constants.js'
import { expandHome } from '../settings.js'
import { ok, text } from '../utils.js'

export function resolveClaude(configured) {
  const configuredValue = typeof configured === 'string' ? configured : ''
  /* An explicit path is authoritative: never silently run a different binary. */
  if (configuredValue.includes('/')) {
    const expanded = expandHome(configuredValue)
    return existsSync(expanded) ? expanded : undefined
  }
  for (const directory of String(process.env.PATH ?? '').split(':')) {
    if (directory !== '' && existsSync(join(directory, 'claude'))) return 'claude'
  }
  for (const candidate of CLAUDE_CANDIDATES) {
    const expanded = expandHome(candidate)
    if (existsSync(expanded)) return expanded
  }
  return undefined
}

/**
 * Run one `claude -p` turn and return its final answer.
 *
 * Claude Code prints a single JSON object in print mode, so the whole answer arrives at
 * once — unlike Codex, which streams events. Anything on stderr is advisory: the CLI
 * warns about an unrecognised model suffix while still succeeding, so only the JSON
 * envelope decides the outcome.
 * @param options - binary, prompt, cwd, resume id, model, timeout, signal, child registry.
 * @returns `{ ok, text, sessionId?, durationMs, exitCode, error? }`.
 */

export async function runClaude({
  bin,
  prompt,
  cwd,
  resume,
  model,
  timeoutMs,
  signal,
  children,
  spawnImpl = spawn,
}) {
  const started = Date.now()
  if (bin === undefined) {
    return { ok: false, text: '', exitCode: -1, durationMs: 0, error: 'claude executable not found; set config.claudeBin' }
  }
  const args = ['-p', prompt, '--output-format', 'json']
  if (typeof resume === 'string' && resume !== '') args.unshift('--resume', resume)
  if (typeof model === 'string' && model !== '') args.push('--model', model)

  const outcome = await new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(bin, args, { cwd: cwd ?? homedir(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ exitCode: -1, stdout: '', stderr: String(error), error: String(error) })
      return
    }
    children?.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
      children?.delete(child)
      resolve(value)
    }
    const kill = (reason) => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* Already gone. */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* Already gone. */
        }
      }, 5000).unref?.()
      finish({ exitCode: -1, stdout, stderr, error: reason })
    }
    const timer = setTimeout(() => kill(`claude timed out after ${timeoutMs} ms`), Math.max(1000, timeoutMs ?? 300000))
    const abort = () => kill('cancelled by the caller')
    if (signal?.aborted === true) abort()
    else signal?.addEventListener?.('abort', abort)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish({ exitCode: -1, stdout, stderr, error: error.message }))
    child.on('close', (code) => finish({ exitCode: code ?? -1, stdout, stderr }))
  })

  const parsed = parseClaudeOutput(outcome.stdout)
  const durationMs = Date.now() - started
  const build = (ok, error) => ({
    ok,
    text: parsed.text,
    exitCode: ok ? 0 : outcome.exitCode,
    durationMs,
    ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
    ...(error === undefined ? {} : { error }),
  })
  if (outcome.error !== undefined) return build(false, outcome.error)
  if (parsed.error !== undefined) return build(false, parsed.error)
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim().split('\n').slice(-3).join('\n')
    return build(false, `claude exited with ${outcome.exitCode}${detail === '' ? '' : `: ${detail}`}`)
  }
  return build(true, undefined)
}

/**
 * Read the print-mode JSON envelope.
 * @param stdout - raw standard output.
 * @returns `{ text, sessionId?, error? }`.
 */

export function parseClaudeOutput(stdout) {
  const raw = String(stdout ?? '').trim()
  if (raw === '') return { text: '', error: 'claude printed nothing' }
  /* A single object is the documented shape, but the CLI writes advisory lines to the
   * same stream, and those lines can carry braces of their own. Parse whole output first,
   * then scan lines backwards for the envelope that carries a result. */
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const candidates = [...lines].reverse()
  let payload
  let lastError
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
        payload = parsed
        break
      }
    } catch (error) {
      lastError = error
    }
  }
  if (payload === undefined) {
    if (lastError !== undefined) {
      return { text: '', error: `claude printed invalid JSON: ${String(lastError?.message ?? lastError)}` }
    }
    return { text: '', error: `claude printed no result envelope: ${raw.slice(0, 200)}` }
  }
  const text = typeof payload.result === 'string' ? payload.result.trim() : ''
  const sessionId = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : undefined
  const failed = payload.is_error === true || (typeof payload.subtype === 'string' && payload.subtype !== 'success')
  const build = {
    text,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (failed !== true) return build
  const detail =
    typeof payload.result === 'string' && payload.result.trim() !== ''
      ? payload.result.trim()
      : `claude reported ${String(payload.subtype ?? payload.terminal_reason ?? 'an error')}`
  return { ...build, error: detail }
}

/**
 * Read a file, tolerating absence.
 * @param path - file path.
 * @returns the text, or undefined.
 */
