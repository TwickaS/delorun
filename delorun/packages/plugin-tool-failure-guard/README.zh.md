---
description: "当工具调用接连失败时停止轮次的守卫，供维护者修改它何时停止、模型先读到什么，以及停止如何显示。"
---

# @delorun/plugin-tool-failure-guard

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/plugin-tool-failure-guard` 会停止一个接连遇到失败工具调用的轮次，这样当模型无法使用某个工具时——例如浏览器缺少 Chromium 构建——它不会把本人的 token 花在一个又一个变通办法上。连续 3 次调用失败后，模型会读到一条提醒：停下来，告诉本人什么失败了。连续 6 次调用失败，或最近 12 次调用中有 8 次失败时，轮次会在下一次模型请求之前停止，chat 中显示一条通知，说明原因以及如何继续。本人发送一条消息即可继续；每个轮次，以及本人的每条消息，都会重新开始计数。`@delorun/bundle-local` 和 `@delorun/bundle-headless` 将本插件挂载为开启，并保护它的行不被 `plugin_manager` 工具改动；Config 默认值仍是对等值——关闭，而对等组合让该行保持禁用。这就是 Delorun 的 C16 开关 `tool_failure_guard`。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **计入什么。** agent 发起的每次工具调用都按其最终结果（`tools/result`）计入该 agent，因此被策略监听器拦截的调用会作为模型读到的失败计入，在运行之前就失败的调用也一样，例如参数无法解析的调用。本人在审批时拒绝或取消的调用（`APPROVAL_REJECTED`、`APPROVAL_CANCELLED`）以及被取消的调用（`ABORTED`、`ABORTED_BEFORE_DISPATCH`）不计入，也不会中断一串失败。没有 agent 的调用，以及 `exclude` 所列工具的调用，会被忽略。subagent 各自计数。
- **提醒。** 在一次计数中，一串失败首次达到 `reminderAfter` 时，守卫为下一次请求排入一条消息：一条来源为 `tool-failure-guard` 的 `notice`，会话将其记录为插件消息。其文本点明失败次数以及随后的停止；见 [`reminderText`](src/index.ts)。
- **停止。** 一串失败达到 `consecutiveFailures`，或最近 `windowSize` 次计入的调用中有 `windowFailures` 次失败时，守卫会等待该步其余的工具结果，然后在下一次 `agent/pre-step`、下一次模型请求之前取消该轮次。它的监听器最先运行且不委托，因此后面的监听器（例如压缩）不会为被取消的步工作。该轮次的 `turn/end` 记录 `{ kind: 'aborted', reason: { kind: 'hook', reason: 'delorun/tool-failure-guard' } }`（[`TOOL_FAILURE_GUARD_STOP_REASON`](src/tally.ts)）；不会新增其他事件，关于停止的任何内容都不会到达模型。取消会保留收件箱，因此本人排队的消息会作为下一轮运行。为被取消的步送达的消息，例如任务的完成通知，会回到收件箱最前面，随下一轮发送；守卫自己的提醒则被丢弃。
- **继续。** 每个轮次都以新的计数开始，无论是什么唤醒了它；接纳了本人消息的一步会丢弃该 agent 的计数，因此在轮次运行时发送的消息也会重新开始计数。
- **通知。** studio 部分注册一个匹配所记录 `turn/end` 的 Conversation Definition，并为它显示一行 Chat（[`StopNotice`](src/client/StopNotice.tsx)），提供英文和中文。它只读取日志，因此重新打开 chat 时通知会再次显示，在 stock 外观下也是如此。
- **headless 输出行。** `stderrNotice` 打开时，停止还会把 [`STDERR_NOTICE`](src/index.ts) 写到进程的标准错误，随后 `delorun headless` 像对待任何未完成的轮次一样以 1 退出。
- **开关关闭。** `enabled: false` 是默认值，也是对等值；此时插件校验其限制，但不注册任何东西。

<a id="configuration"></a>

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | C16 开关 `tool_failure_guard`；`@delorun/bundle-local` 和 `@delorun/bundle-headless` 将其设为开启。 |
| `consecutiveFailures` | `6` | 使轮次停止的连续失败调用次数；至少为 2。 |
| `windowSize` | `12` | 窗口保存最近多少次计入的调用；至少为 2。 |
| `windowFailures` | `8` | 窗口内使轮次停止的失败调用次数；至少为 2，至多为 `windowSize`。 |
| `reminderAfter` | `3` | 连续失败多少次后模型读到一条提醒；须小于 `consecutiveFailures`，`0` 表示不提醒。 |
| `exclude` | `[]` | 工具名模式（`*` 匹配任意一串字符），其调用会被忽略。 |
| `stderrNotice` | `false` | 守卫停止轮次时，另向标准错误写一行；`@delorun/bundle-headless` 将其设为开启，因为 `delorun headless` 只打印最终文本。 |

超出范围的限制会让该行在加载时以 `ToolFailureGuardConfigError` 失败，无论开关是开还是关。

<a id="known-limitations"></a>

## 已知限制

- **计数保存在内存中。** Host 重启，或从磁盘重新加载的 chat，都会让所有计数重新开始；停止本身会被记录。
- **不捕捉交替的调用。** 每两次失败之间夹一次成功调用（失败、失败、成功，依此类推）的轮次会被窗口停止，但严格让失败与成功交替的轮次，任意 12 次调用中至多失败 6 次，且从不连续失败两次，因此两条限制都不会达到。守卫拦住的是失败调用的循环，而不是有意绕开它的模型。
- **不捕捉成功的兜圈子。** 调用都成功、却毫无进展的轮次会继续运行；守卫只计算失败，而上游的 `repeat-tool-reminder` 覆盖完全相同的重复调用。

<a id="tests"></a>

## 测试

- [`tests/guard.spec.ts`](tests/guard.spec.ts) 用脚本化的模型驱动真实的 agent 循环：两条停止规则、提醒、并行调用、运行之前就失败的调用、监听器顺序、headless 输出行、每个拒绝与取消代码、策略拦截、被排除的工具、开关、继续、相互独立的 agent、从被停止的步保留下来的消息，以及 Config 检查。
- [`tests/stop-notice.client.spec.tsx`](tests/stop-notice.client.spec.tsx) 覆盖哪些轮次结束会得到通知、该行的文案以及各项注册。
- [`snapshots/session/delorun-tool-failure-guard`](../../../snapshots/session/delorun-tool-failure-guard) 是开关开启的场景：脚本化的模型反复读取一个不存在的文件，直到轮次停止；它对 `pnpm run mock:llm` 无密钥录制，并通过 `dsh --profile headless` 重放。
