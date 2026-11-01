import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_BLOCKING_SECONDS, MAX_RESULT_CHARS, MAX_WAIT_SECONDS } from './constants.js'

export const DEFAULTS = {
  enabled: true,
  port: 47821,
  endpointFile: join(homedir(), '.dsh', 'bridge', 'endpoint.json'),
  maxResultChars: MAX_RESULT_CHARS,
  readWaitSeconds: 45,
  codexBin: 'codex',
  codexSandbox: 'workspace-write',
  codexTimeoutMs: 300000,
  assumeDefaults: true,
  assumptionPolicy: '',
  claudeBin: 'claude',
  claudeModel: '',
  claudeTimeoutMs: 300000,
  taskTimeoutSeconds: MAX_BLOCKING_SECONDS,
  waitTimeoutMs: MAX_BLOCKING_SECONDS * 1000,
  maxWorkers: 12,
  maxWorkersPerRoot: 4,
  workerTtlMs: 24 * 60 * 60 * 1000,
  maxHops: 1,
  dispatchPerMinute: 10,
  dispatchWindowMs: 60000,
  workersFile: join(homedir(), '.dsh', 'bridge', 'workers.json'),
}

/** MCP tools advertised to clients. */

export function resolveSettings(config) {
  const merged = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === 'port') {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0 && port < 65536) merged.port = port
      continue
    }
    if (key === 'enabled') {
      merged.enabled = value === true || value === 'true'
      continue
    }
    if (key === 'endpointFile' && typeof value === 'string' && value !== '') merged.endpointFile = expandHome(value)
    if (key === 'maxResultChars') {
      const chars = Number(value)
      if (Number.isFinite(chars) && chars > 0) merged.maxResultChars = chars
    }
    if (key === 'readWaitSeconds') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) merged.readWaitSeconds = Math.min(MAX_WAIT_SECONDS, seconds)
    }
    if (key === 'codexBin' && typeof value === 'string' && value !== '') merged.codexBin = value
    if (key === 'codexSandbox' && typeof value === 'string' && value !== '') merged.codexSandbox = value
    if (key === 'assumeDefaults') {
      merged.assumeDefaults = value === true || value === 'true'
      continue
    }
    if (key === 'assumptionPolicy' && typeof value === 'string') {
      merged.assumptionPolicy = value.trim()
      continue
    }
    if (key === 'claudeBin' && typeof value === 'string' && value !== '') merged.claudeBin = value
    if (key === 'claudeModel' && typeof value === 'string') merged.claudeModel = value
    if (key === 'workersFile' && typeof value === 'string' && value !== '') merged.workersFile = expandHome(value)
    if (key === 'maxHops') {
      const hops = Number(value)
      if (Number.isInteger(hops) && hops >= 0) merged.maxHops = hops
    }
    if (key === 'dispatchPerMinute') {
      const count = Number(value)
      if (Number.isInteger(count) && count > 0) merged.dispatchPerMinute = count
    }
    if (key === 'dispatchWindowMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms > 0) merged.dispatchWindowMs = ms
    }
    if (key === 'maxWorkersPerRoot') {
      const count = Number(value)
      if (Number.isInteger(count) && count > 0) merged.maxWorkersPerRoot = count
    }
    if (key === 'workerTtlMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms > 0) merged.workerTtlMs = ms
    }
    if (key === 'maxWorkers') {
      const count = Number(value)
      if (Number.isInteger(count) && count > 0) merged.maxWorkers = count
    }
    if (key === 'waitTimeoutMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms > 0) merged.waitTimeoutMs = Math.min(MAX_BLOCKING_SECONDS * 1000, Math.max(1000, ms))
    }
    if (key === 'taskTimeoutSeconds') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) merged.taskTimeoutSeconds = Math.min(MAX_BLOCKING_SECONDS, seconds)
    }
    if (key === 'claudeTimeoutMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms >= 1000) merged.claudeTimeoutMs = Math.min(ms, MAX_BLOCKING_SECONDS * 1000)
      continue
    }
    if (key === 'codexTimeoutMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms > 0) merged.codexTimeoutMs = ms
    }
  }
  return merged
}

/**
 * Expand a leading `~`.
 * @param path - configured path.
 * @returns the absolute path.
 */

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
