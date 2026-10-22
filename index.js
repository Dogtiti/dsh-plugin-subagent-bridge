/**
 * Agent bridge: a loopback MCP endpoint inside the DSH Host, plus the reverse tools.
 *
 * Inbound (MCP, for Codex or any MCP client): list session metadata, hand a message to
 * a session, and long-poll for the assistant text produced after that dispatch. The
 * bridge never reads a session it did not dispatch to.
 *
 * Outbound (DSH tools): `codex_dispatch` runs `codex exec` and returns the answer, so a
 * DSH agent can hand work to Codex the same way.
 *
 * Nothing here reads DSH's own credentials: this runs in-process and uses the public
 * `sessionController` service, so it needs no cookie and no signing secret.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'subagent-bridge'

/** Version advertised in the MCP handshake, read from the manifest so it cannot drift. */
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** MCP protocol revisions this server understands, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Largest JSON-RPC body accepted on the bridge endpoint. */
const MAX_BODY_BYTES = 1024 * 1024

/** Worker records kept on disk; the oldest closed ones drop off first. */
const MAX_PERSISTED_WORKERS = 200

/** Largest result body returned from one session read. */
const MAX_RESULT_CHARS = 20000

/** Longest single long-poll wait, so an MCP client's own timeout stays in charge. */
const MAX_WAIT_SECONDS = 55

/** Where a `codex` binary commonly lives when the Host's PATH is minimal. */
const CODEX_CANDIDATES = [
  '~/Library/pnpm/bin/codex',
  '~/.local/bin/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '~/.npm-global/bin/codex',
]

const DEFAULTS = {
  enabled: true,
  port: 47821,
  endpointFile: join(homedir(), '.dsh', 'bridge', 'endpoint.json'),
  maxResultChars: MAX_RESULT_CHARS,
  readWaitSeconds: 25,
  codexBin: 'codex',
  codexSandbox: 'workspace-write',
  codexTimeoutMs: 300000,
  taskTimeoutSeconds: 300,
  waitTimeoutMs: 30000,
  maxWorkers: 4,
  maxHops: 1,
  dispatchPerMinute: 10,
  dispatchWindowMs: 60000,
  workersFile: join(homedir(), '.dsh', 'bridge', 'workers.json'),
}

/** MCP tools advertised to clients. */
const TOOLS = [
  {
    name: 'dsh_task',
    description:
      'Delegate one self-contained task to DeepSeek Harness and wait for the finished answer, exactly like spawning a subagent: the bridge opens a fresh DSH session in `cwd`, delivers the task, blocks until that turn ends, and returns the answer. Use this for real work delegation; no session id is needed. The prompt is delivered verbatim as an ordinary user message in that session, so write it as a work order for a colleague: do not mention your own tools, skills, or role framing — the worker has no such skill and will only waste a turn looking for it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Self-contained task for the DSH worker, including acceptance criteria.' },
        cwd: { type: 'string', description: 'Working directory the worker runs in. Defaults to the DSH default directory.' },
        sessionId: {
          type: 'string',
          description: 'Continue an existing idle session (multi-turn worker) instead of opening a new one.',
        },
        agentPreset: { type: 'string', description: 'Agent preset for a new session.' },
        timeoutSeconds: { type: 'number', description: 'How long to wait for the turn to finish. Default 300, max 600.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_spawn',
    description:
      'Start a worker and return immediately with its task_name, so several workers can run in parallel; collect answers with dsh_wait. Use fork_turns "all" with `from` to start the worker from a copy of an existing DSH session instead of an empty one.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: { type: 'string', description: 'Lowercase letters, digits, and underscores.' },
        message: { type: 'string', description: 'Self-contained work order for the worker.' },
        fork_turns: {
          type: 'string',
          enum: ['none', 'all'],
          description: 'none starts empty (default); all forks the session named by `from`.',
        },
        from: { type: 'string', description: 'Session id to fork when fork_turns is "all".' },
        cwd: { type: 'string', description: 'Working directory for a fresh worker.' },
      },
      required: ['task_name', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_followup',
    description:
      'Give an existing worker another task and trigger a turn. The worker keeps its own conversation, so this is cheaper than spawning a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'task_name from dsh_spawn, or a session id.' },
        message: { type: 'string', description: 'Follow-up work order.' },
      },
      required: ['worker', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_close',
    description:
      'Close a worker and free its concurrency slot. Finished workers still count against the limit until closed. Closing does not delete the session.',
    inputSchema: {
      type: 'object',
      properties: { worker: { type: 'string', description: 'task_name or session id.' } },
      required: ['worker'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_workers',
    description: 'List the workers this bridge started, with their task_name, session id, and live status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsh_dispatch',
    description:
      'Deliver one message into a DeepSeek Harness session as the user and start a turn. Returns the request id and the session event sequence at dispatch time; pass that sequence to dsh_read_result to collect the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target DSH session id, from dsh_list_sessions.' },
        text: { type: 'string', description: 'Message text to deliver.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue delivers as the next user turn; steer adds it to a running turn. Defaults to queue.',
        },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description:
      'Wait until any of the given workers reaches a final state, then return per-worker status. A finished worker carries its final answer only. Prefer long waits over polling.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids returned by dsh_task or dsh_dispatch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Wait timeout in milliseconds. Default 30000, min 1000, max 3600000.',
        },
      },
      required: ['targets'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_result',
    description:
      'Long-poll one session for assistant text produced after the given event sequence. Returns as soon as text appears, when the turn ends, or when the wait expires. Only sessions this bridge dispatched to are readable.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by dsh_dispatch.' },
        sinceSeq: { type: 'number', description: 'The seqAtDispatch value returned by dsh_dispatch.' },
        waitSeconds: {
          type: 'number',
          description: `How long to wait for the answer, at most ${MAX_WAIT_SECONDS}. Defaults to the plugin config.`,
        },
      },
      required: ['sessionId', 'sinceSeq'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_sessions',
    description:
      'List DeepSeek Harness sessions with metadata only: id, title, working directory, running state, and last activity. Never returns message content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/**
 * Start the bridge.
 * @param ctx - Host context.
 * @param config - row configuration from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  if (settings.enabled !== true) return

  const state = { dispatched: new Set(), children: new Set() }
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
}

/**
 * Bind the HTTP listener.
 * @param options - api, token, host and port.
 * @returns listen/close helpers plus the resolved port and URL.
 */
export function createBridgeServer({ api, token, host = '127.0.0.1', port }) {
  const handler = createHandler(api, token)
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  const bound = () => server.address()?.port ?? port
  return {
    get port() {
      return bound()
    },
    get url() {
      return `http://${host}:${bound()}/mcp/${token}`
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          resolve()
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Build the node request handler.
 * @param api - bridge operations.
 * @param token - capability token; every request must carry it.
 * @returns a node request handler.
 */
export function createHandler(api, token) {
  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!authorized(request, url, token)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }

    if (request.method === 'GET') {
      /* No server-initiated stream in this version. */
      response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      response.end('method not allowed')
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }

    let body
    try {
      body = await readBody(request)
    } catch (error) {
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(error instanceof Error ? error.message : 'body too large')
      return
    }

    let message
    try {
      message = JSON.parse(body)
    } catch {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(errorResponse(null, -32700, 'parse error')))
      return
    }

    /* A long-poll read must stop waiting when the client hangs up. */
    const controller = new AbortController()
    request.on('close', () => controller.abort())

    const reply = await handleJsonRpc(message, api, { signal: controller.signal })
    if (reply === null) {
      response.writeHead(202).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(reply))
  }
}

/**
 * Handle one JSON-RPC message.
 * @param message - parsed request or notification.
 * @param api - bridge operations.
 * @param options - caller cancellation.
 * @returns the response, or null for a notification.
 */
export async function handleJsonRpc(message, api, options = {}) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return errorResponse(null, -32600, 'invalid request')
  }
  const { id, method, params } = message
  if (typeof method !== 'string') return errorResponse(id ?? null, -32600, 'invalid request')
  if (id === undefined || id === null) return null

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-subagent-bridge', version: PACKAGE_VERSION },
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call':
      return callTool(id, params, api, options.signal)
    default:
      return errorResponse(id, -32601, `unknown method ${JSON.stringify(method)}`)
  }
}

/**
 * Run one MCP tool call.
 * @param id - JSON-RPC id.
 * @param params - `{ name, arguments }`.
 * @param api - bridge operations.
 * @param signal - caller cancellation.
 * @returns the JSON-RPC response; tool failures travel inside `isError`.
 */
async function callTool(id, params, api, signal) {
  const toolName = params?.name
  const args = params?.arguments ?? {}
  try {
    switch (toolName) {
      case 'dsh_list_sessions':
        return ok(id, text(await api.listSessions()))
      case 'dsh_spawn': {
        const taskName = requireTaskName(args.task_name)
        const message = requireString(args.message, 'message')
        const forkTurns = args.fork_turns === 'all' ? 'all' : 'none'
        if (forkTurns === 'all' && (typeof args.from !== 'string' || args.from === '')) {
          throw new Error('from is required when fork_turns is "all"')
        }
        return ok(id, text(await api.spawn({ taskName, message, forkTurns, from: args.from, cwd: args.cwd })))
      }
      case 'dsh_followup': {
        const worker = requireString(args.worker, 'worker')
        const message = requireString(args.message, 'message')
        return ok(id, text(await api.followup({ worker, message })))
      }
      case 'dsh_close': {
        const worker = requireString(args.worker, 'worker')
        return ok(id, text(await api.close({ worker })))
      }
      case 'dsh_list_workers':
        return ok(id, text(await api.listWorkers()))
      case 'dsh_wait': {
        if (!Array.isArray(args.targets) || args.targets.length === 0) throw new Error('targets must be a non-empty array')
        const targets = args.targets.map((target, index) => requireString(target, `targets[${index}]`))
        const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs)
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new Error('timeoutMs must be a positive number')
        }
        return ok(id, text(await api.wait({ targets, timeoutMs })))
      }
      case 'dsh_task': {
        const prompt = requireString(args.prompt, 'prompt')
        const sessionId = args.sessionId === undefined ? undefined : requireString(args.sessionId, 'sessionId')
        const timeoutSeconds = args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds)
        if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
          throw new Error('timeoutSeconds must be a positive number')
        }
        return ok(
          id,
          text(
            await api.task({
              prompt,
              cwd: typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined,
              sessionId,
              agentPreset: typeof args.agentPreset === 'string' && args.agentPreset !== '' ? args.agentPreset : undefined,
              timeoutSeconds,
            }),
          ),
        )
      }
      case 'dsh_dispatch': {
        const sessionId = requireString(args.sessionId, 'sessionId')
        const message = requireString(args.text, 'text')
        const mode = args.mode === 'steer' ? 'steer' : 'queue'
        return ok(id, text(await api.dispatch({ sessionId, text: message, mode })))
      }
      case 'dsh_read_result': {
        const sessionId = requireString(args.sessionId, 'sessionId')
        const sinceSeq = Number(args.sinceSeq)
        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) throw new Error('sinceSeq must be a non-negative number')
        const waitSeconds = args.waitSeconds === undefined ? undefined : Number(args.waitSeconds)
        if (waitSeconds !== undefined && (!Number.isFinite(waitSeconds) || waitSeconds < 0)) {
          throw new Error('waitSeconds must be a non-negative number')
        }
        return ok(id, text(await api.readResult({ sessionId, sinceSeq, waitSeconds, signal })))
      }
      default:
        return errorResponse(id, -32602, `unknown tool ${JSON.stringify(toolName)}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return ok(id, { content: [{ type: 'text', text: message }], isError: true })
  }
}

/**
 * Build the bridge operations over live Host services.
 * @param ctx - Host context.
 * @param state - dispatch bookkeeping and running children.
 * @param settings - resolved settings.
 * @returns the api used by tool calls.
 */
export function createApi(ctx, state, settings) {
  /* Callers may hand in a bare bookkeeping object; fill in what the api needs. */
  state.dispatched = state.dispatched ?? new Set()
  state.baseline = state.baseline ?? new Map()
  state.workers = state.workers ?? new Map()
  state.chain = state.chain ?? { depth: 0, active: 0, until: 0 }
  state.recent = state.recent ?? []
  const controller = () => ctx.get('sessionController')
  const sessions = () => ctx.get('sessions')

  return {
    async listSessions() {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      /* The service answers `{ items }`; older shapes returned the array itself. */
      const listed = await service.list({}, undefined)
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
      const titleService = ctx.get('sessionTitle')
      return items.map((item) => {
        /* A live session folds its title from the log; cold rows simply have none. */
        const live = sessions()?.get?.(item.sessionId)
        const derived = live === undefined || live === null ? undefined : safeTitle(titleService, live)
        const title = typeof item.title === 'string' ? item.title : derived
        return {
          sessionId: item.sessionId,
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
          running: item.running === true,
          blank: item.blank === true,
          updatedAt: item.updatedAt ?? null,
        }
      })
    },

    async spawn({ taskName, message, forkTurns, from, cwd }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      if (state.workers.has(taskName)) throw new Error(`task_name ${JSON.stringify(taskName)} is already in use`)
      guardDepth(state, settings, 0, 'dsh_spawn')
      takeDispatchSlot(state, settings)
      assertCapacity(state, settings)

      let sessionId
      if (forkTurns === 'all') {
        const parent = sessions()?.get?.(from)
        if (parent === undefined || parent === null) {
          /* Forking a cold session is fine: the controller reads it from storage. */
        }
        const forked = await service.fork({ sessionId: from })
        sessionId = forked?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') throw new Error('forking returned no session id')
      } else {
        const opened = await service.create(cwd === undefined ? {} : { cwd })
        sessionId = opened?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session controller did not return a session id')
      }

      const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
      const requestId = randomUUID()
      const accepted = await service.prompt(
        { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: message }] },
        AbortSignal.timeout(30000),
      )
      state.dispatched.add(sessionId)
      state.baseline.set(sessionId, before)
      state.workers.set(taskName, { taskName, sessionId, status: 'open', countsTowardLimit: true, createdAt: Date.now(), updatedAt: Date.now() })
      await saveWorkers(settings, state)
      return { task_name: taskName, sessionId, accepted: accepted?.accepted === true, fork_turns: forkTurns }
    },

    async followup({ worker, message }) {
      const target = resolveWorker(state, worker)
      if (target === undefined) throw new Error(`unknown worker ${JSON.stringify(worker)}`)
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      takeDispatchSlot(state, settings)
      const before = Number(sessions()?.get?.(target.sessionId)?.seq ?? 0)
      const requestId = randomUUID()
      const accepted = await service.prompt(
        { sessionId: target.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: message }] },
        AbortSignal.timeout(30000),
      )
      state.baseline.set(target.sessionId, before)
      if (target.record !== undefined) {
        /* A new turn invalidates the cached answer. */
        delete target.record.outcome
        target.record.updatedAt = Date.now()
      }
      await saveWorkers(settings, state)
      return { worker: target.taskName ?? target.sessionId, sessionId: target.sessionId, accepted: accepted?.accepted === true }
    },

    async close({ worker }) {
      const target = resolveWorker(state, worker)
      if (target === undefined) throw new Error(`unknown worker ${JSON.stringify(worker)}`)
      if (target.record !== undefined) {
        target.record.status = 'closed'
        target.record.updatedAt = Date.now()
        await saveWorkers(settings, state)
      }
      return { worker: target.taskName ?? target.sessionId, sessionId: target.sessionId, status: 'closed' }
    },

    async listWorkers() {
      const rows = []
      for (const record of state.workers.values()) {
        const status = record.status === 'closed' ? 'closed' : workerStatus(ctx, record.sessionId, state, settings)
        if (record.status !== 'closed') await rememberOutcome(settings, state, record.sessionId, status)
        rows.push({ task_name: record.taskName, sessionId: record.sessionId, status })
      }
      return rows
    },

    async task({ prompt, cwd, sessionId, agentPreset, timeoutSeconds }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      const seconds = Math.min(600, Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : settings.taskTimeoutSeconds))
      guardDepth(state, settings, 0, 'dsh_task')
      takeDispatchSlot(state, settings)
      const started = Date.now()

      let targetId = sessionId
      let created = false
      if (targetId === undefined) {
        const opened = await service.create(cwd === undefined ? {} : { cwd })
        targetId = opened?.sessionId
        if (typeof targetId !== 'string' || targetId === '') throw new Error('session controller did not return a session id')
        created = true
      } else if (ctx.get('agents')?.get?.(targetId)?.status === 'running') {
        throw new Error('that session is running; use dsh_dispatch plus dsh_read_result instead')
      }

      const turnBefore = lastTurn(ctx, targetId)
      const before = Number(sessions()?.get?.(targetId)?.seq ?? 0)
      const finished = waitForTurnEnd(ctx, targetId, turnBefore, seconds * 1000)
      const requestId = randomUUID()
      const accepted = await service.prompt(
        { sessionId: targetId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] },
        AbortSignal.timeout(30000),
      )
      state.dispatched.add(targetId)
      state.baseline.set(targetId, before)
      /* A blocking task is not a spawned worker: it is recorded for later lookup but
       * must not consume one of the concurrency slots. */
      const implicitName = `task_${targetId.slice('session-'.length, 'session-'.length + 8)}`
      if (!state.workers.has(implicitName)) {
        state.workers.set(implicitName, {
          taskName: implicitName,
          sessionId: targetId,
          status: 'open',
          countsTowardLimit: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await saveWorkers(settings, state)
      }

      const end = await finished
      const collected = finalAnswer(ctx, targetId, before, settings)
      const turnReason = end?.reason?.kind ?? null
      const durationMs = Date.now() - started
      return {
        sessionId: targetId,
        created,
        status: end === undefined ? 'timeout' : turnReason === 'completed' ? 'completed' : `turn-${String(turnReason)}`,
        text: collected.text,
        truncated: collected.truncated,
        turns: lastTurn(ctx, targetId),
        accepted: accepted?.accepted === true,
        durationMs,
      }
    },

    async wait({ targets, timeoutMs }) {
      const budget = Math.min(3600000, Math.max(1000, Number.isFinite(timeoutMs) ? timeoutMs : settings.waitTimeoutMs))
      const started = Date.now()
      for (;;) {
        const status = {}
        let settled = false
        for (const target of targets) {
          const resolved = resolveWorker(state, target)
          const sessionId = resolved === undefined ? target : resolved.sessionId
          const value = resolved === undefined ? 'not_found' : workerStatus(ctx, sessionId, state, settings)
          if (resolved !== undefined) await rememberOutcome(settings, state, sessionId, value)
          status[target] = value
          /* `not_found`, `closed` and `offline` are final too: waiting cannot change them. */
          const final = value === 'not_found' || value === 'closed' || value === 'offline'
          if (typeof value !== 'string' || final) settled = true
        }
        const waitedMs = Date.now() - started
        if (settled) return { status, timedOut: false, waitedMs }
        if (waitedMs >= budget) return { status, timedOut: true, waitedMs }
        await sleep(Math.min(300, budget - waitedMs))
      }
    },

    async dispatch({ sessionId, text, mode }) {
      const service = controller()
      if (service === undefined || service === null) throw new Error('session controller is unavailable')
      guardDepth(state, settings, 0, 'dsh_dispatch')
      takeDispatchSlot(state, settings)
      const before = Number(sessions()?.get?.(sessionId)?.seq ?? 0)
      const requestId = randomUUID()
      const result = await service.prompt(
        { sessionId, requestId, mode, content: [{ type: 'text', text }] },
        AbortSignal.timeout(30000),
      )
      state.dispatched.add(sessionId)
      state.baseline.set(sessionId, before)
      return { accepted: result?.accepted === true, sessionId, requestId, mode, seqAtDispatch: before }
    },

    async readResult({ sessionId, sinceSeq, waitSeconds, signal }) {
      if (!state.dispatched.has(sessionId)) {
        throw new Error('refused: this bridge has not dispatched to that session')
      }
      const requestedWait = waitSeconds === undefined ? settings.readWaitSeconds : waitSeconds
      const seconds = Number.isFinite(requestedWait) ? Math.max(0, requestedWait) : 0
      const budgetMs = Math.min(MAX_WAIT_SECONDS, seconds) * 1000
      const started = Date.now()
      for (;;) {
        const snapshot = readOnce(ctx, sessionId, sinceSeq, settings)
        const waitedMs = Date.now() - started
        if (snapshot.text !== '' || (!snapshot.running && Number(snapshot.lastSeq) > sinceSeq)) {
          return { ...snapshot, timedOut: false, waitedMs }
        }
        const remaining = budgetMs - waitedMs
        if (remaining <= 0) return { ...snapshot, timedOut: true, waitedMs }
        if (signal?.aborted === true) return { ...snapshot, timedOut: true, waitedMs, aborted: true }
        await sleep(Math.min(300, remaining))
      }
    },

    async dispatchCodex(args, exec) {
      const prompt = requireString(args?.prompt, 'prompt')
      const depth = guardDepth(state, settings, callerDepth(state, exec?.agent?.id), 'codex_dispatch')
      takeDispatchSlot(state, settings)
      const cwd = await resolveCwd(ctx, args?.cwd, exec)
      enterChain(state, depth, settings.codexTimeoutMs + 5000)
      try {
        return await runCodex({
        bin: resolveCodex(settings.codexBin),
        prompt,
        cwd,
        resume: typeof args?.resume === 'string' && args.resume !== '' ? args.resume : undefined,
        sandbox: typeof args?.sandbox === 'string' ? args.sandbox : settings.codexSandbox,
        timeoutMs: settings.codexTimeoutMs,
          signal: exec?.signal,
          children: state.children,
        })
      } finally {
        leaveChain(state)
      }
    },
  }
}

/**
 * Highest turn number a session has started.
 * @param ctx - Host context.
 * @param sessionId - session to inspect.
 * @returns the turn number, or 0 when nothing has started.
 */
function lastTurn(ctx, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return 0
  let turn = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start' && Number(event.data?.turn) > turn) turn = Number(event.data.turn)
  }
  return turn
}

/**
 * Resolve when the session finishes the turn that this dispatch starts.
 * Subscribes before the prompt so a fast turn cannot be missed.
 * @param ctx - Host context.
 * @param sessionId - session to watch.
 * @param afterTurn - ignore turns at or below this number.
 * @param timeoutMs - bounded wait.
 * @returns the `turn/end` payload, or undefined on timeout.
 */
function waitForTurnEnd(ctx, sessionId, afterTurn, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const off = ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event?.type !== 'turn/end') return
      if (Number(event.data?.turn) <= afterTurn) return
      finish(event.data)
    })
    const timer = setTimeout(() => finish(undefined), Math.max(1000, timeoutMs))
  })
}

/**
 * Collect assistant text produced after a sequence number.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - only count messages after this sequence.
 * @param settings - resolved settings.
 * @returns the joined text and whether it was trimmed.
 */
function collectAssistant(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return { text: '', truncated: false }
  const texts = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type !== 'assistant/message') continue
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const value = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (value !== '') texts.push(value)
  }
  const joined = texts.join('\n\n')
  return {
    text: joined.length > settings.maxResultChars ? joined.slice(-settings.maxResultChars) : joined,
    truncated: joined.length > settings.maxResultChars,
  }
}


/** Deepest cross-tool delegation currently in flight, or 0 when no chain is open. */
export function ambientDepth(state) {
  const chain = state.chain
  if (chain === undefined || chain.active <= 0) return 0
  return Date.now() < chain.until ? chain.depth : 0
}

/**
 * Mark one outbound delegation as in flight, so anything it triggers inherits its depth.
 * @param state - bridge bookkeeping.
 * @param depth - depth of the run that is starting.
 * @param ttlMs - how long the run may last.
 */
export function enterChain(state, depth, ttlMs) {
  const chain = state.chain
  chain.active += 1
  chain.depth = Math.max(chain.depth, depth)
  chain.until = Date.now() + ttlMs
}

/**
 * Release one outbound delegation, closing the chain when the last one ends.
 * @param state - bridge bookkeeping.
 */
export function leaveChain(state) {
  const chain = state.chain
  chain.active = Math.max(0, chain.active - 1)
  if (chain.active === 0) {
    chain.depth = 0
    chain.until = 0
  }
}

/**
 * Refuse a delegation that would exceed the configured depth.
 * @param state - bridge bookkeeping.
 * @param settings - resolved settings.
 * @param callerDepth - depth of the caller, when it is known to be a worker.
 * @param action - tool name used in the message.
 * @returns the depth this delegation would create.
 */
function guardDepth(state, settings, callerDepth, action) {
  const depth = Math.max(ambientDepth(state), callerDepth ?? 0) + 1
  if (depth > settings.maxHops) {
    throw new Error(
      `${action} would create delegation depth ${String(depth)}, but maxHops is ${String(settings.maxHops)}. ` +
        'Carry the work out directly instead of delegating again.',
    )
  }
  return depth
}

/**
 * Charge one dispatch against the rolling rate limit.
 * @param state - bridge bookkeeping.
 * @param settings - resolved settings.
 */
function takeDispatchSlot(state, settings) {
  const now = Date.now()
  const windowMs = settings.dispatchWindowMs
  state.recent = state.recent.filter((time) => now - time < windowMs)
  if (state.recent.length >= settings.dispatchPerMinute) {
    const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - state.recent[0])) / 1000))
    throw new Error(
      `rate limit: ${String(settings.dispatchPerMinute)} dispatches per ${String(Math.round(windowMs / 1000))}s reached; retry in ${String(retrySeconds)}s`,
    )
  }
  state.recent.push(now)
}

/**
 * Depth of a session the bridge already knows: workers start one level down.
 * @param state - bridge bookkeeping.
 * @param sessionId - calling session, when known.
 * @returns 1 for a bridge worker, otherwise 0.
 */
function callerDepth(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 0
  for (const record of state.workers.values()) {
    if (record.sessionId === sessionId) return 1
  }
  return 0
}


/**
 * Restore the worker registry written by a previous process.
 * @param settings - resolved settings.
 * @param state - worker bookkeeping to fill.
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
async function rememberOutcome(settings, state, sessionId, value) {
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
function resolveWorker(state, reference) {
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
function assertCapacity(state, settings) {
  let open = 0
  for (const record of state.workers.values()) {
    if (record.status === 'closed') continue
    if (record.countsTowardLimit === false) continue
    open += 1
  }
  if (open >= settings.maxWorkers) {
    throw new Error(
      `worker limit reached (${settings.maxWorkers}); close one with dsh_close before spawning another`,
    )
  }
}

/**
 * Validate a task name the way the tool description promises.
 * @param value - candidate name.
 * @returns the normalized name.
 */
function requireTaskName(value) {
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
function finalAnswer(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) return { text: '', truncated: false }
  let last = ''
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type !== 'assistant/message') continue
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const value = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (value !== '') last = value
  }
  if (last.length <= settings.maxResultChars) return { text: last, truncated: false }
  /* Keep the head: a conclusion states its verdict first. */
  return { text: `${last.slice(0, settings.maxResultChars)}\n\n…`, truncated: true }
}

/**
 * Describe one worker the way `wait_agent` does: a string state, or its final answer.
 * @param ctx - Host context.
 * @param sessionId - worker session.
 * @param state - dispatch bookkeeping.
 * @param settings - resolved settings.
 * @returns 'not_found' | 'running' | 'pending' | { completed } | { errored }.
 */
function workerStatus(ctx, sessionId, state, settings) {
  if (!state.dispatched.has(sessionId)) return 'not_found'
  let record
  for (const candidate of state.workers.values()) {
    if (candidate.sessionId === sessionId) record = candidate
  }
  if (record?.status === 'closed') return 'closed'
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) {
    /* After a restart the session is cold; a cached terminal outcome is still valid. */
    if (record?.outcome !== undefined) return record.outcome
    return 'offline'
  }
  if (ctx.get('agents')?.get?.(sessionId)?.status === 'running') return 'running'
  const since = Number(state.baseline.get(sessionId) ?? 0)
  const end = lastTurnEnd(session, since)
  if (end === undefined) return 'pending'
  const reason = end.reason?.kind ?? 'unknown'
  if (reason !== 'completed') return { errored: String(reason) }
  const answer = finalAnswer(ctx, sessionId, since, settings)
  return { completed: answer.text }
}

/**
 * Latest `turn/end` after a sequence, with its reason.
 * @param session - live session.
 * @param sinceSeq - only consider turns that ended after this event.
 * @returns the payload, or undefined when the turn has not ended yet.
 */
function lastTurnEnd(session, sinceSeq) {
  let found
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= sinceSeq) continue
    if (event.type === 'turn/end') found = event.data
  }
  return found
}

/**
 * Read one session snapshot without waiting.
 * @param ctx - Host context.
 * @param sessionId - session to read.
 * @param sinceSeq - only count assistant messages after this sequence.
 * @param settings - resolved settings.
 * @returns text, run state, and the session head sequence.
 */
function readOnce(ctx, sessionId, sinceSeq, settings) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) throw new Error(`session ${sessionId} is not live`)
  const collected = collectAssistant(ctx, sessionId, sinceSeq, settings)
  return {
    sessionId,
    running: ctx.get('agents')?.get?.(sessionId)?.status === 'running',
    lastSeq: Number(session.seq ?? 0),
    truncated: collected.truncated,
    text: collected.text,
  }
}

/**
 * Resolve the directory Codex should run in.
 * @param ctx - Host context.
 * @param requested - explicit `cwd` argument.
 * @param exec - tool run context.
 * @returns the absolute directory.
 */
async function resolveCwd(ctx, requested, exec) {
  if (typeof requested === 'string' && requested !== '') return requested
  const session = exec?.agent === undefined ? undefined : ctx.get('sessions')?.get?.(exec.agent.id)
  const working = ctx.get('workingDirectory')
  if (session !== undefined && session !== null && working !== undefined) {
    try {
      return working.get(session) ?? process.cwd()
    } catch {
      /* Fall through to the process directory. */
    }
  }
  return process.cwd()
}

/**
 * Run one `codex exec` and collect its answer.
 * @param options - binary, prompt, directory, sandbox, timeout, and cancellation.
 * @returns `{ ok, text, threadId, exitCode, durationMs, error? }`.
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
      const timer = setTimeout(() => kill(`codex timed out after ${timeoutMs} ms`), Math.max(1000, timeoutMs ?? 300000))
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
    if (outcome.error !== undefined) return build(false, outcome.error)
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
 * Read a file, tolerating absence.
 * @param path - file path.
 * @returns the text, or undefined.
 */
async function readIfExists(path) {
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
function safeTitle(service, session) {
  try {
    const snapshot = service?.get?.(session)
    return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : undefined
  } catch {
    return undefined
  }
}

/**
 * Accept a request only when it carries the capability token in the path or as a bearer.
 * @param request - node request.
 * @param url - parsed request URL.
 * @param token - expected token.
 * @returns whether the request may proceed.
 */
function authorized(request, url, token) {
  const expected = Buffer.from(token)
  const fromPath = url.pathname.startsWith('/mcp/') ? url.pathname.slice('/mcp/'.length) : ''
  if (fromPath !== '' && safeEqual(fromPath, expected)) return true
  const header = request.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return safeEqual(header.slice(7).trim(), expected)
  }
  return false
}

/**
 * Compare two secrets without early exit.
 * @param candidate - presented value.
 * @param expected - expected value.
 * @returns whether they match.
 */
function safeEqual(candidate, expected) {
  const left = Buffer.from(String(candidate))
  if (left.length !== expected.length) return false
  return timingSafeEqual(left, expected)
}

/**
 * Read a request body with a size cap.
 * @param request - node request.
 * @returns the body text.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read the persisted token, minting one on first use.
 * @param endpointFile - endpoint file path.
 * @returns the token.
 */
async function loadOrCreateToken(endpointFile) {
  try {
    const parsed = JSON.parse(await readFile(endpointFile, 'utf8'))
    if (typeof parsed?.token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(parsed.token)) return parsed.token
  } catch {
    /* First run, or an unreadable file: mint a new token. */
  }
  return randomBytes(24).toString('base64url')
}

/**
 * Persist the endpoint description for humans and client setup.
 * @param endpointFile - endpoint file path.
 * @param value - endpoint description.
 */
async function writeEndpointFile(endpointFile, value) {
  await mkdir(dirname(endpointFile), { recursive: true, mode: 0o700 })
  await writeFile(endpointFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Validate one string argument.
 * @param value - candidate.
 * @param label - argument name used in the error.
 * @returns the string.
 */
function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

/**
 * Wait one short interval.
 * @param ms - milliseconds.
 * @returns a promise that settles after the interval.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Wrap a JSON value as MCP text content.
 * @param value - JSON-serializable value.
 * @returns the tool result.
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Build a JSON-RPC success response.
 * @param id - request id.
 * @param result - result payload.
 * @returns the response.
 */
function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build a JSON-RPC error response.
 * @param id - request id.
 * @param code - JSON-RPC error code.
 * @param message - human readable message.
 * @returns the response.
 */
function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Merge row configuration over the defaults.
 * @param config - row configuration.
 * @returns resolved settings.
 */
function resolveSettings(config) {
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
    if (key === 'maxWorkers') {
      const count = Number(value)
      if (Number.isInteger(count) && count > 0) merged.maxWorkers = count
    }
    if (key === 'waitTimeoutMs') {
      const ms = Number(value)
      if (Number.isFinite(ms) && ms > 0) merged.waitTimeoutMs = Math.min(3600000, Math.max(1000, ms))
    }
    if (key === 'taskTimeoutSeconds') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) merged.taskTimeoutSeconds = Math.min(600, seconds)
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
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
