---
name: deepseek-worker
description: 交给 DSH / 开个 worker 时使用；把自足任务当 subagent 派给 DeepSeek Harness：dsh_task 一次调用开会话、等这一轮干完、拿回结论。不用于几行改动或 DSH 未启动。
---

# 把任务交给 DSH（subagent 用法）

DSH 是通过 `dsh-bridge` MCP 接上来的另一个编码代理。用法和"给自己开一个 subagent"一样：**给它一个自足的任务，等它把这一轮干完并返回结论。**

> **最重要的一条：任务没跑完，不许结束回合。**
> Codex 原生的 subagent 会把结果**推送**回来、自动唤醒你；这个桥是**拉取**式的 —— 你结束回合，结果就没人接收了，用户只能人工来叫你回去。所以：只要还有 `running` 的 worker，就必须继续调 `dsh_wait` / `dsh_task` / `dsh_read_result`，直到全部到终态。

> **单次调用最长 240 秒。** Codex 的 MCP 客户端在 **300 秒**时会把工具调用判为失败（`timed out awaiting tools/call after 300s`）。所以 `timeoutSeconds` / `timeoutMs` / `waitSeconds` 一律不要超过 240，超了也不会生效（会被夹到 240）。

## 先确认工具在

工具列表里应当有：`dsh_task`、`dsh_spawn`、`dsh_wait`、`dsh_followup`、`dsh_close`、`dsh_list_workers`、`dsh_dispatch`、`dsh_read_result`、`dsh_list_sessions`。

- 没有 `dsh_task` → DSH 没启动或 MCP 未接入。直接告诉用户"需要先启动 DeepSeek Harness"，**不要假装调用成功**。
- 调用报连接错误 → 报错误原文，然后自己把这件事做掉，不要反复重试。

## 默认动作：`dsh_task`

```jsonc
dsh_task({
  "prompt": "自足的任务描述 + 验收标准",
  "cwd": "/Users/.../当前仓库"          // 当前项目根目录
})
```

返回：

```jsonc
{
  "sessionId": "session-…",   // 续做时用它
  "created": true,
  "status": "completed",       // completed | turn-<reason> | timeout
  "text": "worker 的最终回答",
  "turns": 3,
  "durationMs": 42000
}
```

`dsh_task` **阻塞到 DSH 那一轮结束**再返回，最多等 **240 秒**（默认值，也是上限）。超时它不会假装成功，而是明确告诉你还在跑：

```jsonc
{ "status": "timeout", "running": true, "text": "",
  "next": "the worker is still running; do not end the turn. Call dsh_wait(...) and repeat until it is not running." }
```

**看到 `running: true` 就继续等**，不要结束回合、也不要把空 `text` 当成"它没干成"。

最省事的续等方式（`dsh_task` 本身会阻塞，再调一次同一个 sessionId 等价于继续等）：

```jsonc
dsh_task({ "sessionId": "session-…", "prompt": "继续", "timeoutSeconds": 240 })
```

更好的方式是不用 `dsh_task` 的续做语义，而是直接用 `dsh_wait` 等它（见下节）。

## 多件活：并行开 worker

互不依赖的子任务，**并行比串行快**，而且往往质量更好（每个 worker 有干净的上下文）。这是 Codex 自己多智能体策略的原话，照抄过来：

> 只要并行能省时间或提高质量，就应该把任务分出去（无论你是主 agent 还是子 agent）。

流程：

```jsonc
// 1. 一次开多个，每个都立刻返回，不等结果
dsh_spawn({ "task_name": "audit_api",   "message": "审 src/api/**，只出问题清单" })
dsh_spawn({ "task_name": "audit_store", "message": "审 src/store/**，只出问题清单" })
dsh_spawn({ "task_name": "run_tests",   "message": "跑全量测试，只报失败用例" })

// 2. 等任意一个先完成（谁先好先用，不必等全部）
dsh_wait({ "targets": ["audit_api", "audit_store", "run_tests"], "timeoutMs": 300000 })
// → { "status": { "audit_api": { "completed": "…" }, "audit_store": "running", … } }

// 3. 处理已完成的，继续等剩下的；完工的记得关掉
dsh_close({ "worker": "audit_api" })
```

**规则（与 Codex 一致）**

- **并发上限 4 个 worker**（`maxWorkers`）。**已完成但没 `dsh_close` 的也占名额** —— 用完就关，别一直挂着。
- `dsh_task` 是阻塞的、一次一件；它**不占**那 4 个名额，适合"我就等着这一件"。
- `dsh_wait` 每次给满 **240000**（毫秒）。**它返回 `timedOut: true` / 仍有 `"running"` 时，不代表结束，只代表"还没好"** —— 继续调它，直到没有任何 target 是 `running`/`pending`。短超时反复轮询是错的（Codex 原话：prefer longer waits (minutes) to avoid busy polling）。
- `dsh_wait` 只要**任意一个**到终态就返回，所以它是"收割完成项"的循环，而不是"等全部"。

**不要并行的情况**

- 任务之间**有先后依赖**（B 要用 A 的结论）。
- 多个 worker 要改**同一批文件**：它们各自在自己的会话里，但落在同一个仓库，并发改同一文件会互相覆盖。要并行就按目录/模块切分，并在 prompt 里写死各自的边界。
- 你还没想清楚验收标准 —— 先想清楚再拆，否则只是把混乱放大 4 倍。

**需要上下文时**

```jsonc
dsh_spawn({ "task_name": "continue_here", "fork_turns": "all",
            "from": "session-…",            // 既有 DSH 会话
            "message": "接着这个会话继续修那个失败用例" })
```

`fork_turns: "all"` 会 fork 那个会话作为 worker 的起点（继承到最近一个已完成 turn），worker 的后续改动**不会**污染原会话。默认 `"none"` 是全新空会话。


## 让它自己并行（DSH 也有 subagent）

DSH **自带** `subagent` 工具（和这座桥无关，是它自己的能力，worker 在深度 0，可以开子 agent）。但它**默认不会用**——不提示就一个人串行干完。

任务能拆成互不依赖的几块时，在 prompt 末尾加一句：

> 这几块互不依赖，可以用你自己的 subagent 并行处理，最后汇总。

实测：4 个互不依赖的乘法 + 这句提示 → 它开了 **4 个 subagent 并行**，43 秒返回汇总，结果全对。不加这句，同样的活它串行做完。

判断标准和 Codex 的 proactive 策略一致：

- ✅ 子任务互不依赖、并行能省时间或提高质量 → 加这句
- ❌ 有先后依赖、要改同一批文件、验收标准还没想清 → 不要加，串行更稳

DSH 自己的委派深度上限是 1：worker（depth 0）能开子 agent（depth 1），子 agent 不能再往下开。所以不会无限递归。

## 怎么写 prompt

worker **看不到你这段对话**，它只有 `prompt` 和 `cwd`。写成可以独立开工的工单：

1. **背景一句话**：什么项目、要解决什么。
2. **具体改动**：文件/模块/行为，能给路径就给。
3. **验收标准**：跑什么命令、期望什么结果（例如 `pnpm vitest` 全绿）。
4. **边界**：不要动哪些文件、不要改哪些接口、不要提交或推送。
5. **输出要求**：结尾几行说明"改了什么、怎么验证、还有什么风险"。

不要写"按上面的讨论去做"——worker 没有你的上下文。

## prompt 的红线

worker 收到的是**一条普通用户消息**，它看不到你这边有没有技能、叫什么名字。所以：

- ❌ 不要把技能名、工具名写进 prompt：`用户明确要求使用 deepseek-worker 写…`、`请用 dsh_task 执行…`、`你是 deepseek-worker 子代理…`
- ❌ 不要给它派角色或交代你们的协作机制：`你现在是一个 subagent，完成后回调…`
- ❌ 不要复述用户的元指令：`用户说了要 DeepSeek 来做，所以…`
- ✅ 只写**任务本身**：目标、位置、验收标准、边界。

用户如果说「用 deepseek-worker 写个冒泡」，你派出去的那句话应该只是：

```
用 Python 实现 bubble_sort(nums)：原地升序、相邻比较交换、无交换提前结束；
附调用示例；覆盖空列表/单元素/重复值/负数/已排序/逆序；不读写文件、不执行命令。
```

一旦 prompt 里出现 `deepseek-worker`，worker 会以为那是它自己的技能或工具，白费一轮去确认「本会话没有这个技能」。

## 收工的判断标准

下面三件事同时成立，才可以结束回合：

1. 所有派出去的 worker 状态都是 `{completed}` / `{errored}` / `"closed"` / `"not_found"` / `"offline"`；
2. 没有任何 worker 是 `"running"` 或 `"pending"`；
3. 你已经对每个完成的 worker 做过必要的复核（跑测试、看 diff）。

只要还有 `running`，就继续 `dsh_wait`。**宁可多等一轮，也不要留一个没人收的 worker。**

## 拿到结果之后

- `completed` → 读 `text`，判断是否真的达成交付；需要复核就自己跑一遍验证命令。
- `turn-…`（如 `turn-aborted`、`turn-error`）→ 那一轮没正常结束，把 `text` 里的信息转述给用户，必要时自己接手。
- `timeout`（带 `running: true`）→ 工作**没有丢**，DSH 那边还在跑。**必须继续等**：`dsh_wait({targets:[…]})` 或再调一次 `dsh_task({sessionId, …})`，直到不是 running。

## 同一个 worker 继续干

```jsonc
dsh_followup({ "worker": "audit_api", "message": "把第 3 条展开，给出补丁" })
```

`dsh_followup` 复用该 worker 的会话，比新开一个便宜。也可以用 `dsh_task({ "sessionId": …, "prompt": … })` 做同样的事（阻塞版）。

## 查现在有哪些 worker

```jsonc
dsh_list_workers()   // [{ task_name, sessionId, status }, …]
```

`status` 是 `"running"` / `"pending"` / `{completed}` / `{errored}` / `"closed"` / `"offline"`（重启后会话没打开且无缓存结果）。**重启 App 之后这些记录仍在**（落在 `~/.dsh/bridge/workers.json`）。

## 低阶工具（一般不用）

只有"给一个已在用的 DSH 会话留言"才用：`dsh_dispatch` 投递、`dsh_read_result` 长轮询取回。日常派活一律 `dsh_task`。

## 回报给用户

三句话以内：派给了谁（新 worker / 某 session）、结果如何（`status` + 核心结论）、下一步建议。**不要把 worker 的长文整段贴回来**。

## 不要做

- 不要把密钥、私有凭据写进 `prompt`——它会进入 DSH 的会话日志。
- 不要让 worker 操作你的本地环境（它有自己的权限与目录）。
- 不要把三件不相关的事塞进一次调用；拆开更可控（也可以直接并行）。
- 不要超过 4 个 worker，也不要让已完成的 worker 一直挂着不关。
- 不要在 DSH 未启动时假装委派成功。
