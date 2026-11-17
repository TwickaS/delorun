---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-real-browser-grant-events

[English](2026-11-17-real-browser-grant-events.md) | 中文

## 概述

新增会话事件 `real-browser/granted`、`real-browser/away` 和 `real-browser/ended`，分别记录对话允许使用本人自己的浏览器、允许非本人发起的运行使用它，以及该许可的结束。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-real-browser-grant-events
baseline: false
changes:
  - root: "event:real-browser/away"
    previous: null
    after: "a20ee5ade286773dec82ee1b5bfa0ca3bc7f5de8a9a5645b88589de5572347e0"
    decision: same-version
  - root: "event:real-browser/ended"
    previous: null
    after: "8cc928f857619a6ecd26bb2e2ae08d84ba320b74ddae35c287d36afa65de61a5"
    decision: same-version
  - root: "event:real-browser/granted"
    previous: null
    after: "23afe2b636b2258c47a86a1ec92709a9494737b1e99e61fdf62f4b0d37b3ccb1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增三种事件类型，现有事件不变。没有这些类型的构建在读取含有其中任何一种事件的日志时会拒绝读取，就像它拒绝任何未知的事件类型一样，而不会在缺少该许可的情况下重放对话。有这些类型的构建可以原样读取所有旧日志，因为旧日志不含这些事件。这些事件保持会话格式版本不变：其类型名本身就是判别字段。

<a id="verification"></a>
## 验证

`delorun/packages/browser-use-browse/tests/grant.spec.ts` 通过智能体循环和审批服务记录每种事件，并用 `realBrowserGrant` 投影折叠它们，包括一个不继承父会话许可的分叉会话。

<a id="dev-note"></a>
## 开发备注

无。
