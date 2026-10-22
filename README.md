# dsh-plugin-subagent-bridge

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)

在 DeepSeek Harness 宿主内部提供**本机回环 MCP 端点**，让另一个智能体（如 Codex）把任务派给 DSH 会话并取回结果。

插件运行在宿主进程内，直接使用公开的 `sessionController` 服务 —— 不需要读取 `~/.dsh/.credentials.yaml`，也不需要伪造 cookie。

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_task` | **同步**派活：开会话、投递、阻塞到这一轮结束，只返回**最终回答**（最后一条 assistant 消息） |
| `dsh_spawn` | **异步**派活：立刻返回 `task_name` + `sessionId`，可同时开多个 worker 并行跑 |
| `dsh_followup` | 给已有 worker 再派一轮（复用它的上下文） |
| `dsh_close` | 关闭 worker，释放并发名额（不删除会话） |
| `dsh_list_workers` | 列出本桥开的 worker 及其实时状态 |
| `dsh_wait` | 一次等多批 worker：`targets` + `timeoutMs`，任一到达终态即返回 `{completed}` / `{errored}` / `"running"` / `"not_found"` |
| `dsh_dispatch` | 向指定会话投递一条用户消息并开始一轮；返回 `requestId` 与 `seqAtDispatch` |
| `dsh_read_result` | **长轮询**读进度：返回该会话在 `seqAtDispatch` 之后的**全部**助手文本（用于看过程；要结果用 `dsh_wait`） |
| `dsh_list_sessions` | 列出会话**元数据**（id、标题、工作目录、是否运行、最后活动时间） |

## 反向：DSH → Codex

插件同时给本部署的 Agent 注册了一个工具：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `codex_dispatch` | `prompt`（必填）、`cwd`、`resume`（线程 id）、`sandbox` | `{ ok, text, threadId, exitCode, durationMs, error? }` |

它执行 `codex exec [resume <id>] --json -o <临时文件>`，从事件流取 `thread.started`、从 `-o` 文件取最终消息；工具结果里会带 `[codex thread <id> · 12s]`，把那个 id 传给 `resume` 就能继续同一个 Codex 线程（实测能记住上一轮的回复）。

注意：**`resume` 时 `sandbox` 与 `cwd` 不生效** —— `codex exec resume` 子命令本身不接受 `-s` / `-C`，线程沿用它原来的设置。

边界（v0 硬约束）：

- `dsh_list_sessions` **只返回元数据**，不含任何消息内容。
- `dsh_read_result` 只对**本桥派发过**的会话生效；从未派发过的会话一律拒绝。

---

## 安装

```bash
# 本地目录安装
git clone https://github.com/Dogtiti/dsh-plugin-subagent-bridge
```

Plugins → 添加 → 选该目录。

启动后插件在 `127.0.0.1:47821` 监听，并写入端点文件（权限 0700/0600）：

```json
{
  "url": "http://127.0.0.1:47821/mcp/<token>",
  "port": 47821,
  "token": "<token>",
  "pid": 12345,
  "startedAt": "2026-10-22T12:30:00.000Z"
}
```

路径：`~/.dsh/bridge/endpoint.json`

## 接到 Codex

```bash
codex mcp add dsh-bridge --url "$(node -p "require(process.env.HOME+'/.dsh/bridge/endpoint.json').url")"
```

验证：

```bash
codex mcp list
codex mcp get dsh-bridge
```

Codex 的桌面 App 与 CLI 共用 `~/.codex/config.toml`，所以两端都会看到这条。

> token 存在 URL 路径里（能力 URL），因此不需要在 Codex 侧配置环境变量 —— 桌面 App 从 Finder 启动时拿不到自定义环境变量。若你更想用 bearer，也可以 `--bearer-token-env-var` 指向环境变量，插件同时支持 `Authorization: Bearer <token>`。

移除：

```bash
codex mcp remove dsh-bridge
```

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
| `port` | `47821` | 回环监听端口；固定端口是为了让 Codex 侧那条 URL 在重启后依然有效 |
| `endpointFile` | `~/.dsh/bridge/endpoint.json` | 端点与令牌的落盘位置 |
| `maxResultChars` | `20000` | 单次 `dsh_read_result` 返回的最大字符数（超出保留尾部） |
| `taskTimeoutSeconds` | `300` | `dsh_task` 等待一轮结束的默认上限（客户端可用 `timeoutSeconds` 覆盖，最大 600） |
| `workersFile` | `~/.dsh/bridge/workers.json` | worker 注册表与重基线的落盘位置（0600） |
| `maxHops` | `1` | 跨工具委派层数上限（1 = 只允许一层，和 Codex / DSH 的默认 `maxDepth: 1` 一致） |
| `dispatchPerMinute` | `10` | 滚动窗口内允许的派发次数（spawn / task / dispatch / followup / codex_dispatch 合计） |
| `dispatchWindowMs` | `60000` | 上述窗口长度 |
| `maxWorkers` | `4` | 同时打开的 worker 上限；**已完成但未 `dsh_close` 的也占名额**（与 Codex 一致） |
| `waitTimeoutMs` | `30000` | `dsh_wait` 的默认超时（1s ~ 1h，客户端可用 `timeoutMs` 覆盖） |
| `readWaitSeconds` | `25` | `dsh_read_result` 的默认长轮询时长（上限 55，客户端可用 `waitSeconds` 覆盖） |
| `codexBin` | `codex` | Codex 可执行文件；含 `/` 时按路径严格解析，找不到就报错而不回退 |
| `codexSandbox` | `workspace-write` | `codex_dispatch` 的默认 sandbox（`resume` 时无效） |
| `codexTimeoutMs` | `300000` | 单次 `codex_dispatch` 超时，超时先 SIGTERM 再 SIGKILL |

端口被占用时插件不会静默换端口：端到端文件里会写入 `error` 字段，并在宿主日志打印 `subagent-bridge: could not start on port …`。

---

## 防环护栏

两个 agent 都接了同一个桥时，存在真实的环路：DSH worker → `codex_dispatch` → 那次 Codex 运行也能看到 `dsh-bridge` → 又 `dsh_spawn` → …。两边**各自进程内**的深度规则都管不到这条链（Codex 的 `agent_max_depth` 只数自己的 `spawn_agent`，DSH 的 `maxDepth` 只看 `delegationDepth`，而桥建的 worker 是顶层会话，深度恒为 0）。

所以桥自带两道：

**① 深度（`maxHops`，默认 1）**

- 每次都计算这次派发会产生的深度：`max(当前在飞的链路深度, 调用方深度) + 1`；
- 调用方是桥建的 worker 时按其深度 1 起算；
- `codex_dispatch` 运行期间会把链路标记为"在飞"，嵌套回来的调用继承该深度；
- 超限直接报错，措辞可执行：
  `codex_dispatch would create delegation depth 2, but maxHops is 1. Carry the work out directly instead of delegating again.`

默认 1 的含义：**Codex 可以派给 DSH，但 DSH 不能再用桥派回去** —— 与两个产品各自的 `maxDepth: 1` 语义对齐。

**② 速率（`dispatchPerMinute`，默认 10 / 60s）**

拦截广度型失控（一次开很多 worker）和客户端紧循环重试，与提示词无关，是纯兜底：

```
rate limit: 10 dispatches per 60s reached; retry in 23s
```

## 跨重启

worker 注册表（`task_name` / `sessionId` / 终态结果）和每轮的时间基线都落在 `~/.dsh/bridge/workers.json`：

- 派发、完成、关闭都会更新它；
- **重启后 `dsh_list_workers` 仍能看到之前的 worker**；
- 已经结束的 worker，`dsh_wait` 直接返回缓存里的最终回答（不必重新打开会话）；
- 重启时还在跑的 worker，会话未打开时状态是 `offline`（结果未知，去 DSH 侧边栏打开那个会话即可查看）；
- `dsh_followup` 会给 worker 开新一轮，同时**清掉**缓存的旧回答；
- 文件最多保留 200 条，超出时先淘汰最旧的 **已关闭** worker。

## 安全模型

- 只监听 `127.0.0.1`，不对外暴露。
- 请求必须携带令牌：路径 `/mcp/<token>`，或 `Authorization: Bearer <token>`；比较使用定长时间比较。
- 令牌首次启动时生成并**持久化**（重启后复用），因此能力 URL 稳定。
- 能力等价于「向指定会话投递消息」：本机任意进程只要能读到端点文件就能派活。文件权限 0600、目录 0700；不要把它复制到共享位置。
- DSH 侧的权限策略不受影响：派发进去的消息仍按会话自身的 sandbox / 审批策略执行。

---

## 实现

```
Codex / 任意 MCP 客户端
  │  POST /mcp/<token>   JSON-RPC（stateless，单次 JSON 响应）
  ▼
dsh-plugin-subagent-bridge（宿主进程内）
  · node:http 监听 127.0.0.1:47821
  · initialize / tools/list / tools/call / ping
  · sessionController.prompt({sessionId, requestId, mode, content})
  · sessions.get(id).snapshotEvents() 读回助手文本
```

协议实现为 **streamable HTTP 的无状态子集**：每个 POST 返回一段 `application/json`，不做服务端推送，因此取结果用**长轮询**——`dsh_read_result` 在服务端等，客户端一次调用即可拿到答案；客户端断开时服务端立即停止等待。

---

## 配套 skill

`skills/` 下有两份可直接安装的 skill，把"什么时候该派活、怎么派、怎么收尾"写成模型能读的规则：

| Skill | 装给谁 | 作用 |
| --- | --- | --- |
| `deepseek-worker` | Codex | 让 Codex 把任务当 subagent 派给 DSH（`dsh_task`），一次调用等结果 |
| `delegate-to-codex` | DSH | 让 DSH 的 agent 在需要独立视角/复核时派给 Codex（`codex_dispatch`） |

```bash
# Codex 侧
mkdir -p ~/.codex/skills && cp -R skills/deepseek-worker ~/.codex/skills/

# DSH 侧
mkdir -p ~/.dsh/skills && cp -R skills/delegate-to-codex ~/.dsh/skills/
```

两份都是标准 `SKILL.md`：YAML frontmatter（`name` + `description`）+ 正文。**触发靠 description**——模型平时只看到名字和描述，判断相关了才读正文，所以描述里写满了中英触发语和"不要用"的边界。改完立刻生效，不用重启：Codex 下一次会话、DSH 下一轮就能看到。

---

## 兼容性

- DSH `^0.2.1-0`（`engines.dsh`）。
- MCP 协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`（按客户端请求回显，未知版本回落到最新）。
- 依赖宿主公开服务 `sessionController`（`list` / `prompt`）与 `sessions.get()`；两者不可用时工具会返回明确错误。

---

## 开发

```bash
node --test "test/*.test.mjs"
```

50 项：握手与版本协商、通知处理、工具清单、未知方法与未知工具、参数校验、元数据列表不含消息内容、派发调用形状、拒绝与错误透出、结果读取的时间基线、未派发会话的拒绝、长轮询（文本晚到即返回 / 超时 / 调用方取消）、真实 HTTP 往返（含 404/405/202 与 bearer 分支）、`codex exec` 事件解析、二进制解析、成功/失败/超时三种运行结果、resume 的参数分叉、工具结果的 lossless JSON 约束、**只回最终回答**（多步叙述被丢弃）、`dsh_wait` 的任一完成 / 超时 / 错误 / 未派发四种状态、`dsh_spawn` 立即返回与注册、`fork_turns=all` 走 fork、并发上限与 `dsh_close` 释放名额、`dsh_followup` 的重基线与最终回答切换、注册表落盘与重启后复原、冷会话下的缓存回答与 `offline` 状态、注册表 200 条上限的淘汰顺序、`maxHops` 拒绝回派而放行首层、在飞链路阻塞嵌套派发、速率突发的拒绝与窗口过期、followup 计入同一预算。
`test/persistence.test.mjs` 单独覆盖持久化：文件权限 0600、缺失/损坏/畸形记录、spawn 返回时文件已落盘、完成即缓存、followup 清缓存、close 后重启仍为 closed、冷会话走缓存或 `offline`、并发写不串。

---

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | 预测下一条指令并显示为占位文字，`Tab` 采纳 |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |

## 许可

MIT © [Dogtiti](https://github.com/Dogtiti)
