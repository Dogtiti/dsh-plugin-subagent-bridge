import { readFileSync } from 'node:fs'

export const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** MCP protocol revisions this server understands, newest first. */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Largest JSON-RPC body accepted on the bridge endpoint. */

export const MAX_BODY_BYTES = 1024 * 1024

/** Longest a single tool call may block: the MCP client gives up at 300s. */

export const MAX_BLOCKING_SECONDS = 240

/** Worker records kept on disk; the oldest closed ones drop off first. */

export const MAX_PERSISTED_WORKERS = 200

/** Largest result body returned from one session read. */

export const MAX_RESULT_CHARS = 20000

/** Longest single long-poll wait, so an MCP client's own timeout stays in charge. */

export const MAX_WAIT_SECONDS = 55

/** Where a `codex` binary commonly lives when the Host's PATH is minimal. */

export const CLAUDE_CANDIDATES = [
  '~/.local/bin/claude',
  '~/.claude/local/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '~/.npm-global/bin/claude',
]

export const CODEX_CANDIDATES = [
  '~/Library/pnpm/bin/codex',
  '~/.local/bin/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '~/.npm-global/bin/codex',
]

export const ASSUMPTION_POLICY =
  '如果缺少必要信息或需要在多个方案里选择，直接采用最合理的默认做法继续做完，不要把选择权抛回给用户、不要调用 ask_user_question 等回答；在结果里用一行说明你假设了什么。'

/**
 * Attach the standing instruction when the deployment wants it.
 * @param settings - resolved settings.
 * @param message - caller-supplied text.
 * @returns the text to deliver.
 */
