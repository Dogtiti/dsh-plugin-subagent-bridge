import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_CANDIDATES } from '../constants.js'
import { expandHome } from '../settings.js'
import { ok, text } from '../utils.js'
import { runChild } from './process.js'

export function resolveCodex(configured) {
  const configuredValue = typeof configured === 'string' ? configured : ''
  /* An explicit path is authoritative: never silently run a different binary. */
  if (configuredValue.includes('/')) {
    const expanded = expandHome(configuredValue)
    return existsSync(expanded) ? expanded : undefined
  }
  for (const directory of String(process.env.PATH ?? '').split(':')) {
    if (directory !== '' && existsSync(join(directory, 'codex'))) return 'codex'
  }
  for (const candidate of CODEX_CANDIDATES) {
    const expanded = expandHome(candidate)
    if (existsSync(expanded)) return expanded
  }
  return undefined
}


/**
 * Locate the Claude Code executable.
 * @param configured - configured path or bare command name.
 * @returns the command to spawn, or undefined.
 */

export async function runCodex({
  bin,
  prompt,
  cwd,
  resume,
  sandbox,
  timeoutMs,
  signal,
  children,
  spawnImpl = spawn,
}) {
  const started = Date.now()
  if (bin === undefined) {
    return { ok: false, text: '', exitCode: -1, durationMs: 0, error: 'codex executable not found; set config.codexBin' }
  }
  const temp = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
  const outFile = join(temp, 'last-message.txt')
  const resuming = resume !== undefined
  const args = ['exec']
  if (resuming) args.push('resume', resume)
  args.push('--json', '--skip-git-repo-check', '-o', outFile)
  /* `codex exec resume` takes neither --sandbox nor --cd: the thread keeps its own. */
  if (!resuming) {
    args.push('-s', sandbox === undefined ? 'workspace-write' : sandbox)
    if (typeof cwd === 'string' && cwd !== '') args.push('-C', cwd)
  }
  args.push(prompt)

  try {
    const outcome = await runChild({ bin, args, cwd, timeoutMs, signal, children, spawnImpl, label: 'codex' })

    const parsed = parseCodexOutput(outcome.stdout, await readIfExists(outFile))
    const durationMs = Date.now() - started
    /* A resumed run emits no thread.started, so every field stays optional: a tool
     * result must be lossless JSON, and `undefined` is not. */
    const build = (ok, error) => ({
      ok,
      text: parsed.text,
      exitCode: ok ? 0 : outcome.exitCode,
      durationMs,
      ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
      ...(error === undefined ? {} : { error }),
    })
    if (outcome.error !== undefined) return build(false, `${outcome.error}${outcome.terminationWarning === undefined ? '' : `; ${outcome.terminationWarning}`}`)
    if (outcome.exitCode !== 0) {
      const detail = parsed.error ?? outcome.stderr.trim().split('\n').slice(-3).join('\n')
      return build(false, `codex exited with ${outcome.exitCode}${detail === '' ? '' : `: ${detail}`}`)
    }
    return build(true, undefined)
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Parse `codex exec --json` output.
 * @param stdout - JSONL event stream.
 * @param lastMessage - contents of the `-o` file, when written.
 * @returns `{ text, threadId, error }`.
 */

export function parseCodexOutput(stdout, lastMessage) {
  let threadId
  let error
  const messages = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      messages.push(event.item.text)
    }
    if (event.type === 'error' && typeof event.message === 'string') error = event.message
    if (event.type === 'turn.failed' && typeof event.error?.message === 'string') error = event.error.message
  }
  const text = typeof lastMessage === 'string' && lastMessage.trim() !== '' ? lastMessage.trim() : messages.join('\n\n').trim()
  return { text, ...(threadId === undefined ? {} : { threadId }), ...(error === undefined ? {} : { error }) }
}

/**
 * Find the `codex` executable.
 * @param configured - configured binary name or path.
 * @returns the path to use, or undefined when nothing resolves.
 */

export async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read one session title without letting a missing service break the listing.
 * @param service - optional title service.
 * @param session - live session.
 * @returns the title, when one exists.
 */
