# dsh-plugin-subagent-bridge

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)
<!-- M8ven ownership proof — keep this line in place; it verifies the publisher. -->
[![M8ven Score](https://m8ven.ai/badge/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?v=f15f3e56c3fa22e8aafb88cf5428501f)](https://m8ven.ai/mcp/dogtiti-dsh-plugin-subagent-bridge-8a3t8k?s=readme)

在 DeepSeek Harness 宿主内部提供**本机回环 MCP 端点**，让另一个智能体把任务派给 DSH 会话并取回结果；反过来，DSH 里的 agent 也能把任务派给 Codex 或 Claude Code。

两个方向共用同一个插件，各自遵守对方产品的 `maxDepth: 1`：**能派活，不能再派回来**。

---

## 能力一览

| 方向 | 入口 | 一次调用做什么 |
| --- | --- | --- |
| Codex / 任意 MCP 客户端 → DSH | `dsh_task` | 开会话、投递、阻塞到这一轮结束，只回最终答案 |
| 同上，并行 | `dsh_spawn` + `dsh_wait` | 立刻返回句柄，多个 worker 同时跑，再批量等 |
| 同上，续派 | `dsh_followup` | 复用 worker 的上下文再派一轮 |
| DSH → Codex | `codex_dispatch` | 跑一次 `codex exec`，回最终回答与可续接的线程 id |
| DSH → Claude Code | `claude_dispatch` | 跑一次 `claude -p`，回最终回答与可续接的 session id |

插件运行在宿主进程内，直接用公开服务（`sessionController`、`sessions`、`workspaceRegistry`、`userQuestions`），不需要读凭据文件，也不需要伪造 cookie。

---

## 安装

```bash
git clone https://github.com/Dogtiti/dsh-plugin-subagent-bridge
```

Plugins → 添加 → 选该目录。

启动后在 `127.0.0.1:47821` 监听，并把端点写到 `~/.dsh/bridge/endpoint.json`（目录 0700、文件 0600）：

```json
{
  "url": "http://127.0.0.1:47821/mcp/<token>",
  "port": 47821,
  "token": "<token>",
  "pid": 12345,
  "startedAt": "2026-10-22T12:30:00.000Z"
}
```

## 接到 Codex

```bash
codex mcp add dsh-bridge --url "$(node -p "require(process.env.HOME+'/.dsh/bridge/endpoint.json').url")"
codex mcp list          # 验证
codex mcp remove dsh-bridge   # 移除
```

桌面 App 与 CLI 共用 `~/.codex/config.toml`，两端都会看到这条。

> token 放在 URL 路径里（能力 URL），所以 Codex 侧不需要配环境变量——桌面 App 从 Finder 启动时拿不到自定义环境变量。也支持 `Authorization: Bearer <token>`，需要时可用 `--bearer-token-env-var`。

Claude Code 同理：

```bash
claude mcp add --transport http dsh-bridge "<上面那个 url>" --scope user
```

---

## 正向：Codex → DSH

### 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_task` | **同步**派活：开会话、投递、阻塞到这一轮结束，只返回**最终回答** |
| `dsh_spawn` | **异步**派活：立刻返回 `task_name` + `sessionId`，可并行开多个 |
| `dsh_followup` | 给已有 worker 再派一轮（复用上下文） |
| `dsh_wait` | 一次等多批 worker，任一到达终态即返回 |
| `dsh_close` | 关闭 worker，释放并发名额（不删除会话） |
| `dsh_answer` | 代用户回答 worker 提出的问题（见「问题上报」） |
| `dsh_list_workers` | 列出本桥开的 worker 及实时状态 |
| `dsh_dispatch` | 向指定会话投递一条用户消息并开始一轮；返回 `requestId` 与 `seqAtDispatch` |
| `dsh_read_result` | **长轮询**读该会话在 `seqAtDispatch` 之后的全部助手文本（看过程用；要结果用 `dsh_wait`） |
| `dsh_list_sessions` | 列出会话**元数据**（id、标题、工作目录、是否运行、最后活动时间） |

### 基本用法

```js
// 同步：等它跑完，直接拿最终答案
dsh_task({ prompt: "审一下 src/bridge.ts 的错误处理", cwd: "/repo", timeoutSeconds: 300 })

// 并行：先拿句柄，再批量等
dsh_spawn({ task_name: "audit_api", message: "…", cwd: "/repo" })
dsh_spawn({ task_name: "audit_ui",  message: "…", cwd: "/repo" })
dsh_wait({ targets: ["audit_api", "audit_ui"], timeoutMs: 240000 })

// 续派：复用 worker 的上下文
dsh_followup({ worker: "audit_api", message: "把第 3 条展开，给出补丁" })
```

边界：

- `dsh_list_sessions` **只返回元数据**，不含任何消息内容；
- `dsh_read_result` 只对**本桥派发过**的会话生效，从未派发过的会话一律拒绝。

### 指定模型

`dsh_task`、`dsh_spawn`、`dsh_followup` 都可以带 `model`：

```js
dsh_task({ prompt: "…", model: "zai-coding-cn/glm-5.3", reasoningEffort: "max" })
dsh_spawn({ task_name: "review", message: "…", model: "opencode-go/deepseek-v4.1-flash" })
```

- 写法是 `provider/model`；只写模型名时沿用当前默认 provider；
- `reasoningEffort` 可选，取值随模型；
- 不传就完全不动会话；
- 实测：请求确实切到指定模型，且**不会改写 profile 的默认模型**。

实现上是在建好会话、发第一个 prompt **之前**调一次 `selectModel`，所以 worker 第一轮就在新模型上跑。

### 项目归属（`workspace`）

DSH 的侧边栏分组（项目 / workspace）和工作目录是两回事：新建会话默认落在「未分组」，除非所在目录已经是项目。

```js
dsh_task({ prompt: "…", cwd: "/repo/clawer", workspace: true })     // 用目录名建项目
dsh_spawn({ task_name: "w1", message: "…", cwd: "/repo/clawer", workspace: "Clawer" })
dsh_task({ prompt: "…", cwd: "/repo/clawer" })                      // 只复用，不创建
```

- 目录不存在时先递归创建，再做项目登记（登记要求目录已存在）；
- 目录已经是项目 → **复用，不改标题**；
- 返回里带 `workspace: { id, title, path }`；
- 项目操作失败不影响派发本身。

### 排队还是插话（`mode`）

DSH 的「繁忙时的发送行为」只有两种，桥原样交给调用方：

| `mode` | DSH 里的名字 | 行为 |
| --- | --- | --- |
| `queue`（默认） | 排队发送 | 等当前回合跑完，作为新回合处理 |
| `steer` | 插话发送 | 并入当前回合，模型下一步就能看到 |

```js
dsh_followup({ worker: "w1", message: "接下来只改 src 下的文件", mode: "steer" })
```

两个实测结论：

1. **`steer` 不打断正在执行的工具**——worker 若正卡在 `sleep 90` 这类调用里，消息要等它返回才被看到（实测 70 秒）。真想立刻停下是界面上的「取消」，不是投递模式。
2. **`steer` 不新开回合**（turn 编号不变），所以桥等的是「当前回合结束」；等「下一回合」会一直等到超时。

`dsh_task` 对正在运行的会话默认拒绝，错误信息会提示改用 `steer`。插话的回复和原任务在同一回合里，桥会定位到**自己那条 user/message** 之后再取回答，避免混进原任务后续步骤的输出。

### 无人值守（`assumeDefaults`）

worker 卡在 `ask_user_question` 上时需要有人在界面上点一下，但调用方是另一个 agent 时那个人往往不在。因此桥在派发时**自动追加一条常驻指令**：

```
（如果缺少必要信息或需要在多个方案里选择，直接采用最合理的默认做法继续做完，
  不要把选择权抛回给用户、不要调用 ask_user_question 等回答；
  在结果里用一行说明你假设了什么。）
```

- 默认开启，`assumeDefaults: false` 可关；
- `dsh_task`、`dsh_spawn`、`dsh_followup` 三条路径都会加；
- prompt 里本来就提到 `ask_user_question` 时不追加。

效果：worker 不会停下来等人，而是选一个合理默认做法做完并交代假设，调用方据此复核。

### 问题上报（`pendingQuestion`）

worker 真的问了问题时，`dsh_wait` 会把问题原样带出来：

```jsonc
{
  "status": { "w1": "running" },
  "timedOut": true,
  "pendingQuestion": {
    "callId": "call_abc",
    "questions": [{
      "id": "mode",
      "question": "用哪种模式？",
      "header": "Choose Mode",
      "options": [{ "label": "快速", "description": "只跑单测" }, { "label": "完整" }]
    }]
  },
  "next": "blocked on a question: answer it with dsh_answer, or call dsh_wait again"
}
```

`dsh_answer({ worker, answers: [{ id, selected: [...] }] })` 用来代答。**已知限制**：DSH 的 `userQuestions.answer()` 只接受已经超时、进入 `continued` 状态的问题；还阻塞在工具调用里的问题是 Web UI 的 answerer 接管的，桥答不了（实测返回 `answered: false`）。所以实际使用中更该依赖上面的 `assumeDefaults`，而不是等 worker 提问。

---

## 反向：DSH → Codex / Claude Code

两个工具都会给本部署的 Agent 注册，参数形状一致，差别只在底层 CLI。

### `codex_dispatch`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，任务正文 |
| `cwd` | 工作目录，默认当前会话目录 |
| `resume` | Codex 线程 id，续接同一线程 |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` |

返回 `{ ok, text, threadId, exitCode, durationMs }`。执行 `codex exec [resume <id>] --json -o <临时文件>`，从事件流取 `thread.started`、从 `-o` 取最终消息。**`resume` 时 `sandbox` 与 `cwd` 不生效**——`codex exec resume` 不接受 `-s` / `-C`。

### `claude_dispatch`

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填，任务正文 |
| `cwd` | 工作目录 |
| `resume` | Claude Code 的 session id |
| `model` | 模型别名或 id；不传则用配置，再退回 CLI 自己的设置 |

返回 `{ ok, text, sessionId, durationMs }`。执行 `claude -p --output-format json`，只读 stdout 的单个 JSON 对象；**stderr 的警告不算失败**（模型名带 `[1M]` 后缀时 CLI 会警告，但结果正常）。

---

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
| `port` | `47821` | 回环端口；固定端口让客户端那条 URL 重启后依然有效 |
| `endpointFile` | `~/.dsh/bridge/endpoint.json` | 端点与令牌落盘位置 |
| `maxResultChars` | `20000` | 单次结果返回的最大字符数（超出保留尾部） |
| `taskTimeoutSeconds` | `300` | `dsh_task` 等待上限（客户端可覆盖，最大 240） |
| `assumeDefaults` | `true` | 派发时追加「自行决策」的常驻指令 |
| `workersFile` | `~/.dsh/bridge/workers.json` | worker 注册表（0600） |
| `maxHops` | `1` | 跨工具委派层数上限 |
| `dispatchPerMinute` | `10` | 滚动窗口内的派发次数 |
| `dispatchWindowMs` | `60000` | 上述窗口长度 |
| `maxWorkersPerRoot` | `4` | **每个工作目录**的 worker 上限 |
| `maxWorkers` | `12` | 全局上限 |
| `workerTtlMs` | `86400000` | 记录过期后不再占名额 |
| `waitTimeoutMs` | `240000` | `dsh_wait` 默认超时 |
| `readWaitSeconds` | `25` | `dsh_read_result` 默认长轮询时长 |
| `codexBin` | `codex` | Codex 可执行文件；含 `/` 时严格按路径解析 |
| `codexSandbox` | `workspace-write` | `codex_dispatch` 默认 sandbox |
| `codexTimeoutMs` | `300000` | 单次 `codex_dispatch` 超时 |
| `claudeBin` | `claude` | Claude Code 可执行文件 |
| `claudeModel` | 空 | 默认让 Claude CLI 用自己的设置 |
| `claudeTimeoutMs` | `300000` | 单次 `claude_dispatch` 超时 |

端口被占用时不会静默换端口：端点文件里写入 `error` 字段，宿主日志打印 `subagent-bridge: could not start on port …`。

---

## 护栏与限制

### 防环

两个 agent 都接了同一个桥时存在真实环路：DSH worker → `codex_dispatch` → 那次 Codex 也能看到 `dsh-bridge` → 又 `dsh_spawn` → …。双方进程内的深度规则都管不到这条链（桥建的 worker 是顶层会话，深度恒为 0）。

**① 深度（`maxHops`，默认 1）**：每次派发都计算 `max(在飞链路深度, 调用方深度) + 1`，超限直接报错：

```
codex_dispatch would create delegation depth 2, but maxHops is 1.
Carry the work out directly instead of delegating again.
```

**② 速率（`dispatchPerMinute`，默认 10）**：拦截广度型失控与紧循环重试：

```
rate limit: 10 dispatches per 60s reached; retry in 23s
```

### 名额

- 每个 `cwd` 默认 **4 个**（`maxWorkersPerRoot`），全局 **12 个**（`maxWorkers`）；
- **完成但没 `dsh_close` 的仍占名额**；
- 记录 **24 小时**没更新自动释放；
- 阻塞式 `dsh_task` 不计入名额，只登记。

按 `cwd` 分桶而不是按会话，是因为 MCP 端点共享、请求里没有会话身份；`cwd` 是唯一由调用方稳定提供、且语义上对应「一个项目」的维度。

### 跨重启

worker 注册表和每轮的时间基线落在 `~/.dsh/bridge/workers.json`：

- 重启后 `dsh_list_workers` 仍能看到之前的 worker；
- 已结束的 worker，`dsh_wait` 直接返回缓存里的最终回答；
- 重启时还在跑的，会话未打开时状态为 `offline`；
- `dsh_followup` 会开新一轮并清掉旧回答；
- 最多保留 200 条，超出先淘汰最旧的已关闭 worker。

### 安全模型

- 只监听 `127.0.0.1`；
- 请求必须带令牌：路径 `/mcp/<token>` 或 `Authorization: Bearer <token>`，定长时间比较；
- 令牌首次启动生成并持久化，能力 URL 稳定；
- 能力等价于「向指定会话投递消息」：能读到端点文件的进程就能派活，文件 0600、目录 0700；
- DSH 侧的权限策略不受影响，派进去的消息仍按会话自身的 sandbox / 审批策略执行。

---

## 实现

```
Codex / 任意 MCP 客户端
  │  POST /mcp/<token>   JSON-RPC（stateless，单次 JSON 响应）
  ▼
dsh-plugin-subagent-bridge（宿主进程内）
  · node:http 监听 127.0.0.1:47821
  · initialize / tools/list / tools/call / ping
  · sessionController.prompt({ sessionId, requestId, mode, content })
  · sessions.get(id).snapshotEvents() 读回助手文本
```

协议是 **streamable HTTP 的无状态子集**：每个 POST 返回一段 `application/json`，不做服务端推送，因此取结果用**长轮询**——`dsh_read_result` 在服务端等，客户端一次调用即可拿到答案；客户端断开时服务端立即停止等待。

---

## 配套 skill

`skills/` 下有两份可直接安装的 skill，把「什么时候该派活、怎么派、怎么收尾」写成模型能读的规则：

| Skill | 装给谁 | 作用 |
| --- | --- | --- |
| `deepseek-worker` | Codex | 让 Codex 把任务当 subagent 派给 DSH（`dsh_task`），一次调用等结果 |
| `delegate-to-external-agent` | DSH | 让 DSH 的 agent 在需要独立视角/复核时派给 Codex 或 Claude Code，含两者差别与续接方式 |

```bash
# Codex 侧
mkdir -p ~/.codex/skills && cp -R skills/deepseek-worker ~/.codex/skills/

# DSH 侧
mkdir -p ~/.dsh/skills && cp -R skills/delegate-to-external-agent ~/.dsh/skills/
```

两份都是标准 `SKILL.md`：YAML frontmatter（`name` + `description`）+ 正文。**触发靠 description**——模型平时只看到名字和描述，判断相关了才读正文，所以描述里写满了中英触发语和「不要用」的边界。改完立刻生效，不用重启。

---

## 兼容性

- DSH `^0.2.1-0`（`engines.dsh`）；
- MCP 协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`（按客户端请求回显，未知版本回落到最新）；
- 依赖宿主公开服务 `sessionController`、`sessions`、`workspaceRegistry`、`userQuestions`；不可用时工具返回明确错误。

## 开发

```bash
node --test "test/*.test.mjs"
```

83 项，覆盖握手与版本协商、工具清单与参数校验、派发调用形状、结果读取的时间基线、长轮询、真实 HTTP 往返（含 404/405/202 与 bearer 分支）、`codex exec` 事件解析与二进制解析、成功/失败/超时三种运行结果、resume 的参数分叉、只回最终回答、`dsh_wait` 的四种终态、并发上限与释放、followup 重基线、注册表落盘与重启复原、`maxHops` 与速率限制、按 `cwd` 分桶的预算、工作区归属、`workspace` 创建与复用、`queue` / `steer` 的投递与等待、插话回答的定位、`claude` 输出解析与 resume 参数、`assumeDefaults` 指令注入、`pendingQuestion` 与 `dsh_answer`。

`test/persistence.test.mjs` 单独覆盖持久化：文件权限、缺失/损坏记录、并发写、冷会话缓存与 `offline`。

---

## 相关插件

| 插件 | 说明 |
| --- | --- |
| **dsh-plugin-subagent-bridge**（本仓库） | 让 Codex 通过本机 MCP 把 DSH 当 subagent 用，反向也能派给 Codex / Claude Code |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | 预测下一条指令并显示为占位文字，`Tab` 采纳 |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |
| [dsh-plugin-usage-panel](https://github.com/Dogtiti/dsh-plugin-usage-panel) | 在模型选择器旁显示供应商套餐额度余量 |
| [dsh-plugin-provider-icons](https://github.com/Dogtiti/dsh-plugin-provider-icons) | 在模型名旁显示供应商品牌 logo |

## 许可

MIT © [Dogtiti](https://github.com/Dogtiti)
