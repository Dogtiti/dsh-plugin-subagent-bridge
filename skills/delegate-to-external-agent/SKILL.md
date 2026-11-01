---
name: delegate-to-external-agent
description: 交给外部 agent / 让另一个 agent 审一下 / review / 第二意见 / 交叉验证 / 用另一个模型验证 / 交给 Codex / 交给 Claude 实现时使用。用 codex_dispatch 或 claude_dispatch 把任务派给本机的 Codex 或 Claude Code，一次调用阻塞到它退出拿到回答，可用 resume 续同一会话。不用于几行改动，也不用于对应的 CLI 未安装或未登录时。
---

# 把任务交给外部 agent

同一台机器上可能装着另一个编码代理：**Codex**（`codex_dispatch`）或 **Claude Code**（`claude_dispatch`）。两者都是「一次调用 → 阻塞到它退出 → 返回最终回答 + 可续接的会话 id」。

## 先确认可用

- 工具列表里有 `codex_dispatch` / `claude_dispatch` 才能用。没有 → 这个部署没装 `dsh-plugin-subagent-bridge`，或者对应二进制没找到。
- 返回 `codex executable not found` / `claude executable not found` → CLI 不在 PATH。告诉用户在插件配置 `codexBin` / `claudeBin` 里指绝对路径，不要反复重试。
- 返回 `exited with …` → 多半是未登录、额度用尽或模型名不被支持。把后面几行原样转述，别自己编原因。

## 选哪个

| 情况 | 选 |
| --- | --- |
| 用户点名了（「让 Codex」「叫 Claude 看看」） | 听用户的 |
| 只是要个独立视角/第二意见 | 优先选和自己**不同模型家族**的那个 |
| 其中一个不可用 | 用另一个，并在回报里说明 |

两个工具都**看不到这段对话**，prompt 的写法完全一样。

## 基本调用

```jsonc
// Codex
codex_dispatch({
  "prompt": "自足的审查/实现任务 + 验收标准",
  "cwd": "/Users/.../当前仓库",
  "sandbox": "read-only"        // 只审不改；要它改代码时用 workspace-write（默认）
})

// Claude Code
claude_dispatch({
  "prompt": "自足的审查/实现任务 + 验收标准",
  "cwd": "/Users/.../当前仓库",
  "model": "sonnet"             // 可选，不传就用 CLI 自己的设置
})
```

返回（工具视图里会附带一行 `[codex thread …]` 或 `[claude session …]`）：

```jsonc
// Codex
{ "ok": true, "text": "审完了，两个问题…", "threadId": "01a1…", "exitCode": 0, "durationMs": 34000 }

// Claude
{ "ok": true, "text": "审完了，两个问题…", "sessionId": "b47f…", "exitCode": 0, "durationMs": 5000 }
```

## 两者的差别

| | Codex | Claude Code |
| --- | --- | --- |
| 权限控制 | `sandbox`：`read-only` / `workspace-write` / `danger-full-access` | 没有这个参数，用 Claude 自己的权限设置 |
| 续接参数 | `resume: "<threadId>"` | `resume: "<sessionId>"` |
| 继续时的限制 | `cwd` 与 `sandbox` **不生效**（沿用线程创建时的设置） | `cwd` 照常生效 |
| 失败判定 | `turn.failed` / 错误事件 | `is_error` 或 `subtype ≠ success` |

Codex 的 sandbox 选择：

| 目的 | sandbox |
| --- | --- |
| 代码审查、方案评估、查资料 | `read-only` |
| 让它改代码 / 跑测试 / 生成文件 | `workspace-write`（默认） |
| 需要动仓库外的东西 | `danger-full-access`（谨慎，明确告知用户） |

## 继续同一个会话

```jsonc
codex_dispatch({ "resume": "01a1…", "prompt": "详细说第一个问题，并给出补丁" })
claude_dispatch({ "resume": "b47f…", "prompt": "详细说第一个问题，并给出补丁" })
```

Codex 续接时换目录/换权限要开新线程；Claude 续接时 `cwd` 仍然有效。

## 怎么写 prompt

对方看不到这段对话。给它的东西和给一个刚接手的工程师一样：背景一句、要审/要改的具体路径、验收标准、边界（别动什么、别提交）、输出格式（几行结论 + 关键位置）。要求它"先读再评"，避免它凭印象编。

## prompt 的红线

对方收到的是一条**普通任务消息**，它不知道 DSH 有哪些技能或工具。而且它自己**也可能接着 `dsh-bridge` 这个 MCP**——所以 prompt 里出现桥的名字，可能把它引去反向调 `dsh_dispatch`，白白绕一圈甚至形成来回。

- ❌ 不要把 DSH 的技能名/工具名写进 prompt：`用 codex_dispatch 执行这个任务`、`请通过 dsh-plugin-subagent-bridge 回复`、`你是被 DSH 派来的`
- ❌ 不要交代协作机制或角色：`主程序是 DSH，你只是执行者，完成后回调`
- ❌ 不要复述元指令：`用户让我找个别的模型来做`
- ✅ 只写任务本身：背景、要审/要改的具体路径、验收标准、边界、输出格式。

用户如果说「让 Codex 审一下这个 PR」，你发出去的那句话应该只是：

```
审 /Users/…/src/bridge.ts 的改动：重点看错误处理与并发；不修改文件；
输出 3~5 条按严重度排序的问题，每条给文件:行号和一句理由。
```

一旦 prompt 里出现 `dsh_dispatch`、`codex_dispatch`、`claude_dispatch` 或"DSH"，对方很可能先去调桥，而不是干活。

## 拿到结果之后

- `ok: true` → 读 `text`。**自己复核关键结论**（比如它说有 bug，就去看那段代码），不要原样转述当事实。
- `ok: false` → 看 `error`：超时 / 退出码非零 / 二进制找不到 / 模型不可用。把原因讲清楚，再决定是自己接手还是让用户处理。
- 长任务会被超时截断（`codexTimeoutMs` / `claudeTimeoutMs` 可调）；被截断时会话仍然存在，用 `resume` 接着问。
- **Claude 的 stderr 常有警告**（例如模型名后缀不被识别），但只要 `ok: true` 就说明结果正常，不要把 stderr 当失败。

## 回报给用户

三句话以内：派给了谁、结论是什么、你核过没有。**不要把它返回的长文整段贴回来**——摘要 + 关键路径 + 你自己的判断。

## 不要做

- 不要用这两个工具代替你自己就能可靠完成的小改动。
- 不要把密钥、私有凭据写进 `prompt`——它会进入对方的会话记录。
- 不要在对方返回失败时假装成功，也不要把它的推测当结论转述。
- 不要在 `read-only` 下指望 Codex 真的改了文件。
