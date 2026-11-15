---
description: "Delorun studio 中的回收站（C8）：chat 和工作区菜单中的「移到回收站」操作，设置中恢复或永久删除条目的「回收站」部分，以及每次启动时对过期条目的清理。"
---

# @delorun/plugin-trash

[English](README.md) | 中文

## 摘要

按[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md)的要求，在 studio 中删除 chat 或工作区时，条目会移到回收站，而不是被销毁。该插件在每个 chat 和每个工作区的菜单中添加「移到回收站」操作；在设置中添加「回收站」部分，列出已删除的内容及每项剩余的天数，可恢复条目，也可永久删除单个或全部条目；并在每次启动时删除所有超过 30 天的条目。[`@delorun/bundle-local`](../bundle-local/README.zh.md)在每个 Delorun CLI profile 中挂载它。回收站本身是 [`@delorun/trash`](../trash/README.zh.md)。

## 目录

- [如何接管删除](#how-delete-is-taken-over)
- [harness 一半](#the-harness-half)
- [studio 一半](#the-studio-half)
- [配置](#configuration)
- [测试](#tests)

<a id="how-delete-is-taken-over"></a>

## 如何接管删除

上游没有删除 chat 的方式：其菜单只归档 chat，其持久化层没有删除操作。上游的工作区「删除」只移除注册信息，保留文件夹和所有 chat，这些 chat 随后显示为未分组。因此该插件不修改任何上游文件。它通过上游的上下文菜单注册表，为 `session` 和 `workspace` 目标添加自己的操作，位于上游的「归档」和「删除」项之后，并保持上游的各项不变。

<a id="the-harness-half"></a>

## harness 一半

[`index.ts`](src/index.ts) 提供 [`TRASH_PATHS`](src/wire.ts) 路由，每条都是仅所有者可访问的精确 Connection Fetch 路由，请求体为它所校验的 JSON。[`operations.ts`](src/operations.ts) 一次执行一个操作：

- **将 chat 移到回收站**：通过上游的工作区注册表归档该 chat 并停止其运行中的工作，然后把它的会话目录移入回收站。仍被存活写入方持有的 chat 保持归档状态留在原处，直到下次启动时再移入。
- **将工作区移到回收站**：以同样方式归档其 chat，把它们移入记录了注册信息的同一个条目，然后移除注册信息。
- **恢复**：把 chat 移回，重新注册已删除的工作区及其 chat，并取消归档删除时归档的每个 chat。会覆盖原处某个 chat 的恢复，会被以 `TRASH_RESTORE_CONFLICT` 拒绝。
- **永久删除与清空**：从 harness 挂载的每个存储中清除该条目：通过 session-query 引擎的 `forgetSessions` 清除全文索引，清除实时投影缓存的 `forget` 及其文档，清除没有其他 chat 引用的附件，清除 spill 存储根目录下的 spill 文件，清除会话各代（generation）以及回收站中的副本。`clearLogs` 接受「现在清除 home 的所有运行日志」的提议；「清空回收站」会在最后一次清除时一并清除这些日志，无法清除的每份日志都会被报告。
- **启动时**：先移入删除时仍存活的 chat，再清除所有已满 30 天的条目；若时钟落后于某个条目或上一次清理，或跳变超过一年，则不清除，并记录日志。

插件无法命名的失败以 `TRASH_FAILED` 应答，并连同原因记入日志。

<a id="the-studio-half"></a>

## studio 一半

[`src/client/`](src/client/index.ts) 注册菜单操作，通过 `uiWorkspace.hideSession` 在侧栏中隐藏回收站内的所有 chat，以覆盖整个窗口的 toast 报告每次操作的结果，并添加「回收站」部分（`settings.section`，位于「隐私」之后），其回收站图标显示在导航中（`settings.section.icon`）。studio 一半需要 `slots`、`locale`、`contextMenus`、`uiWorkspace`、`sessions` 和 `workspaces`。

当主面板显示的 chat 被归档时，上游会清空主面板，这会让屏幕上留下「选择一个工作区开始」，键盘仍停留在页面上。[`leave.ts`](src/client/leave.ts) 改为跳转，且只在移动成功之后才跳转；移动失败则保持该 chat 打开。打开的 chat 移走后，它通过 `uiWorkspace.startSession`（上游的「新 chat」，会复用该工作区的空白 chat）在该 chat 所在的工作区中打开一个新 chat；不属于任何工作区的 chat，则在当前或最近的工作区中新建 chat。承载打开 chat 的工作区移走后，它等待工作区列表不再包含该工作区，然后在最近的剩余工作区中打开新 chat，若没有剩余工作区则让主面板保持为空。主面板不再显示已移走的 chat 后，停留在页面主体上的键盘会移到输入卡片（`[data-composer-card]`），且不显示焦点环，这不会唤起手机键盘；在桌面端，上游的输入框已经把键盘放进消息框。「永久删除」和「清空回收站」会先询问，说明片段最多可能在运行日志中保留 14 天，并提议现在清除所有运行日志。该部分会列出每个受损的条目目录及其原因。清除之后，页面用 `@delorun/trash/drafts` 从自己的 `localStorage` 中移除该条目的草稿。

<a id="configuration"></a>

## 配置

| 字段 | Delorun CLI profile 中的值 |
| --- | --- |
| `trashRoot` | `<home>/trash` |
| `sessionsRoot` | `<home>/sessions` |
| `storagesRoot` | `<home>/storages` |
| `attachmentsRoot` | `<home>/attachments/v1` |
| `logsHome` | `<home>` |

<a id="tests"></a>

## 测试

在仓库根目录运行 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-trash`，会在临时 home 上运行 harness 规格，并在 jsdom 中运行 studio 规格。[`leave.client.spec.tsx`](tests/leave.client.spec.tsx) 检查打开的 chat 或其工作区移到回收站后，主面板和键盘的去向。
