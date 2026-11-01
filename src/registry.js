import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MAX_PERSISTED_WORKERS } from './constants.js'
import { text } from './utils.js'

export function saveWorkers(settings, state) {
  const records = [...state.workers.values()]
  if (records.length > MAX_PERSISTED_WORKERS) {
    const closed = records.filter((record) => record.status === 'closed').sort((left, right) => left.createdAt - right.createdAt)
    const open = records.filter((record) => record.status !== 'closed')
    const keep = Math.max(0, MAX_PERSISTED_WORKERS - open.length)
    for (const record of closed.slice(0, Math.max(0, closed.length - keep))) state.workers.delete(record.taskName)
  }
  const payload = {
    version: 1,
    workers: [...state.workers.values()],
    baselines: Object.fromEntries(state.baseline),
  }
  const write = async () => {
    try {
      await mkdir(dirname(settings.workersFile), { recursive: true, mode: 0o700 })
      await writeFile(settings.workersFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    } catch {
      /* Persistence is best effort: a failed write must not break a dispatch. */
    }
  }
  state.saving = (state.saving ?? Promise.resolve()).then(write, write)
  return state.saving
}

/**
 * Cache a terminal outcome so it survives a restart, and persist the change.
 * @param settings - resolved settings.
 * @param state - worker bookkeeping.
 * @param sessionId - worker session.
 * @param value - computed status; strings are transient and are not cached.
 */

export async function loadWorkers(settings, state) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(settings.workersFile, 'utf8'))
  } catch {
    return
  }
  for (const entry of Array.isArray(parsed?.workers) ? parsed.workers : []) {
    if (typeof entry?.taskName !== 'string' || typeof entry?.sessionId !== 'string') continue
    state.workers.set(entry.taskName, {
      taskName: entry.taskName,
      sessionId: entry.sessionId,
      status: entry.status === 'closed' ? 'closed' : 'open',
      /* Blocking tasks resume as non-counting records, exactly as they were written. */
      countsTowardLimit: entry.countsTowardLimit !== false,
      ...(typeof entry.root === 'string' ? { root: entry.root } : {}),
      createdAt: Number(entry.createdAt ?? Date.now()),
      updatedAt: Number(entry.updatedAt ?? Date.now()),
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    })
    state.dispatched.add(entry.sessionId)
  }
  for (const [sessionId, seq] of Object.entries(parsed?.baselines ?? {})) {
    const value = Number(seq)
    if (typeof sessionId === 'string' && Number.isFinite(value)) state.baseline.set(sessionId, value)
  }
}

/**
 * Persist the worker registry, serializing writes so two saves cannot interleave.
 * @param settings - resolved settings.
 * @param state - worker bookkeeping.
 * @returns a promise settling after the write attempt.
 */

export async function rememberOutcome(settings, state, sessionId, value) {
  if (typeof value === 'string') return
  for (const record of state.workers.values()) {
    if (record.sessionId !== sessionId || record.outcome !== undefined) continue
    record.outcome = value
    record.updatedAt = Date.now()
    await saveWorkers(settings, state)
    return
  }
}


/**
 * Resolve a worker reference (task name or session id) to its session.
 * @param state - worker bookkeeping.
 * @param reference - task name or session id.
 * @returns `{ sessionId, taskName?, record? }`, or undefined when unknown.
 */

export function resolveWorker(state, reference) {
  const record = state.workers.get(reference)
  if (record !== undefined) return { sessionId: record.sessionId, taskName: record.taskName, record }
  if (state.dispatched.has(reference)) return { sessionId: reference }
  for (const candidate of state.workers.values()) {
    if (candidate.sessionId === reference) return { sessionId: reference, taskName: candidate.taskName, record: candidate }
  }
  return undefined
}

/**
 * Refuse a new worker when the open ones already fill the limit.
 * @param state - worker bookkeeping.
 * @param settings - resolved settings.
 */

export function assertCapacity(state, settings, root) {
  const now = Date.now()
  let total = 0
  let inRoot = 0
  for (const record of state.workers.values()) {
    if (record.status === 'closed') continue
    if (record.countsTowardLimit === false) continue
    /* A record nobody has touched for a whole TTL stops holding a slot. */
    if (now - Number(record.updatedAt ?? record.createdAt ?? 0) > settings.workerTtlMs) continue
    total += 1
    if (record.root === root) inRoot += 1
  }
  if (inRoot >= settings.maxWorkersPerRoot) {
    throw new Error(
      `worker limit reached for ${root} (${settings.maxWorkersPerRoot}); close one with dsh_close before spawning another`,
    )
  }
  if (total >= settings.maxWorkers) {
    throw new Error(
      `global worker limit reached (${settings.maxWorkers}); close one with dsh_close before spawning another`,
    )
  }
}

/**
 * Validate a task name the way the tool description promises.
 * @param value - candidate name.
 * @returns the normalized name.
 */

export function requireTaskName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('task_name must be a non-empty string')
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (normalized === '') throw new Error('task_name must contain letters, digits, or underscores')
  return normalized
}

/**
 * The worker's final answer: the last assistant text produced after a sequence.
 * Progress prose from earlier steps stays out of the parent's context, matching how
 * a subagent's final message is the only thing delivered back.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - only count messages after this sequence.
 * @param settings - resolved settings.
 * @returns the final text plus whether it had to be truncated.
 */
