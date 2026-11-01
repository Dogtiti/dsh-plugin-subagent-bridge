# dsh-plugin-subagent-bridge

> Let Codex or Claude Code drive DeepSeek Harness sessions as subagents — and let DSH drive them back.

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)
<!-- M8ven ownership proof — keep this line in place; it verifies the publisher. -->
[![M8ven Score](https://m8ven.ai/badge/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?v=f15f3e56c3fa22e8aafb88cf5428501f)](https://m8ven.ai/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?s=readme)

[中文说明](README.zh-CN.md)

The plugin runs inside the Harness host and exposes a loopback MCP endpoint. It uses public host services (`sessionController`, `sessions`, `workspaceRegistry`, `userQuestions`) — no credential files, no cookie forgery.

## Highlights

- **One tool call, one answer.** `dsh_task` opens a session, delivers the message, blocks until the turn ends, and returns only the final assistant text.
- **Parallel workers.** `dsh_spawn` returns immediately; `dsh_wait` blocks until any of them settles.
- **Per-call model and project.** Pin a worker to `provider/model` and file it under a named workspace without touching profile defaults.
- **Queue or steer.** Choose whether a follow-up waits for the running turn or is inserted into it.
- **Unattended by default.** Workers are told to assume a reasonable default instead of stopping to ask.
- **Reverse direction.** `codex_dispatch` and `claude_dispatch` hand work to Codex or Claude Code, with resumable threads.
- **Loop guard.** Depth and rate limits stop the two agents from delegating to each other in circles.

## Requirements

- DeepSeek Harness `^0.2.1-0`.
- Codex CLI (`codex`) and/or Claude Code CLI (`claude`) on `PATH` for the reverse direction.

## Install

```bash
git clone https://github.com/Dogtiti/dsh-plugin-subagent-bridge
```

Open **Plugins → Add** in DSH and pick that directory. On start the plugin listens on `127.0.0.1:47821` and writes the endpoint file:

```json
{
  "url": "http://127.0.0.1:47821/mcp/<token>",
  "port": 47821,
  "token": "<token>",
  "pid": 12345,
  "startedAt": "2026-10-22T12:30:00.000Z"
}
```

`~/.dsh/bridge/endpoint.json`, directory `0700`, file `0600`.

## Connect

### Codex

```bash
codex mcp add dsh-bridge --url "$(node -p "require(process.env.HOME+'/.dsh/bridge/endpoint.json').url")"
codex mcp list                # verify
codex mcp remove dsh-bridge   # remove
```

The desktop app and the CLI share `~/.codex/config.toml`, so both see it. The token lives in the URL path, so no environment variable is needed — the desktop app cannot receive custom ones when launched from Finder. `Authorization: Bearer <token>` works too.

### Claude Code

```bash
claude mcp add --transport http dsh-bridge "<the url above>" --scope user
```

## Usage

```js
// Synchronous: wait for the turn, get the answer
dsh_task({ prompt: "Review the error handling in src/bridge.ts", cwd: "/repo" })

// Asynchronous: hand out work, then wait for all of it
dsh_spawn({ task_name: "audit_api", message: "…", cwd: "/repo" })
dsh_spawn({ task_name: "audit_ui",  message: "…", cwd: "/repo" })
dsh_wait({ targets: ["audit_api", "audit_ui"], timeoutMs: 240000 })

// Continue an existing worker
dsh_followup({ worker: "audit_api", message: "Expand item 3 and attach a patch" })
```

## Tools

| Tool | Purpose |
| --- | --- |
| `dsh_task` | Synchronous dispatch: create session, deliver, block to end of turn, return the final answer |
| `dsh_spawn` | Asynchronous dispatch: returns `task_name` + `sessionId` immediately |
| `dsh_followup` | Another round on an existing worker, reusing its context |
| `dsh_wait` | Wait on several workers at once; returns when any reaches a terminal state |
| `dsh_close` | Close a worker and free its slot (the session stays) |
| `dsh_answer` | Answer a worker's question (limited — see below) |
| `dsh_list_workers` | List workers started by this bridge and their live status |
| `dsh_dispatch` | Deliver one message to any session; returns `requestId` and `seqAtDispatch` |
| `dsh_read_result` | Long-poll the assistant text produced after `seqAtDispatch` |
| `dsh_list_sessions` | List session metadata only (id, title, cwd, running, last activity) |

`dsh_list_sessions` never returns message content, and `dsh_read_result` only works for sessions this bridge has dispatched to.

### Model

```js
dsh_task({ prompt: "…", model: "zai-coding-cn/glm-5.3", reasoningEffort: "max" })
dsh_spawn({ task_name: "review", message: "…", model: "opencode-go/deepseek-v4.1-flash" })
```

- `provider/model`; a bare model id keeps the current default provider.
- `reasoningEffort` is optional and model-dependent.
- Omitted means the session is untouched.
- The switch happens before the first prompt, so the worker's first turn already runs on it, and the profile default model is not modified.

### Workspace

DSH groups sessions into projects; a new session lands under "Ungrouped" unless its directory is already a project.

```js
dsh_task({ prompt: "…", cwd: "/repo/clawer", workspace: true })    // create, titled after the directory
dsh_spawn({ task_name: "w1", message: "…", cwd: "/repo/clawer", workspace: "Clawer" })
dsh_task({ prompt: "…", cwd: "/repo/clawer" })                     // reuse only
```

Missing directories are created first (registration requires an existing directory). An existing project is reused without retitling. The result carries `workspace: { id, title, path }`. A failure here never fails the dispatch.

### Queue or steer

DSH's "sending while busy" has exactly two behaviours:

| `mode` | Behaviour |
| --- | --- |
| `queue` (default) | Wait for the current turn, then deliver as a new turn |
| `steer` | Insert into the current turn; the model sees it at the next step |

```js
dsh_followup({ worker: "w1", message: "Only touch files under src from here", mode: "steer" })
```

Two measured facts:

1. **`steer` does not interrupt a running tool call.** A worker inside `sleep 90` only sees the message when that call returns (70s in our test). Stopping it is the UI's cancel action, not a delivery mode.
2. **`steer` does not open a new turn** — the turn number stays the same, so the bridge waits for the *current* turn to end. Waiting for the next one blocks until the timeout.

`dsh_task` refuses a running session unless `mode: "steer"` is given, and the error message says so. A steered reply shares the turn with the original task, so the bridge anchors the answer on its own user message rather than the turn's last assistant text.

### Unattended workers

A worker that calls `ask_user_question` waits for a human. When the caller is another agent, nobody is there. So the bridge appends a standing instruction to every delegated task:

```
(If information is missing, or a choice between options is required, pick the most
 reasonable default, finish the task, and state the assumption in one line. Do not
 hand the decision back to the user and do not call ask_user_question.)
```

Set your own wording with `assumptionPolicy`:

```yaml
config:
  assumptionPolicy: "If information is missing, pick the most reasonable default, finish the task, and state the assumption in one line. Do not ask the user and do not call ask_user_question."
```

On by default (`assumeDefaults: false` disables it). It is skipped when the prompt already mentions `ask_user_question`.

> The built-in default text is Chinese (`如果缺少必要信息……`), which every model in this host reads; the block above is that instruction in English. Set `assumptionPolicy` to send English verbatim.

### Questions (`pendingQuestion`)

If a worker does ask, `dsh_wait` reports it:

```jsonc
{
  "status": { "w1": "running" },
  "pendingQuestion": {
    "callId": "call_abc",
    "questions": [{ "id": "mode", "question": "Which mode?", "options": [{ "label": "Fast" }] }]
  },
  "next": "blocked on a question: answer it with dsh_answer, or call dsh_wait again"
}
```

`dsh_answer({ worker, answers: [{ id: "mode", selected: ["Fast"] }] })` submits a batch.

**Known limit:** DSH's `userQuestions.answer()` only accepts questions that have already timed out into the `continued` state. A question still blocking inside the tool call belongs to the web UI's answerer, and the bridge cannot answer it (`answered: false` in practice). Prefer `assumeDefaults` over waiting for a question.

## Reverse direction

Both tools are registered for agents of this deployment.

### `codex_dispatch`

| Parameter | Description |
| --- | --- |
| `prompt` | Required task text |
| `cwd` | Working directory; defaults to the calling session's |
| `resume` | Codex thread id to continue |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` |

Returns `{ ok, text, threadId, exitCode, durationMs }`. Runs `codex exec [resume <id>] --json -o <tmpfile>`, reads `thread.started` from the event stream and the final message from the `-o` file. **`sandbox` and `cwd` are ignored on `resume`** — `codex exec resume` accepts neither.

### `claude_dispatch`

| Parameter | Description |
| --- | --- |
| `prompt` | Required task text |
| `cwd` | Working directory |
| `resume` | Claude Code session id |
| `model` | Model alias or id; falls back to config, then to the CLI's own setting |

Returns `{ ok, text, sessionId, durationMs }`. Runs `claude -p --output-format json` and reads the single JSON object on stdout. **stderr is advisory** — the CLI warns about an unrecognised model suffix while still succeeding.

## Configuration

```yaml
- insert:
    - id: subagent-bridge
      name: 'dsh-plugin-subagent-bridge'
      config:
        port: 47821
```

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, no listener and no endpoint file |
| `port` | `47821` | Loopback port; fixed so the client URL survives restarts |
| `endpointFile` | `~/.dsh/bridge/endpoint.json` | Where the endpoint and token are written |
| `maxResultChars` | `20000` | Cap on a single result payload (the head is kept) |
| `taskTimeoutSeconds` | `300` | `dsh_task` wait cap (client may override, max 240) |
| `assumeDefaults` | `true` | Append the decide-and-continue instruction |
| `assumptionPolicy` | *(empty)* | Replacement text for the instruction; empty uses the built-in Chinese default |
| `workersFile` | `~/.dsh/bridge/workers.json` | Worker registry (`0600`) |
| `maxHops` | `1` | Delegation depth limit |
| `dispatchPerMinute` | `10` | Dispatches allowed per window |
| `dispatchWindowMs` | `60000` | Window length |
| `maxWorkersPerRoot` | `4` | Workers per working directory |
| `maxWorkers` | `12` | Global worker cap |
| `workerTtlMs` | `86400000` | Records stop counting once stale |
| `waitTimeoutMs` | `240000` | Default `dsh_wait` timeout |
| `readWaitSeconds` | `25` | Default `dsh_read_result` long-poll |
| `codexBin` | `codex` | Codex executable; a value with `/` is resolved strictly |
| `codexSandbox` | `workspace-write` | Default sandbox for `codex_dispatch` |
| `codexTimeoutMs` | `300000` | Per-run timeout |
| `claudeBin` | `claude` | Claude Code executable |
| `claudeModel` | *(empty)* | Empty means the CLI's own setting |
| `claudeTimeoutMs` | `300000` | Per-run timeout |

A busy port is reported, not silently replaced: the endpoint file gets an `error` field and the host log prints `subagent-bridge: could not start on port …`.

## Guardrails

**Depth.** Both agents can see the same bridge, so a circle is possible: DSH worker → `codex_dispatch` → that Codex run → `dsh_spawn` → … Each dispatch computes `max(in-flight depth, caller depth) + 1` and refuses beyond `maxHops`:

```
codex_dispatch would create delegation depth 2, but maxHops is 1.
Carry the work out directly instead of delegating again.
```

**Rate.** `dispatchPerMinute` (default 10) catches bursts and tight retry loops:

```
rate limit: 10 dispatches per 60s reached; retry in 23s
```

**Slots.** 4 workers per `cwd`, 12 globally. A finished worker keeps its slot until `dsh_close`; records older than 24h stop counting. Blocking `dsh_task` calls are registered but do not consume a slot. Buckets are keyed by `cwd` because the MCP endpoint is shared and carries no session identity.

**Persistence.** `workers.json` keeps the registry and each turn's baseline: workers survive a restart, finished ones replay their cached answer, cold sessions report `offline`, and the file keeps at most 200 records.

**Security.** Loopback only; every request needs the token in the path or a bearer header, compared in constant time; the token is generated once and persisted. Holding the endpoint file is equivalent to being able to send messages to sessions — keep its `0600`/`0700` permissions. DSH's own sandbox and approval rules still apply to anything delivered.

## How it works

```
Codex / any MCP client
  │  POST /mcp/<token>   JSON-RPC (stateless, single JSON response)
  ▼
dsh-plugin-subagent-bridge (inside the host process)
  · node:http on 127.0.0.1:47821
  · initialize / tools/list / tools/call / ping
  · sessionController.prompt({ sessionId, requestId, mode, content })
  · sessions.get(id).snapshotEvents() to read text back
```

The protocol is a stateless subset of streamable HTTP: each POST returns one `application/json` body and nothing is pushed, so results are collected by long polling. The server stops waiting the moment the client disconnects.

## Skills

Two installable skills turn this into behaviour a model follows rather than a tool it might forget:

| Skill | Install to | Purpose |
| --- | --- | --- |
| `deepseek-worker` | Codex | When and how Codex should delegate to DSH |
| `delegate-to-external-agent` | DSH | When DSH should delegate to Codex or Claude Code |

```bash
mkdir -p ~/.codex/skills && cp -R skills/deepseek-worker ~/.codex/skills/
mkdir -p ~/.dsh/skills  && cp -R skills/delegate-to-external-agent ~/.dsh/skills/
```

Both are plain `SKILL.md` files: YAML frontmatter (`name` + `description`) plus body. Triggering depends entirely on the description, so they carry bilingual trigger phrases and explicit "don't use" boundaries. Changes take effect without a restart.

## Compatibility

- DSH `^0.2.1-0` (`engines.dsh`).
- MCP protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`; unknown versions fall back to the newest.
- Requires the public services `sessionController`, `sessions`, `workspaceRegistry`, `userQuestions`. Missing ones surface as explicit tool errors.

## Development

```bash
node --test "test/*.test.mjs"
```

83 tests: handshake and version negotiation, tool list and argument validation, dispatch call shape, result baselines, long polling, real HTTP round trips (404/405/202 and bearer), `codex exec` event parsing, binary resolution, success/failure/timeout runs, resume argument split, final-answer-only behaviour, `dsh_wait` terminal states, slot limits and release, followup rebaselining, registry persistence and restart recovery, `maxHops` and rate limiting, per-`cwd` budgets, workspace creation and reuse, `queue`/`steer` delivery and waiting, anchors for steered answers, Claude output parsing and resume arguments, `assumeDefaults` injection, `pendingQuestion` and `dsh_answer`.

## Related

| Plugin | Description |
| --- | --- |
| **dsh-plugin-subagent-bridge** (this repo) | Let Codex drive DSH as a subagent, and DSH drive Codex / Claude Code |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | Predicts the next instruction as placeholder text; `Tab` accepts |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | `↑` / `↓` in the composer to recall previous messages |
| [dsh-plugin-usage-panel](https://github.com/Dogtiti/dsh-plugin-usage-panel) | Provider quota next to the model picker |
| [dsh-plugin-provider-icons](https://github.com/Dogtiti/dsh-plugin-provider-icons) | Provider logos next to model names |

## License

MIT © [Dogtiti](https://github.com/Dogtiti)
