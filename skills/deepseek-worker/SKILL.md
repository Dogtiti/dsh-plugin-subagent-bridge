---
name: deepseek-worker
description: 交给 DSH / 开个 worker 时使用；把自足任务当 subagent 派给 DeepSeek Harness：dsh_task 一次调用开会话、等这一轮干完、拿回结论。不用于几行改动或 DSH 未启动。
---

# 把任务交给 DSH（subagent 用法）

DSH 是通过 `dsh-bridge` MCP 接上来的另一个编码代理。用法和"给自己开一个 subagent"一样：**一次调用，给它一个自足的任务，等它把这一轮干完并返回结论。**

## 先确认工具在

工具列表里应当有 `dsh_task`、`dsh_dispatch`、`dsh_read_result`、`dsh_list_sessions`。

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

`dsh_task` **阻塞到 DSH 那一轮结束**再返回，不需要轮询。默认最多等 300 秒，更重的任务传 `timeoutSeconds`（上限 600）。

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

## 拿到结果之后

- `completed` → 读 `text`，判断是否真的达成交付；需要复核就自己跑一遍验证命令。
- `turn-…`（如 `turn-aborted`、`turn-error`）→ 那一轮没正常结束，把 `text` 里的信息转述给用户，必要时自己接手。
- `timeout` → 工作**没有丢**，DSH 那边还在跑。用同一个 `sessionId` 再调一次问进度，或先用低阶工具看一眼。

## 同一个 worker 继续干

```jsonc
dsh_task({ "sessionId": "session-…", "prompt": "再把失败的那个用例补上" })
```

适合"先改、看了再补"的往返。目标会话正在跑时会被拒绝（提示改用 `dsh_dispatch`），这是有意的。

## 低阶工具（一般不用）

只有"给一个已在用的 DSH 会话留言"才用：`dsh_dispatch` 投递、`dsh_read_result` 长轮询取回。日常派活一律 `dsh_task`。

## 回报给用户

三句话以内：派给了谁（新 worker / 某 session）、结果如何（`status` + 核心结论）、下一步建议。**不要把 worker 的长文整段贴回来**。

## 不要做

- 不要把密钥、私有凭据写进 `prompt`——它会进入 DSH 的会话日志。
- 不要让 worker 操作你的本地环境（它有自己的权限与目录）。
- 不要把三件不相关的事塞进一次调用；拆开更可控。
- 不要在 DSH 未启动时假装委派成功。
