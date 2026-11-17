---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-run-allowed-event

[English](2026-11-17-run-allowed-event.md) | 中文

## 概述

新增会话事件 `external-agent/run-allowed`：当用户对实时代理的提问选择“本次运行允许”，且启动闸门保留了该程序的规则时，记录此事件，并指向该提问的 `approval/asked` 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-run-allowed-event
baseline: false
changes:
  - root: "event:external-agent/run-allowed"
    previous: null
    after: "0c201d883a00e1f807504b13aaffc6aeee8b9d0b654e5a16f49b2975fa0b31fe"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增一种事件类型，现有事件不变。不认识它的版本在读取含有该事件的日志时会拒绝，与拒绝任何未知事件类型一样，而不会在缺少该记录的情况下回放对话。认识它的版本照常读取所有旧日志，因为旧日志中没有该事件。该事件仅用于日志审计，没有任何读取方由它推导状态，因此认识它的版本不依赖它的出现。会话格式版本不变：事件类型名即其判别标志。

<a id="verification"></a>
## 验证

delorun/packages/plugin-agent-seats/tests/relay.spec.ts 在真实的会话存储和审批服务上，经由中继追加该事件：同意服务保留规则后，事件指向该提问的 approval/asked 事件；选择“仅此一次”，或闸门退回为“仅此一次”时，不记录任何事件。

<a id="dev-note"></a>
## 开发备注

无。
