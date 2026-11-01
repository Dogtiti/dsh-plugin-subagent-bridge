/**
 * Agent bridge: a loopback MCP endpoint inside the DSH Host, plus the reverse tools.
 *
 * Inbound (MCP, for Codex or any MCP client): list session metadata, hand a message to
 * a session, and long-poll for the assistant text produced after that dispatch. The
 * bridge never reads a session it did not dispatch to.
 *
 * Outbound (DSH tools): `codex_dispatch` and `claude_dispatch` run the other agent's CLI and
 * return its answer, so a DSH agent can hand work out the same way.
 *
 * Nothing here reads DSH's own credentials: this runs in-process and uses the public
 * `sessionController` service, so it needs no cookie and no signing secret.
 *
 * The implementation lives in `src/`; this file wires it up and re-exports the pieces the
 * tests exercise directly.
 */
import { createApi } from './src/api.js'
import { createBridgeServer, loadOrCreateToken, writeEndpointFile } from './src/http.js'
import { loadWorkers } from './src/registry.js'
import { resolveSettings } from './src/settings.js'
import { ok, text } from './src/utils.js'

export const name = 'subagent-bridge'

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  if (settings.enabled !== true) return

  const state = { dispatched: new Set(), children: new Set(), openQuestions: new Map(), questionAnswerers: new Map() }
  const api = createApi(ctx, state, settings)
  let bridge

  ctx.effect(() => {
    void (async () => {
      const token = await loadOrCreateToken(settings.endpointFile)
      await loadWorkers(settings, state)
      bridge = createBridgeServer({ api, token, port: settings.port })
      await bridge.listen()
      await writeEndpointFile(settings.endpointFile, {
        url: bridge.url,
        port: bridge.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })
      ctx.logger?.info?.(`subagent-bridge: MCP endpoint on http://127.0.0.1:${bridge.port}/mcp`)
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`subagent-bridge: could not start on port ${settings.port}: ${message}`)
      void writeEndpointFile(settings.endpointFile, {
        error: message,
        port: settings.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }).catch(() => {})
    })
    return () => {
      if (bridge !== undefined) void bridge.close()
      for (const child of state.children) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* Already gone. */
        }
      }
      state.children.clear()
    }
  }, 'subagent-bridge: mcp endpoint')

  /* Reverse direction: agents of this deployment get a tool that drives Codex. */
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'codex_dispatch',
          description:
            'Hand a task to Codex (a separate coding agent) and return its final answer. Runs `codex exec` in the working directory; use `resume` with a previous threadId to continue that thread.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task text for Codex.' },
              cwd: { type: 'string', description: 'Working directory. Defaults to this session working directory.' },
              resume: { type: 'string', description: 'Codex thread id to continue instead of starting a new thread.' },
              sandbox: {
                type: 'string',
                enum: ['read-only', 'workspace-write', 'danger-full-access'],
                description: 'Sandbox for this run. Defaults to the plugin config.',
              },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                text: { type: 'string' },
                threadId: { type: 'string' },
                exitCode: { type: 'number' },
                durationMs: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['ok', 'text'],
              additionalProperties: false,
            },
            render(_args, value) {
              const result = value ?? {}
              if (result.ok !== true) {
                return [{ type: 'text', text: `codex_dispatch 失败：${String(result.error ?? '未知错误')}` }]
              }
              const meta = [
                typeof result.threadId === 'string' ? `thread ${result.threadId}` : undefined,
                typeof result.durationMs === 'number' ? `${Math.round(result.durationMs / 1000)}s` : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(' · ')
              const body = String(result.text ?? '')
              return [{ type: 'text', text: meta === '' ? body : `${body}\n\n[codex ${meta}]` }]
            },
          },
          timeoutMs: settings.codexTimeoutMs + 15000,
          isConcurrencySafe: () => false,
          execute: (args, exec) => api.dispatchCodex(args, exec),
        }),
      'subagent-bridge: codex tool',
    )
  })

  /* Reverse direction for Claude Code: the same shape, a different CLI. */
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'claude_dispatch',
          description:
            'Hand a task to Claude Code (a separate coding agent) and return its final answer. Runs `claude -p` in the working directory; use `resume` with a previous sessionId to continue that conversation.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task text for Claude Code.' },
              cwd: { type: 'string', description: 'Working directory. Defaults to this session working directory.' },
              resume: { type: 'string', description: 'Claude Code session id to continue instead of starting a new one.' },
              model: { type: 'string', description: 'Model alias or id for this run. Defaults to the plugin config, then to Claude Code own settings.' },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                text: { type: 'string' },
                sessionId: { type: 'string' },
                exitCode: { type: 'number' },
                durationMs: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['ok', 'text'],
              additionalProperties: false,
            },
            render(_args, value) {
              const result = value ?? {}
              if (result.ok !== true) {
                return [{ type: 'text', text: `claude_dispatch failed: ${String(result.error ?? 'unknown error')}` }]
              }
              const meta = [
                typeof result.sessionId === 'string' ? `session ${result.sessionId}` : undefined,
                typeof result.durationMs === 'number' ? `${Math.round(result.durationMs / 1000)}s` : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(' · ')
              const body = String(result.text ?? '')
              return [{ type: 'text', text: meta === '' ? body : `${body}\n\n[claude ${meta}]` }]
            },
          },
          timeoutMs: settings.claudeTimeoutMs + 15000,
          isConcurrencySafe: () => false,
          execute: (args, exec) => api.dispatchClaude(args, exec),
        }),
      'subagent-bridge: claude tool',
    )
  })
}

/**
 * Bind the HTTP listener.
 * @param options - api, token, host and port.
 * @returns listen/close helpers plus the resolved port and URL.
 */

export { createApi } from './src/api.js'
export { ambientDepth, enterChain, leaveChain } from './src/guards.js'
export { createBridgeServer, handleJsonRpc } from './src/http.js'
export { pendingQuestion } from './src/questions.js'
export { saveWorkers, loadWorkers } from './src/registry.js'
export { parseClaudeOutput, resolveClaude, runClaude } from './src/runners/claude.js'
export { parseCodexOutput, resolveCodex, runCodex } from './src/runners/codex.js'
