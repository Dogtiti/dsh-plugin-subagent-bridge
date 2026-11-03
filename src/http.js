import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import { MAX_BODY_BYTES, PACKAGE_VERSION, PROTOCOL_VERSIONS } from './constants.js'
import { requireTaskName } from './registry.js'
import { TOOLS } from './tools.js'
import { errorResponse, ok, requireString, text } from './utils.js'

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

export async function callTool(id, params, api, signal) {
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
        return ok(
          id,
          text(
            await api.spawn({
              taskName,
              message,
              forkTurns,
              from: args.from,
              cwd: args.cwd,
              workspace: args.workspace === true || (typeof args.workspace === 'string' && args.workspace !== '') ? args.workspace : undefined,
              mode: args.mode === 'steer' ? 'steer' : undefined,
              model: typeof args.model === 'string' && args.model !== '' ? args.model : undefined,
              reasoningEffort:
                typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '' ? args.reasoningEffort : undefined,
            }),
          ),
        )
      }
      case 'dsh_followup': {
        const worker = requireString(args.worker, 'worker')
        const message = requireString(args.message, 'message')
        return ok(
          id,
          text(
            await api.followup({
              worker,
              message,
              mode: args.mode === 'steer' ? 'steer' : undefined,
              model: typeof args.model === 'string' && args.model !== '' ? args.model : undefined,
              reasoningEffort:
                typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '' ? args.reasoningEffort : undefined,
            }),
          ),
        )
      }
      case 'dsh_close': {
        const worker = requireString(args.worker, 'worker')
        return ok(id, text(await api.close({ worker })))
      }
      case 'dsh_answer': {
        const worker = requireString(args.worker, 'worker')
        if (!Array.isArray(args.answers) || args.answers.length === 0) throw new Error('answers must be a non-empty array')
        const answers = args.answers.map((entry, index) => {
          const questionId = requireString(entry?.id, `answers[${index}].id`)
          if (!Array.isArray(entry?.selected)) throw new Error(`answers[${index}].selected must be an array`)
          return {
            id: questionId,
            selected: entry.selected.map((label, at) => requireString(label, `answers[${index}].selected[${at}]`)),
            ...(typeof entry.custom === 'string' && entry.custom !== '' ? { custom: entry.custom } : {}),
          }
        })
        return ok(id, text(await api.answer({ worker, answers })))
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
        return ok(id, text(await api.wait({ targets, timeoutMs, signal })))
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
              workspace: args.workspace === true || (typeof args.workspace === 'string' && args.workspace !== '') ? args.workspace : undefined,
              mode: args.mode === 'steer' ? 'steer' : undefined,
              model: typeof args.model === 'string' && args.model !== '' ? args.model : undefined,
              reasoningEffort:
                typeof args.reasoningEffort === 'string' && args.reasoningEffort !== '' ? args.reasoningEffort : undefined,
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

export function authorized(request, url, token) {
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

export function safeEqual(candidate, expected) {
  const left = Buffer.from(String(candidate))
  if (left.length !== expected.length) return false
  return timingSafeEqual(left, expected)
}

/**
 * Read a request body with a size cap.
 * @param request - node request.
 * @returns the body text.
 */

export async function readBody(request) {
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

export async function loadOrCreateToken(endpointFile) {
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

export async function writeEndpointFile(endpointFile, value) {
  await mkdir(dirname(endpointFile), { recursive: true, mode: 0o700 })
  await writeFile(endpointFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Validate one string argument.
 * @param value - candidate.
 * @param label - argument name used in the error.
 * @returns the string.
 */
