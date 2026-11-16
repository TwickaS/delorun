---
description: "Delorun 的回收站（约定 C8）：chat 或工作区的删除、恢复与清除，对约定所列每个存储的清除效果，清理日志的提议，以及 30 天保留期。"
---

# @delorun/trash

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包实现[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md) 的回收站一半：删除 chat 或工作区会把它移入回收站，本人可以在 30 天保留期结束之前恢复它，而清除会把它从保存其内容的每个存储中移除。保留期与残留常量来自 [`@delorun/contract-archive-and-trash`](../contract-archive-and-trash/README.zh.md)，已持久化的浏览器草稿清单来自[约定 C10](../../docs/contracts/c10-host-qualified-keys.zh.md)，清理日志的提议所运行的清理效果来自 [`@delorun/logs`](../logs/README.zh.md)。

## 目录

- [回收站存储](#the-trash-store)
- [删除](#deleting)
- [恢复](#restoring)
- [清除](#purging)
- [清理日志的提议](#the-clear-logs-offer)
- [保留期](#retention)
- [存活的 chat](#live-chats)
- [接线](#wiring)
- [测试](#tests)

<a id="the-trash-store"></a>

## 回收站存储

回收站根目录 `<home>/trash` 下每个条目一个目录：条目记录 `item.json` 以 0600 存放在 0700 的目录中，`chats/` 树保存删除时移入的会话目录。被删除 chat 的内容只保存在这一处，别无其他位置，因此回收站在清除之前保留条目中的密钥，而活跃的存储中不留任何内容。

记录整份写入，先写临时文件再重命名到位，并在每次读取时校验：每个 chat 的原位置及其在回收站中的位置都是两个经过编码的路径段，因此被篡改的记录无法指向已配置的会话根目录之外的目录，或另一个条目的内容。`scan` 返回可读取的条目以及每个受损的条目目录及其原因；没有任何操作会恢复、清除或使受损条目过期，由本人自行检查其目录。

<a id="deleting"></a>

## 删除

`TrashService.deleteChat` 在会话持久化根目录下定位该 chat 的会话目录——先按 chat 的 cwd 推导的项目目录查找，再遍历每个项目目录，因为会话 id 在整个根目录下唯一——然后把它连同其中的每一代一起移入条目。记录会在移动之前写明该 chat 在回收站中的位置，因此两步之间发生崩溃时，要么 chat 仍在原位置（`settle` 会在下次启动时把它移入），要么有一条跟随它的记录。`deleteWorkspace` 把一个工作区的每个 chat 移入同一个条目，并记录工作区浏览器条目所指的工作区 id。删除还会记录执行删除的 home 为它归档的 chat，对于工作区还会记录它移除的注册信息，以便恢复时取消归档这些 chat 并重新注册该工作区。没有落盘内容的 chat 仍会作为一条无内容的记录进入回收站，因此它的清除仍会触及每一个指名它的存储。

<a id="restoring"></a>

## 恢复

`restore` 把每个被移动的 chat 按字节原样移回其原会话目录，并移除该条目。它会先检查每个目标，绝不覆盖删除之后又出现在原位置的会话目录；该拒绝不会移动任何内容。每个 chat 移回之后都会重写记录，因此中途停止的恢复会留下恰好反映回收站仍保存内容的记录，之后的清除绝不会触及已恢复的 chat。仍保存 chat 内容的条目目录绝不会被移除。

<a id="purging"></a>

## 清除

`purge` 把条目从 C8 列出的每个存储中移除：

- 通过索引接缝移除 `session-query-sqlite` 的 SQLite FTS5 全文索引中该条目的行；
- 每个 chat 的会话目录，包括其中的每一代，外加删除与清除之间又在原位置出现的任何一代；
- 每个 chat 在 `<home>/storages/session_projcache/sessions` 下的投影缓存文档，包括缓存在丢弃无效记录时移开的副本，因为该文档保存该 chat 缓存的标题、第一条消息、计划、目标与待办；
- 该条目的 chat 所指名、且会话根目录下没有任何 chat 以及没有其他条目指名的附件：版本化附件根目录下每个附件的图像对象、文件对象和文件的别名目录；报告会统计因另一个 chat 指名而保留下来的附件数量；
- `spill` 存储中该条目的 spill 目录；
- 在执行清除的浏览器中，按 host 限定键约定、该条目在每个 host 作用域下的草稿条目。

报告会列出清除触及的每个存储。存储根目录本身是符号链接、或位于符号链接之下的，会被以 `TRASH_STORE_REFUSED` 拒绝而不会被跟随，因此在 home 中预置的链接无法让清除删除它所指定存储之外的内容。

<a id="the-clear-logs-offer"></a>

## 清理日志的提议

清除会说明：已清除内容的片段可能在运行日志中残留至多 14 天，即约定 C20 的保留期。`purge(id, { clearLogs: true })` 表示接受该提议，并清理 home 的每一份本地日志，而不仅是该条目的记录：轮转文件与启动报告被删除，当前文件被就地清空。只有在没有任何失败时，报告才会写 `cleared`，并列出无法清理的每份日志。保留期触发的清除不是本人的选择，因此它从不清理日志；残留会一直保留，直至运行日志自身的保留期把它删除。

<a id="retention"></a>

## 保留期

条目的 `expiresAt` 是 `deletedAt` 加 30 天。`enforceRetention` 清除每个保留期已结束的条目，`list` 标记每个条目是否已过期，供屏幕展示回收站保留的内容。该过程只在有限范围内信任时钟：当某个条目的删除时间晚于时钟读数，或时钟读数早于 `retention.json` 中记录的上一次清理时，它不清除任何内容并报告 `clock-behind`；当时钟读数超过上一次清理 365 天以上时，它报告一次 `clock-jump`。

<a id="live-chats"></a>

## 存活的 chat

JSONL 会话后端在写入句柄打开期间（即 home 进程保持该 chat 存活的整个时间），持有 chat 会话目录内 `session.lock` 上的内核锁。删除在移动目录之前取得同一把锁，并在之后释放（[`lease.ts`](src/lease.ts)）。当另一个持有者保持该锁时，该 chat 被记录为 `pending` 并留在原位置；一旦锁空闲，`settle` 就会把每个 pending 的 chat 移入，home 在启动时运行它。清除会就地移除 pending 的 chat，恢复则让它留在原处。Windows 把该锁作为具名信号量持有，因此在那里，有会话目录的 chat 总是算作被持有。

<a id="wiring"></a>

## 接线

各个存储是服务构造时的配置：`sessionsRoot`、`storagesRoot`、`spillRoots`、`attachmentsRoot` 与 `logsHome`，外加三个接缝——`sessionIndex`，即全文索引引擎的 `forgetSessions`；`projectionCache`，即实时投影缓存的 `forget`，使尚未完成的延后写入刷新不会把已清除 chat 的值写回；`draftStorage`，即执行清除的连接所在的浏览器存储。一个都不运行的部署不传任何绑定，报告也只说明清除触及到的存储。[`@delorun/plugin-trash`](../plugin-trash/README.zh.md) 接入 harness 的服务，`delorun trash` 接入 home 的文件。`session-text` 辅助函数读取 chat 的各代（在 1 GiB 之内解压）以及它们所指名的附件摘要；`delorun export` 也通过它们读取 chat。浏览器一半是独立的模块 `@delorun/trash/drafts`，它不导入任何需要 Node 的内容，因此 studio 在自己的 `localStorage` 中清除已清除条目的草稿，既包括 host 限定键，也包括没有 host id 的页面所写入的未限定键。

<a id="tests"></a>

## 测试

在仓库根目录运行 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/trash` 执行各规格：删除、恢复、带 canary 矩阵的清除、保留期到期、各接缝，以及针对上游自己的 JSONL 会话后端（包括存活的写入方）对 chat 的删除、恢复和 settle。
