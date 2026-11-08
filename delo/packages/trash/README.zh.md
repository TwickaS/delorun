---
description: "Delo 的回收站（约定 C8）：chat 或工作区的删除、恢复与清除，对约定所列每个存储的清除效果，清理日志的提议，以及 30 天保留期。"
---

# @delo/trash

[English](README.md) | 中文

## 摘要

本包实现[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md) 的回收站一半：删除 chat 或工作区会把它移入回收站，本人可以在 30 天保留期结束之前恢复它，而清除会把它从保存其内容的每个存储中移除。保留期与残留常量来自 [`@delo/contract-archive-and-trash`](../contract-archive-and-trash/README.zh.md)，已持久化的浏览器草稿清单来自[约定 C10](../../docs/contracts/c10-host-qualified-keys.zh.md)，清理日志的提议所运行的清理效果来自 [`@delo/logs`](../logs/README.zh.md)。

## 目录

- [回收站存储](#the-trash-store)
- [删除](#deleting)
- [恢复](#restoring)
- [清除](#purging)
- [清理日志的提议](#the-clear-logs-offer)
- [保留期](#retention)
- [接线](#wiring)
- [测试](#tests)

<a id="the-trash-store"></a>

## 回收站存储

回收站根目录 `<home>/trash` 下每个条目一个目录：条目记录 `item.json` 以 0600 存放在 0700 的目录中，`chats/` 树保存删除时移入的会话目录。被删除 chat 的内容只保存在这一处，别无其他位置，因此回收站在清除之前保留条目中的密钥，而活跃的存储中不留任何内容。

<a id="deleting"></a>

## 删除

`TrashService.deleteChat` 在会话持久化根目录下定位该 chat 的会话目录——先按 chat 的 cwd 推导的项目目录查找，再遍历每个项目目录，因为会话 id 在整个根目录下唯一——然后把它连同其中的每一代一起移入条目。`deleteWorkspace` 把一个工作区的每个 chat 移入同一个条目，并记录工作区浏览器条目所指的工作区 id。没有落盘内容的 chat 仍会作为一条无内容的记录进入回收站，因此它的清除仍会触及每一个指名它的存储。

<a id="restoring"></a>

## 恢复

`restore` 把每个被移动的 chat 按字节原样移回其原会话目录，并移除该条目。它绝不覆盖删除之后又出现在原位置的会话目录；该拒绝不会破坏任何内容。

<a id="purging"></a>

## 清除

`purge` 把条目从 C8 列出的每个存储中移除：

- 通过索引接缝移除 `session-query-sqlite` 的 SQLite FTS5 全文索引中该条目的行；
- 每个 chat 的会话目录，包括其中的每一代，外加删除与清除之间又在原位置出现的任何一代；
- 版本化附件根目录下该条目的附件对象；
- `spill` 存储中该条目的 spill 目录；
- 在执行清除的浏览器中，按 host 限定键约定、该条目在每个 host 作用域下的草稿条目。

报告会列出清除触及的每个存储。

<a id="the-clear-logs-offer"></a>

## 清理日志的提议

清除会说明：已清除内容的片段可能在运行日志中残留至多 14 天，即约定 C20 的保留期。`purge(id, { clearLogs: true })` 表示接受该提议，并清理本地的日志：轮转文件与启动报告被删除，当前文件被就地清空。保留期触发的清除不是本人的选择，因此它从不清理日志；残留会一直保留，直至运行日志自身的保留期把它删除。

<a id="retention"></a>

## 保留期

条目的 `expiresAt` 是 `deletedAt` 加 30 天。`enforceRetention` 清除每个保留期已结束的条目，`list` 标记每个条目是否已过期，供屏幕展示回收站保留的内容。

<a id="wiring"></a>

## 接线

各个存储是服务构造时的配置：`sessionsRoot`、`spillRoots`、`attachmentsRoot` 与 `logsHome`，外加两个接缝——`sessionIndex`，接到 session-query-sqlite 引擎的 `forgetSessions`；`draftStorage`，studio 连接的浏览器存储。一个都不运行的部署不传任何绑定，报告也只说明清除触及到的存储。

<a id="tests"></a>

## 测试

在仓库根目录运行 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/trash` 执行各规格：删除、恢复、带 canary 矩阵的清除，以及保留期到期。
