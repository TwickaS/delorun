---
description: "约定 C10：host id、studio 客户端状态与浏览器存储所用的 host 限定键、已持久化浏览器键的清单，以及上游 id 与线上格式保持不变的规则。"
---

# 约定 C10：host 限定键

[English](c10-host-qualified-keys.md) | 中文

<a id="summary"></a>
## 摘要

studio 可以同时连接多个 home，而两个连接也可能共享同一个浏览器 origin。host 限定键使它们的客户端状态与浏览器存储互不混淆。每个连接都有一个 host id，由浏览器生成，且从不发送。host 限定键把该 host id 与一个上游的会话或工作区 id 合在一起，并为 studio 写入的每一个已持久化浏览器条目命名。上游的 id、请求与响应的格式以及会话事件都保持不变，因此任何上游客户端、SDK 或已保存的会话都无需新增字段。本页定义 host id、键的形式、已持久化浏览器键的清单，以及每个已持久化键都带有 host id 的规则。

<a id="status"></a>

## 状态

键的形式已构建；但从不设置 host id，因此 studio 以上游的 stock 名称写入每个条目。

- **已构建，但无人使用：** `packages/client/store` 中的 `setPersistenceHostId` 与 `qualifiedPersistKey`，`ui-conversation`、`ui-schedule` 和 `ui-sidebar-right` 为其条目使用它们。测试之外没有任何东西调用 `setPersistenceHostId`，没有 host id 时，`qualifiedPersistKey` 返回不带限定的 stock 名称。
- **已构建并已使用：** 从 studio 回收站一节执行清除时，会在执行它的浏览器中，移除被清除 chat 的草稿条目，包括不带限定的名称下的条目，以及每个 host 限定名称下的条目。
- **尚未构建：** studio 的连接列表以及为每个连接创建 host id；快捷键、终端、用户提问、工作区视图和侧边栏浏览器条目的 host 限定名称，它们不调用 `qualifiedPersistKey`；每个持久化条目都带 host id 且不读取 stock 条目的规则，因为 studio 目前读写 stock 名称；枚举规格，以及两个连接的浏览器状态的分离。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [host id](#host-id)
  - [host 限定键](#host-qualified-keys)
  - [已持久化的浏览器键](#persisted-browser-keys)
  - [保持不变的格式](#unchanged-formats)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="host-id"></a>
### host id

host id 标识 studio 与某个 home 的 Host 进程之间的一个连接。本人添加连接时，studio 使用上游的 `randomUuid` 创建它，并将其保存在浏览器中 studio 的连接列表里。host id 是规范形式、共 36 个字符的小写 UUID 版本 4。它在同一个浏览器 profile 内唯一，且绝不会被另一个连接重用。

host id 从不被发送。studio 发往 home 的任何请求 URL、请求头、cookie、RPC 请求体、流消息或会话事件中都不出现 host id。host id 不编码 studio 地址、home 密钥或任何其他身份。

<a id="host-qualified-keys"></a>
### host 限定键

host 限定键有两种形式。

- host 作用域：`<hostId>`。
- 上游作用域：`<hostId>.<upstreamId>`，其中 `<upstreamId>` 是 home 所发出的会话或工作区 id，原样使用。

浏览器条目的持久化名称是清单中的持久化名，后面接一个点和作用域。例如，某个连接上某个会话的对话状态存储在 `dsh.conversation.<hostId>.<sessionId>` 之下。host id 长度固定，因此读取者通过取持久化名之后的前 36 个字符来拆分键，其后的上游 id 从不被解析。

通用 store 遵循同样的规则。用 `defineStore` 声明并带有 `persist` 名称的 store，会把调用方传给 `create` 的作用域键追加到持久化名之后。studio 为每个已持久化的 store 都传入 host 限定的作用域键。不带作用域调用 `create` 时，会写入裸的持久化名，清单不允许这种写入。

<a id="persisted-browser-keys"></a>
### 已持久化的浏览器键

每个已持久化的浏览器条目都带有 host id。下表列出 studio 写入的每个条目。其 `作用域` 列说明该条目所用的形式。新增的已持久化条目，须在写入它的同一次变更中加入清单。

| 持久化名 | 存储 | 归属 | 作用域 | 保存内容 |
| --- | --- | --- | --- | --- |
| `dsh.keybindings.v1` | localStorage | `packages/client/shortcuts` | host | web studio 的键盘快捷键覆盖设置。 |
| `dsh.sidebar-right.v1` | localStorage | `packages/client/ui-sidebar-right` | host 与会话 | 每个会话的右侧边栏状态。 |
| `dsh.schedule.recent-time-zones.v1` | localStorage | `packages/client/ui-schedule` | host | 最近使用过的时区。 |
| `dsh.schedule.task-tab.v1` | localStorage | `packages/client/ui-schedule` | host 与会话 | 每个会话的定时任务标签页绑定。 |
| `dsh.conversation` | localStorage | `packages/client/ui-conversation` | host 与会话 | 每个会话的对话视图状态。 |
| `dsh.conversation.contentWidth` | localStorage | `packages/client/ui-conversation` | host | 转录内容宽度偏好。 |
| `dsh.terminal.binding.v1` | localStorage | `packages/api/terminal-controller` | host 与会话 | 每个会话与内容的终端绑定。 |
| `dsh.terminal.close.v1` | localStorage | `packages/api/terminal-controller` | host | 尚未完成的终端关闭请求。 |
| `dsh.terminal.shell` | localStorage | `packages/api/terminal-controller` | host | 首选 shell。 |
| `dsh.user-questions.drafts.v1` | localStorage | `packages/client/ui-user-questions` | host 与会话 | 每个会话的问题编写器草稿。 |
| `dsh.workspace.view.v5` | localStorage | `packages/client/ui-workspace` | host 与该 store 的作用域 | 工作区视图状态。 |
| `dsh.sidebar-browser.v1` | localStorage | `packages/client/ui-sidebar-browser` | host | 侧边栏浏览器状态。 |
| `dsh.experimental-inspector.client-source-id.v0` 与 `dsh.experimental-inspector.client-source:` | localStorage | `packages/experimental/inspector` | host | 实验性检查器的客户端源标识。 |
| 实验性 forge 的审阅队列 | localStorage | `packages/experimental/client-ui-forge` | host 与调用方的键 | 审阅记录，以调用方的会话与标签页标识为键。 |
| 任何以 `persist` 名称声明的 store | localStorage | 声明该 store 的包 | host 与调用方传入的作用域 | store 的整个值，以 JSON 保存。 |

cookie 不在本清单之内。Host 设置 `dsh-auth-*` cookie，其名称由连接约定固定。每个 studio 地址都有各自的 origin，因此一个连接的 cookie 不会随另一个连接的请求发送。

以不带 host id 的名称写入的 stock DeepSeek Harness 条目不会被读取。Delorun 不迁移这些取值。

<a id="unchanged-formats"></a>
### 保持不变的格式

会话 id、工作区 id、请求与响应体、RPC 路由、流消息与会话事件都不带 host id。studio 按 home 发出的原样发送每个上游 id。host id 只出现在客户端状态与浏览器存储中。

<a id="consumers"></a>
## 消费方

- 写入清单中各条目、并由 studio 改用 host 限定作用域的上游客户端包：`packages/client/store`、`packages/client/ui-workspace`、`packages/client/ui-conversation`、`packages/client/ui-sidebar-right`、`packages/client/ui-schedule`、`packages/client/ui-user-questions` 与 `packages/api/terminal-controller`。
- `delorun/packages/trash/` 与 studio 的回收站屏幕：清除操作在执行它的浏览器中，删除被清除 chat 在每个 host 作用域下的草稿条目。
- `delorun/packages/plugin-workspaces/`：工作区导入与 `AGENTS.md` 编辑的客户端状态使用 host 限定作用域。
- 创建连接与 store 的 studio 包。
- `delorun/packages/contract-host-qualified-keys/`：host id 类型、键的形式与清单常量。

<a id="compatibility"></a>
## 兼容性

host id 的格式是固定的。改变它会改变每个包含 host id 的键，因此需要新格式的变更同时也要改变持久化名的版本后缀，并使先前的条目不再被读取。

清单只增不减。新增条目时，须在写入它的同一次变更中加入其行、作用域与归属。枚举已持久化键的规格会拒绝不在清单中的条目。

从清单中移除条目，要求不再有代码写入它。

<a id="security"></a>
## 安全

要求：

- host id 永远不离开浏览器。
- host id 不泄露 studio 地址、home 密钥或任何身份。
- 已持久化的条目不保存任何凭据、令牌或 cookie 的取值。
- studio 只在活动连接的作用域下读取条目，因此一个连接的条目不会通过另一个连接被读取。
- 按回收站约定执行的清除，会在执行清除的浏览器中，删除被清除 chat 在每个 host 作用域下的草稿条目。其他浏览器配置文件中的草稿不会被该清除触及。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `persisted-key inventory refuses an undeclared key` | 清单中未列出的已持久化浏览器键，会使枚举规格失败。 |
| `persisted key without a host id fails the spec` | 以不带 host 作用域的名称写入的条目，会使枚举规格失败。 |
| `two connections with one upstream id keep separate browser state` | 两个连接上的同一会话 id 读写两个不同的条目。 |
| `host id is absent from every request, response and session event` | 某个连接上录制的会话，其任何请求、响应、流消息或会话事件都不含 host id。 |
| `host id does not encode the studio address` | 指向同一地址、host id 不同的两个连接产生不同的条目，且 host id 不含地址的任何部分。 |
| `purge removes host-qualified drafts of a purged chat` | 在某个浏览器中清除后，该浏览器中该 chat 的草稿条目在任何 host 作用域下都不再存在。 |

验收测试：

- `a spec enumerates every persisted browser key and asserts each carries the host id`（规格枚举每个已持久化的浏览器键，并断言每个键都带有 host id）。
- `upstream client specs pass with the host-qualified scopes`（上游客户端规格在 host 限定作用域下通过）。

<a id="decided-values"></a>
## 决定的取值

- host id 是 36 个字符的小写 UUID 版本 4，由 `randomUuid` 创建。
- 键的分隔符为 `.`，host id 始终是持久化名之后的前 36 个字符。
- 每个已持久化的浏览器键都带有 host id；cookie 是唯一例外，因为每个 studio 地址都有各自的 origin。
- 不带 host id 的 stock 条目不迁移。
