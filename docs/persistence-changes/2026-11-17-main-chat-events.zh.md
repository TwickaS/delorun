---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-main-chat-events

[English](2026-11-17-main-chat-events.md) | 中文

## 概述

新增 Session 事件 `delorun-main-chat/read` 与 `delorun-main-chat/handoff`，并列出 Delorun 插件合并到用户、开发者、收件箱和标题请求载荷中的 `delorun-main-chat` 消息来源；持久化清单现在会扫描 Delorun 的插件包。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-main-chat-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "2b253f9a4fc062582ddbe3937a854574a51b5b191628a34922503e62a45e273a"
    decision: same-version
  - root: "event:delorun-main-chat/handoff"
    previous: null
    after: "f8766d88c0cb3dc9fecdb0caeb5b11266cbb441db82d8e8c82bf2ac2c68e4b65"
    decision: same-version
  - root: "event:delorun-main-chat/read"
    previous: null
    after: "514f7df060ae7775889b32b5c7003d63d978144a7e0c8483b0540239599713f6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "70349a1c0566c4fd43925d3790e6afa57724b2c738b0b549b87acc105aef22c2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "6130ff19041b0e8f56b81722f261ac05d2868107d497219d4b80fa248255ff71"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "68925d43dbdf9cde9fefd39e85d167cfda69d5a46103c6b516443c76c266c3cb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这两个事件取代了早期预览版以 `plugin:delorun-main-chat/read` 和 `plugin:delorun-main-chat/handoff` 写入的同义插件记录。不含这两个事件的构建会拒绝读取包含它们的日志，与拒绝任何未知的必需事件类型一致。含有它们的构建读取旧日志时不受影响：旧的插件记录是类型未知的可忽略事件，会被跳过，其中记录的交接或读取不会被恢复。`delorun-main-chat` 消息来源早期预览版已经在写入，只是清单现在才列出它，因此没有已存储的载荷发生变化。Session 格式版本保持不变：事件类型名即其判别标记。

<a id="verification"></a>
## 验证

pnpm exec vitest run delorun/packages/plugin-main-chat/tests/main-chat.spec.ts：交接以事件记录，重启后可再次读取，旧的插件记录被忽略且不报错。

<a id="dev-note"></a>
## 开发备注

无。
