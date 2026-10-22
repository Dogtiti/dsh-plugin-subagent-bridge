---
name: delegate-to-codex
description: 让 Codex 审一下 / review / 用另一个模型验证 / 要第二意见 / 交叉验证 / 交给 Codex 实现 时使用。用 codex_dispatch 把任务派给 Codex，一次调用阻塞到它退出拿到回答，可用 resume 续同一线程。不用于几行改动，也不用于 Codex 未安装或未登录时。
---

# 把任务交给 Codex

Codex 是同一台机器上的另一个编码代理。`codex_dispatch` 会跑一次 `codex exec`，**阻塞到它退出**，返回它的最终回答和线程 id。

## 先确认可用

- 工具列表里有 `codex_dispatch` 才能用。没有 → 说明这个部署没装 `dsh-plugin-subagent-bridge`，或者 Codex 二进制没找到。
- 调用返回 `codex executable not found` → Codex CLI 不在 PATH，也没有落在常见目录。告诉用户在插件 `config.codexBin` 里指一个绝对路径，不要反复重试。
- 用户机器上 Codex 未登录 / 额度用尽时，返回会是 `codex exited with …`，把后面那几行原样转述，别自己编原因。

## 基本调用

```jsonc
codex_dispatch({
  "prompt": "自足的审查/实现任务 + 验收标准",
  "cwd": "/Users/.../当前仓库",
  "sandbox": "read-only"        // 只审不改；要它改代码时用 workspace-write（默认）
})
```

返回（工具视图里会附带一行 `[codex thread <id> · <耗时>s]`）：

```jsonc
{ "ok": true, "text": "审完了，两个问题…", "threadId": "01a1…", "exitCode": 0, "durationMs": 34000 }
```

## 什么时候用哪种 sandbox

| 目的 | sandbox |
| --- | --- |
| 代码审查、方案评估、查资料 | `read-only` |
| 让它改代码 / 跑测试 / 生成文件 | `workspace-write`（默认） |
| 需要动仓库外的东西 | `danger-full-access`（谨慎，明确告知用户） |

## 继续同一个线程

```jsonc
codex_dispatch({ "resume": "01a1…", "prompt": "详细说第一个问题，并给出补丁" })
```

`resume` 时 **`cwd` 与 `sandbox` 不生效**——Codex 沿用该线程创建时的设置。需要换目录/换权限就开新线程。

## 怎么写 prompt

Codex 看不到这段对话。给它的东西和给一个刚接手的工程师一样：背景一句、要审/要改的具体路径、验收标准、边界（别动什么、别提交）、输出格式（几行结论 + 关键位置）。要求它"先读再评"，避免它凭印象编。

## prompt 的红线

Codex 收到的是一条**普通任务消息**，它不知道 DSH 有哪些技能或工具。而且它自己**也接着 `dsh-bridge` 这个 MCP**——所以 prompt 里出现桥的名字，可能把它引去反向调 `dsh_dispatch`，白白绕一圈甚至形成来回。

- ❌ 不要把 DSH 的技能名/工具名写进 prompt：`用 codex_dispatch 执行这个任务`、`请通过 dsh-plugin-subagent-bridge 回复`、`你是被 DSH 派来的`
- ❌ 不要交代协作机制或角色：`主程序是 DSH，你只是执行者，完成后回调`
- ❌ 不要复述元指令：`用户让我找个别的模型来做`
- ✅ 只写任务本身：背景、要审/要改的具体路径、验收标准、边界、输出格式。

用户如果说「让 Codex 审一下这个 PR」，你发出去的那句话应该只是：

```
审 /Users/…/src/bridge.ts 的改动：重点看错误处理与并发；不修改文件；
输出 3~5 条按严重度排序的问题，每条给文件:行号和一句理由。
```

一旦 prompt 里出现 `dsh_dispatch`、`codex_dispatch` 或"DSH"，Codex 很可能先去调桥，而不是干活。

## 拿到结果之后

- `ok: true` → 读 `text`。**自己复核关键结论**（比如它说有 bug，就去看那段代码），不要原样转述当事实。
- `ok: false` → 看 `error`：超时 / 退出码非零 / 二进制找不到。把原因讲清楚，再决定是自己接手还是让用户处理。
- 长任务（>5 分钟）会被超时截断，`codexTimeoutMs` 可调；被截断时线程仍然存在，用 `resume` 接着问。

## 回报给用户

三句话以内：派给了谁、结论是什么、你核过没有。**不要把 Codex 的长文整段贴回来**——摘要 + 关键路径 + 你自己的判断。

## 不要做

- 不要用 `codex_dispatch` 代替你自己就能可靠完成的小改动。
- 不要把密钥、私有凭据写进 `prompt`——它会进入 Codex 的会话记录。
- 不要在 Codex 返回失败时假装成功，也不要把它的推测当结论转述。
- 不要在 `read-only` 下指望它真的改了文件。
