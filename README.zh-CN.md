# dsh-plugin-subagent-bridge

> 让 Codex 或 Claude Code 把 DeepSeek Harness 会话当作 subagent 来用 —— 反过来，DSH 也能把任务派给它们。

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)
<!-- M8ven ownership proof — keep this line in place; it verifies the publisher. -->
[![M8ven Score](https://m8ven.ai/badge/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?v=f15f3e56c3fa22e8aafb88cf5428501f)](https://m8ven.ai/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?s=readme)

[English](README.md)

插件运行在 Harness 宿主进程内，对外暴露一个回环 MCP 端点。它只用宿主公开服务（`sessionController`、`sessions`、`workspaceRegistry`、`userQuestions`）——不读凭据文件，也不伪造 cookie。

## 特性

- **一次调用，一个答案。** `dsh_task` 开会话、投递消息、阻塞到这一轮结束，只返回最终的助手文本。
- **并行 worker。** `dsh_spawn` 立即返回；`dsh_wait` 阻塞到其中任意一个到达终态。
- **按次指定模型与项目。** 把 worker 钉在 `provider/model` 上、归入指定项目，且不改动 profile 默认值。
- **排队或插话。** 由调用方决定后续消息是等当前回合，还是插进当前回合。
- **默认无人值守。** worker 被告知采用合理默认继续，而不是停下来提问。
- **反向能力。** `codex_dispatch` 与 `claude_dispatch` 把任务交给 Codex 或 Claude Code，且线程可续接。
- **防环。** 深度与速率限制阻止两个 agent 互相派活绕圈。

## 环境要求

- DeepSeek Harness `^0.2.1-0`。
- 反向方向需要 `PATH` 上有 Codex CLI（`codex`）和/或 Claude Code CLI（`claude`）。

## 安装

```bash
git clone https://github.com/Dogtiti/dsh-plugin-subagent-bridge
```

在 DSH 里打开 **Plugins → 添加**，选择该目录。启动后插件监听 `127.0.0.1:47821`，并写入端点文件：

```json
{
  "url": "http://127.0.0.1:47821/mcp/<token>",
  "port": 47821,
  "token": "<token>",
  "pid": 12345,
  "startedAt": "2026-10-22T12:30:00.000Z"
}
```

`~/.dsh/bridge/endpoint.json`，目录 `0700`，文件 `0600`。

## 连接

### Codex

```bash
codex mcp add dsh-bridge --url "$(node -p "require(process.env.HOME+'/.dsh/bridge/endpoint.json').url")"
codex mcp list                # 验证
codex mcp remove dsh-bridge   # 移除
```

桌面 App 与 CLI 共用 `~/.codex/config.toml`，两端都能看到。token 放在 URL 路径里，因此不需要环境变量——桌面 App 从 Finder 启动时拿不到自定义环境变量。也支持 `Authorization: Bearer <token>`。

### Claude Code

```bash
claude mcp add --transport http dsh-bridge "<上面那个 url>" --scope user
```

## 用法

```js
// 同步：等这一轮跑完，直接拿答案
dsh_task({ prompt: "审一下 src/bridge.ts 的错误处理", cwd: "/repo" })

// 异步：先派活，再一起等
dsh_spawn({ task_name: "audit_api", message: "…", cwd: "/repo" })
dsh_spawn({ task_name: "audit_ui",  message: "…", cwd: "/repo" })
dsh_wait({ targets: ["audit_api", "audit_ui"], timeoutMs: 240000 })

// 续派：复用已有 worker 的上下文
dsh_followup({ worker: "audit_api", message: "把第 3 条展开，附上补丁" })
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_task` | 同步派活：开会话、投递、阻塞到回合结束，返回最终回答 |
| `dsh_spawn` | 异步派活：立刻返回 `task_name` + `sessionId` |
| `dsh_followup` | 在已有 worker 上再派一轮，复用其上下文 |
| `dsh_wait` | 一次等多个 worker，任一到达终态即返回 |
| `dsh_close` | 关闭 worker 并释放名额（会话保留） |
| `dsh_answer` | 回答 worker 提出的问题（有已知限制，见下） |
| `dsh_list_workers` | 列出本桥开的 worker 及实时状态 |
| `dsh_dispatch` | 向任意会话投递一条消息；返回 `requestId` 与 `seqAtDispatch` |
| `dsh_read_result` | 长轮询读取 `seqAtDispatch` 之后产生的助手文本 |
| `dsh_list_sessions` | 只列会话元数据（id、标题、cwd、是否运行、最后活动时间） |

`dsh_list_sessions` 从不返回消息内容；`dsh_read_result` 只对本桥派发过的会话有效。

### 指定模型

```js
dsh_task({ prompt: "…", model: "zai-coding-cn/glm-5.3", reasoningEffort: "max" })
dsh_spawn({ task_name: "review", message: "…", model: "opencode-go/deepseek-v4.1-flash" })
```

- 写法是 `provider/model`；只写模型名时沿用当前默认 provider。
- `reasoningEffort` 可选，取值随模型。
- 不传则完全不动会话。
- 切换发生在第一次 prompt 之前，所以 worker 第一轮就已经在新模型上跑，且不会改动 profile 的默认模型。

### 项目归属

DSH 把会话分组为项目；新建会话默认落在「未分组」，除非所在目录已经是项目。

```js
dsh_task({ prompt: "…", cwd: "/repo/clawer", workspace: true })    // 创建，标题取目录名
dsh_spawn({ task_name: "w1", message: "…", cwd: "/repo/clawer", workspace: "Clawer" })
dsh_task({ prompt: "…", cwd: "/repo/clawer" })                     // 只复用
```

目录不存在会先创建（登记要求目录已存在）。已是项目则复用且**不改标题**。返回里带 `workspace: { id, title, path }`。项目操作失败不会让派发失败。

### 排队或插话

DSH 的「繁忙时的发送行为」只有两种：

| `mode` | 行为 |
| --- | --- |
| `queue`（默认） | 等当前回合结束，作为新回合投递 |
| `steer` | 插入当前回合，模型在下一步就能看到 |

```js
dsh_followup({ worker: "w1", message: "接下来只改 src 下的文件", mode: "steer" })
```

两个实测结论：

1. **`steer` 不打断正在执行的工具调用。** worker 若正卡在 `sleep 90` 里，要等那次调用返回才看得到消息（实测 70 秒）。真的停下是界面上的「取消」，不是投递模式。
2. **`steer` 不新开回合** —— turn 编号不变，所以桥等的是**当前**回合结束；等「下一个回合」会一直阻塞到超时。

`dsh_task` 对运行中的会话默认拒绝，除非传 `mode: "steer"`，错误信息里也这么写。插话的回复与原任务同一回合，所以桥以**自己那条用户消息**为锚点取回答，而不是这一轮最后一条助手文本。

### 无人值守

调用 `ask_user_question` 的 worker 会等人回答。调用方是另一个 agent 时，没有人在这。因此桥给每个派发的任务追加一条常驻指令：

```
(If information is missing, or a choice between options is required, pick the most
 reasonable default, finish the task, and state the assumption in one line. Do not
 hand the decision back to the user and do not call ask_user_question.)
```

默认开启（`assumeDefaults: false` 可关闭）。prompt 里本来就提到 `ask_user_question` 时不追加。

想换成中文——或者任何自己的措辞——用 `assumptionPolicy`：

```yaml
config:
  assumptionPolicy: "如果缺少必要信息，直接采用最合理的默认做法做完，并在结果里用一行说明你的假设。"
```

> 指令正文是中文时，桥用全角括号包裹；英文等其他语言用半角括号。

### 问题上报

worker 真的提问时，`dsh_wait` 会把问题带出来：

```jsonc
{
  "status": { "w1": "running" },
  "pendingQuestion": {
    "callId": "call_abc",
    "questions": [{ "id": "mode", "question": "用哪种模式？", "options": [{ "label": "快速" }] }]
  },
  "next": "blocked on a question: answer it with dsh_answer, or call dsh_wait again"
}
```

`dsh_answer({ worker, answers: [{ id: "mode", selected: ["快速"] }] })` 提交答案。

**已知限制：** DSH 的 `userQuestions.answer()` 只接受已经超时进入 `continued` 状态的问题。仍阻塞在工具调用里的问题由 Web UI 的 answerer 接管，桥答不了（实测返回 `answered: false`）。实际使用中应依赖 `assumeDefaults`，而不是等 worker 提问。

## 反向方向

两个工具都注册给本部署的 Agent。

### `codex_dispatch`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，任务正文 |
| `cwd` | 工作目录；默认用调用方会话的目录 |
| `resume` | Codex 线程 id，用于续接 |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` |

返回 `{ ok, text, threadId, exitCode, durationMs }`。执行 `codex exec [resume <id>] --json -o <临时文件>`，从事件流读 `thread.started`，从 `-o` 文件读最终消息。**`resume` 时 `sandbox` 与 `cwd` 均不生效** —— `codex exec resume` 不接受这两个参数。

### `claude_dispatch`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，任务正文 |
| `cwd` | 工作目录 |
| `resume` | Claude Code 的 session id |
| `model` | 模型别名或 id；不传则用配置，再退回 CLI 自己的设置 |

返回 `{ ok, text, sessionId, durationMs }`。执行 `claude -p --output-format json`，只读 stdout 上的单个 JSON 对象。**stderr 只是提示** —— 模型名后缀不被识别时 CLI 会警告，但结果仍然正常。

## 配置

```yaml
- insert:
    - id: subagent-bridge
      name: 'dsh-plugin-subagent-bridge'
      config:
        port: 47821
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后不监听、不写端点文件 |
| `port` | `47821` | 回环端口；固定端口让客户端 URL 重启后依然有效 |
| `endpointFile` | `~/.dsh/bridge/endpoint.json` | 端点与令牌写入位置 |
| `maxResultChars` | `20000` | 单次结果载荷上限（保留开头） |
| `taskTimeoutSeconds` | `300` | `dsh_task` 等待上限（客户端可覆盖，最大 240） |
| `assumeDefaults` | `true` | 追加「自行决策」指令 |
| `assumptionPolicy` | 空 | 替换指令正文；空表示用内置英文默认 |
| `workersFile` | `~/.dsh/bridge/workers.json` | worker 注册表（`0600`） |
| `maxHops` | `1` | 委派深度上限 |
| `dispatchPerMinute` | `10` | 每个窗口允许的派发次数 |
| `dispatchWindowMs` | `60000` | 窗口长度 |
| `maxWorkersPerRoot` | `4` | 每个工作目录的 worker 上限 |
| `maxWorkers` | `12` | 全局 worker 上限 |
| `workerTtlMs` | `86400000` | 记录过期后不再占名额 |
| `waitTimeoutMs` | `240000` | `dsh_wait` 默认超时 |
| `readWaitSeconds` | `25` | `dsh_read_result` 默认长轮询时长 |
| `codexBin` | `codex` | Codex 可执行文件；含 `/` 时严格按路径解析 |
| `codexSandbox` | `workspace-write` | `codex_dispatch` 默认 sandbox |
| `codexTimeoutMs` | `300000` | 单次运行超时 |
| `claudeBin` | `claude` | Claude Code 可执行文件 |
| `claudeModel` | 空 | 空表示用 CLI 自己的设置 |
| `claudeTimeoutMs` | `300000` | 单次运行超时 |

端口被占用时会**报错而不是静默换端口**：端点文件里写入 `error` 字段，宿主日志打印 `subagent-bridge: could not start on port …`。

## 护栏

**深度。** 两个 agent 都能看到同一个桥，因此存在环路：DSH worker → `codex_dispatch` → 那次 Codex → `dsh_spawn` → … 每次派发都计算 `max(在飞链路深度, 调用方深度) + 1`，超过 `maxHops` 直接拒绝：

```
codex_dispatch would create delegation depth 2, but maxHops is 1.
Carry the work out directly instead of delegating again.
```

**速率。** `dispatchPerMinute`（默认 10）拦截突发与紧循环重试：

```
rate limit: 10 dispatches per 60s reached; retry in 23s
```

**名额。** 每个 `cwd` 4 个，全局 12 个。完成的 worker 在 `dsh_close` 之前仍占名额；记录超过 24 小时自动不再计数。阻塞式 `dsh_task` 只登记、不占名额。按 `cwd` 分桶是因为 MCP 端点共享且请求里没有会话身份。

**持久化。** `workers.json` 保存注册表与每轮基线：重启后 worker 仍在，已完成的直接回放缓存答案，冷会话报告 `offline`，文件最多保留 200 条。

**安全。** 只监听回环；每个请求都要令牌（路径或 bearer 头），常量时间比较；令牌只生成一次并持久化。拿到端点文件等价于能向会话投递消息——保持 `0600`/`0700` 权限。DSH 自身的 sandbox 与审批规则对投递内容依然生效。

## 工作原理

```
Codex / 任意 MCP 客户端
  │  POST /mcp/<token>   JSON-RPC（无状态，单次 JSON 响应）
  ▼
dsh-plugin-subagent-bridge（宿主进程内）
  · node:http 监听 127.0.0.1:47821
  · initialize / tools/list / tools/call / ping
  · sessionController.prompt({ sessionId, requestId, mode, content })
  · sessions.get(id).snapshotEvents() 读回文本
```

协议是 streamable HTTP 的无状态子集：每个 POST 返回一个 `application/json`，没有任何推送，所以结果靠长轮询取。客户端一断开，服务端立刻停止等待。

## 配套 skill

两份可安装的 skill 把这些能力变成模型会遵循的行为，而不是它可能忘记的工具：

| Skill | 装给谁 | 作用 |
| --- | --- | --- |
| `deepseek-worker` | Codex | Codex 何时、如何把任务派给 DSH |
| `delegate-to-external-agent` | DSH | DSH 何时该派给 Codex 或 Claude Code |

```bash
mkdir -p ~/.codex/skills && cp -R skills/deepseek-worker ~/.codex/skills/
mkdir -p ~/.dsh/skills  && cp -R skills/delegate-to-external-agent ~/.dsh/skills/
```

两份都是普通 `SKILL.md`：YAML frontmatter（`name` + `description`）加正文。触发全靠 description，所以里面写了中英触发语和明确的「不要用」边界。改完不用重启即刻生效。

## 兼容性

- DSH `^0.2.1-0`（`engines.dsh`）。
- MCP 协议版本 `2025-06-18`、`2025-03-26`、`2024-11-05`；未知版本回落到最新。
- 依赖公开服务 `sessionController`、`sessions`、`workspaceRegistry`、`userQuestions`；缺失时以明确的工具错误呈现。

## 开发

```bash
node --test "test/*.test.mjs"
```

```
index.js              wiring: apply() + re-exports
src/constants.js      versions, limits, binary candidates, policy text
src/utils.js          JSON-RPC helpers, argument validation, sleep
src/settings.js       defaults and config resolution
src/tools.js          tool schemas
src/policy.js         the standing instruction
src/questions.js      ask_user_question takeover and reporting
src/sessions.js       session reads, waits, model and workspace placement
src/guards.js         depth and rate limits
src/registry.js       worker registry persistence and capacity
src/http.js           loopback server, JSON-RPC, tool dispatch
src/api.js            the bridge API the tools call
src/runners/codex.js  codex exec adapter
src/runners/claude.js claude -p adapter
```

83 项测试：握手与版本协商、工具清单与参数校验、派发调用形状、结果基线、长轮询、真实 HTTP 往返（404/405/202 与 bearer）、`codex exec` 事件解析、二进制解析、成功/失败/超时、resume 参数分叉、只回最终回答、`dsh_wait` 终态、名额上限与释放、followup 重基线、注册表持久化与重启恢复、`maxHops` 与速率限制、按 `cwd` 的预算、项目创建与复用、`queue`/`steer` 投递与等待、插话回答的锚点、Claude 输出解析与 resume 参数、`assumeDefaults` 注入、`pendingQuestion` 与 `dsh_answer`。

## 相关插件

| 插件 | 说明 |
| --- | --- |
| **dsh-plugin-subagent-bridge**（本仓库） | 让 Codex 把 DSH 当 subagent 用，DSH 也能派给 Codex / Claude Code |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | 预测下一条指令并显示为占位文字，`Tab` 采纳 |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |
| [dsh-plugin-usage-panel](https://github.com/Dogtiti/dsh-plugin-usage-panel) | 在模型选择器旁显示供应商额度余量 |
| [dsh-plugin-provider-icons](https://github.com/Dogtiti/dsh-plugin-provider-icons) | 在模型名旁显示供应商品牌 logo |

## 许可

MIT © [Dogtiti](https://github.com/Dogtiti)
