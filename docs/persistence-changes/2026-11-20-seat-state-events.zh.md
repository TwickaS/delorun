---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-seat-state-events

[English](2026-11-20-seat-state-events.md) | 中文

## 概述

新增 Session 事件 `external-agent/state`、`external-agent/status` 和 `external-agent/notice`，分别记录实时智能体对话的程序会话与游标、它的状态，以及它的记录中显示的通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-seat-state-events
baseline: false
changes:
  - root: "event:external-agent/notice"
    previous: null
    after: "5dc496302380a2a4970aef02fd26cb5944472910a93e2ffa9a7f647882ffd55e"
    decision: same-version
  - root: "event:external-agent/state"
    previous: null
    after: "27679a813401a6e057a09142a38a62c8ee965d9b09a39e64a47db54a16aebcf2"
    decision: same-version
  - root: "event:external-agent/status"
    previous: null
    after: "33320a947d938827bb679963ee4089ea844acebb68517165b8917eae8c418b77"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增三种事件类型；没有任何现有事件改变。它们取代早期预览版的三条可忽略的插件记录（`plugin:delorun/agent-seat/state`、`/status` 和 `/notice`）。新事件是必需的，不可忽略：不认识它们的构建会拒绝该日志，就像拒绝任何未知的必需事件类型一样，而不是把实时智能体对话当作丢失了程序会话的普通对话来恢复。认识它们的构建可以读取每一份较早的日志：旧的插件记录是未知类型的可忽略事件，因此会被跳过，它们所记录的状态不会被恢复：席位显示一个没有早先状态的空闲视图（已结束或已达到限额的对话不再这样说明），并且它的下一个轮次会启动一个全新的程序会话，该会话会收到对话中此前的每一条消息，因为输入游标随旧的状态记录一起丢失了。实时智能体位于默认关闭的预览开关之后，因此这样的日志不太可能存在。`agentSeat` 投影的折叠版本升高，因此由旧记录构建的已存储检查点会被丢弃并重新折叠。Session 格式版本保持不变：事件类型名称就是它们的判别标记。

<a id="verification"></a>
## 验证

pnpm exec vitest run delorun/packages/plugin-agent-seats/tests/state：从序列化日志重启的席位子对话会重建相同的视图和已记录的状态，这三个事件不带可忽略标记，包含旧插件记录的日志读取时不报错且不显示它们的任何状态；JSONL 读取路径会返回包含它们的日志，拒绝包含它不认识的必需事件类型的日志，并接纳旧的可忽略插件记录（delorun/packages/plugin-agent-seats/tests/state/read-path.spec.ts）。

<a id="dev-note"></a>
## 开发备注

无。
