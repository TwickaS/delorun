---
description: "约定 C8：归档格式 v1 及其 manifest（元数据清单）、封闭的定制 schema 及其被拒绝的行、签名校验、上限、暂存与发布、错误分类、未受信任的导入 chat，以及回收站与清除。"
---

# 约定 C8：归档格式 v1 与回收站

[English](c08-archive-and-trash.md) | 中文

<a id="summary"></a>
## 摘要

归档是一个或多个工作区及其 chat、附件与定制内容的导出文件。其格式带有版本。导入先在暂存目录中校验整个归档，然后才写入任何内容，并以原子方式发布每个新工作区，且从不覆盖已有的工作区。定制内容是封闭 schema 下的数据，不能包含代码，也不能设置沙箱模式、凭据引用、远程访问选项或出口限制。回收站将被删除的 chat 或工作区保留 30 天，清除则会把其内容从所有保存它的存储中移除。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [约定](#contract)
  - [归档文件](#archive-file)
  - [manifest（元数据清单）](#manifest)
  - [定制 schema](#customisation-schema)
  - [签名](#signature)
  - [上限](#limits)
  - [导入与导出](#import-and-export)
  - [错误](#errors)
  - [未受信任的导入 chat](#untrusted-imported-chats)
  - [回收站与清除](#trash-and-purge)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="archive-file"></a>
### 归档文件

归档是一个 ZIP 文件。其根目录包含以下条目。

- `manifest.json`：下文所述的 manifest。
- `customisation.json`：定制文档，始终存在，即使它不列出任何行。
- `signature.json`：对 `manifest.json` 的签名。仅当导出 home 对归档签了名时才存在。
- `objects/<sha256>`：每个不同内容对应一个条目，以其字节的 SHA-256 命名。附件、chat 代次与工作区实体记录都通过摘要引用对象。

除此之外不得有其他顶层条目。归档不包含工作区的项目文件，因为工作区的代码位于本人自己的仓库中。它包含工作区实体、其 chat、其附件与其定制内容。

<a id="manifest"></a>
### manifest（元数据清单）

`manifest.json` 是一个 JSON 对象，包含下列字段。

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `formatVersion` | 整数 `1`。 | 读取者以 `ARCHIVE_UNSUPPORTED_VERSION` 拒绝任何其他值。 |
| `createdBy` | 字符串。 | 写入归档的 Delo 版本。它仅供参考，不改变归档的读取方式。 |
| `exportedAt` | UTC 的 RFC 3339 时间。 | 导出完成的时间。 |
| `origin` | 含 `homeKeyId` 与 `publicKey` 的对象，二者均为 base64url。 | 导出 home 的密钥。无论归档是否签名都存在。 |
| `workspaces` | 数组。 | 每个工作区一个对象：归档所用的 `id`、名称，以及其 chat、附件与对象。 |
| `entries` | 数组。 | 每个对象与文档一个对象：`path`、`sha256`、以字节计的 `size`，以及 `kind`。`kind` 为 `chat-generation`、`attachment`、`workspace-entity` 与 `customisation` 之一。 |

每个 `path` 都经过规范化、为相对路径，且不含 `..` 段，并指向归档中的一个条目。manifest 中每个条目只列出一次。

<a id="customisation-schema"></a>
### 定制 schema

`customisation.json` 是一个 JSON 对象，其 `schemaVersion` 为 `1`，并带有数组 `rows`。每一行都有一个取自下表的 `kind`。任何其他 kind，以及该 kind 的 schema 未定义的字段，都会被拒绝。

| 行 kind | 保存的内容 | 规则 |
| --- | --- | --- |
| `bundle` | bundle 包名。 | 在差异屏幕上列出。setup 不会安装它。 |
| `profile-row` | 行 id 与该行的普通配置值。 | 取值是数据。表达式与 `insert` 行被拒绝。 |
| `preset` | 预设定义。 | 不能把权限提升到本人自有预设之上。 |
| `skill` | skill 的文件。 | 导入时为禁用状态。 |
| `theme` | 主题取值。 | 仅为数据。 |
| `plugin-declaration` | 插件名称及其固定版本。 | 在差异屏幕上列出。从不自动安装。 |

被拒绝的行 kind 为 `sandbox-mode`、`credential-reference`、`reach-row` 与 `egress`。设置沙箱模式、凭据引用、远程访问选项或出口限制的行会被拒绝。任何 `!!js` 表达式与任何 `insert` 行都会在求值之前被拒绝，因此归档不会引起任何求值。

定制内容只有在本人看过其差异之后才会应用。差异屏幕在写入任何变更之前，显示每一行、其 kind 与其目标。

<a id="signature"></a>
### 签名

`signature.json` 是一个 JSON 对象，其 `algorithm` 为 `ed25519`，包含签名密钥的 `homeKeyId`，以及 base64url 编码的 `signature`。签名覆盖 `manifest.json` 的精确字节。签名密钥是导出 home 的密钥。没有 `signature.json`、签名校验失败，或导入 home 不认可其密钥的归档，都以未校验状态导入。导入 home 认可的密钥，是它已作为受信任的 home 密钥持有的密钥，或本人在导入时通过指纹确认的密钥。

校验在写入任何内容之前完成。未校验状态会显示在差异屏幕上，也会出现在 `delorun import` 输出的报告中。

<a id="limits"></a>
### 上限

导入会拒绝超出下列上限的归档，并返回 `ARCHIVE_TOO_MANY_ENTRIES`、`ARCHIVE_ENTRY_TOO_LARGE`、`ARCHIVE_TOTAL_TOO_LARGE` 或 `ARCHIVE_RATIO_EXCEEDED`。

| 上限 | 取值 |
| --- | --- |
| 一个归档中的条目数 | 100,000 |
| 整个归档解压后的大小 | 4 GiB |
| 一个条目解压后的大小 | 1 GiB |
| 一个条目解压后与压缩后大小的比率 | 100:1 |

检查基于中央目录与条目头所声明的大小进行，并再次基于实际读取的字节进行，因此实际读取的字节多于声明大小的归档会被拒绝。

<a id="import-and-export"></a>
### 导入与导出

导出把每个对象流式写入归档，并把其 SHA-256 与大小记入 manifest。导出时若在 chat 历史中发现密钥，会向本人发出警告，由本人决定是否继续。

导入把归档读入 home 目录下的暂存目录，该目录与工作区存储位于同一文件系统。它依次校验 manifest、校验和、路径、条目、上限、定制内容与签名。只有经过完整校验的归档才会被发布。每个新工作区通过一次原子重命名，从暂存目录移入工作区存储。导入从不覆盖已有的工作区或 chat。标识符已存在时，导入会分配一个新的标识符。

导入 stock DeepSeek Harness home 时，会把其插件、设置与会话复制到新的 Delo home 中，且从不修改 stock home。

<a id="errors"></a>
### 错误

每次拒绝都带有下表中的一个代码。拒绝不写入任何内容。

| 代码 | 原因 |
| --- | --- |
| `ARCHIVE_UNSUPPORTED_VERSION` | `formatVersion` 或定制内容的 `schemaVersion` 不是读取者所认识的版本。 |
| `ARCHIVE_TRUNCATED` | ZIP 结构或某个条目提前结束，或声明的大小与实际字节不符。 |
| `ARCHIVE_CHECKSUM_MISMATCH` | 某个条目的字节与 manifest 中的 SHA-256 不符。 |
| `ARCHIVE_PATH_REJECTED` | 路径为绝对路径、含有 `..`、含有反斜杠，或使用了保留的设备名。 |
| `ARCHIVE_LINK_REJECTED` | 某个条目是符号链接或硬链接。 |
| `ARCHIVE_CASE_COLLISION` | 两个路径仅在字母大小写上不同。 |
| `ARCHIVE_TOO_MANY_ENTRIES` | 归档超出条目数上限。 |
| `ARCHIVE_ENTRY_TOO_LARGE` | 某个条目超出单条目大小上限。 |
| `ARCHIVE_TOTAL_TOO_LARGE` | 归档超出总大小上限。 |
| `ARCHIVE_RATIO_EXCEEDED` | 某个条目超出压缩比率上限。 |
| `ARCHIVE_SCHEMA_INVALID` | 定制文档与封闭 schema 不符。 |
| `ARCHIVE_EXPRESSION_REFUSED` | 某一行含有 `!!js` 表达式，或是 `insert` 行。 |
| `ARCHIVE_DENIED_ROW` | 某一行属于被拒绝的 kind。 |
| `ARCHIVE_SIGNATURE_INVALID` | `signature.json` 存在，但其签名校验失败。 |
| `ARCHIVE_STAGING_FAILED` | 暂存目录无法写入，或原子重命名失败。 |

签名缺失不是错误，它就是未校验状态。

<a id="untrusted-imported-chats"></a>
### 未受信任的导入 chat

每个导入的 chat 在本人将其标记为受信任之前都是未受信任的。未受信任的 chat 会显示一个横幅，写明其来源，即归档的 origin 或文件名。在本人将其标记为受信任之前，它的历史保持在模型上下文之外。删除未受信任的 chat 会把它移入回收站，清除它则会立即将其移除。

<a id="trash-and-purge"></a>
### 回收站与清除

删除 chat 或工作区会把它移入回收站。回收站为每个条目保留 30 天。本人可以在保留期结束之前从回收站恢复条目。保留期结束时，该条目被清除。回收站在清除之前保留条目中的密钥。

清除会把条目从保存其内容的每个存储中移除。

- `session-query-sqlite` 的 SQLite FTS5 全文索引中该条目的行。
- 条目中每个 chat 的会话目录，包括其中的每一代，即每个 `session*.jsonl.zstd` 文件。
- 条目中每个 chat 的投影缓存存储文档，其中保存该 chat 的缓存标题、第一条消息、计划、目标与待办，以及缓存在丢弃无效记录时移开的副本。
- 条目的附件。
- `spill` 存储中该条目的 spill 文件。
- 在执行清除的浏览器中，按 host 限定键约定，该条目在每个 host 作用域下的草稿条目。

已清除内容的片段可能残留在运行日志中，直至这些日志被删除。依据运行日志约定，每条运行日志记录最多保留 14 天。清除会说明这一残留，并提议立即清理受影响的日志文件（包括当前文件与轮转文件）。本人接受时，清除会删除这些文件。

<a id="consumers"></a>
## 消费方

- `delorun/packages/archive/`：导出、导入与校验，其中 stock home 的导入位于 `src/dsh-import/`。
- `delorun/packages/trash/`：回收站、恢复与清除，以及回收站保留期。
- studio 的回收站屏幕及其在 host 限定键约定下的草稿条目。
- `delorun import`，它输出验证报告。
- `delorun/packages/contract-archive-and-trash/`：manifest、行 kind、错误代码、上限与保留期常量。

<a id="compatibility"></a>
## 兼容性

归档格式由 `formatVersion` 标记版本，其值为 `1`。读取者拒绝任何其他版本，任何读取者都不会回退到旧格式，也不会降级归档。未来的格式是一个新版本，并拥有自己的读取者。旧版本的归档由该版本的读取者读取。

归档内的会话数据遵循上游的会话读取器与迁移。当前的会话格式版本记录在[会话格式状态页](../../../docs/session-format-status.zh.md)中，本约定不重复其取值。

定制内容的 `schemaVersion` 仅在某个行 kind 发生不兼容变更时才改变。新增行 kind 即为新版本。移除被拒绝的 kind 属于破坏性变更，需要升级指南。

回收站保留期是本人可以依赖的行为。改变它需要修改本约定，并附上升级指南。

<a id="security"></a>
## 安全

要求：

- 在整个归档于暂存目录中通过校验之前，不写入任何内容。
- 归档从不求值 `!!js` 表达式，也从不写入含有该表达式的行。
- 被拒绝 kind 的行会被拒绝，因此归档无法改变沙箱模式、凭据引用、远程访问选项或出口限制。
- 签名不校验、或根本没有签名的归档，只能以未校验状态导入，差异屏幕与报告都会显示该状态。
- 导入的插件声明只列出，从不自动安装。
- 导入的预设不能把权限提升到本人自有预设之上。
- 导入的 skill 以禁用状态开始，导入的 chat 以未受信任状态开始。
- 导入从不覆盖工作区或 chat。
- 回收站在清除之前保留条目中的密钥，清除会把内容从本约定列出的每个存储中移除。预置在存储根目录、或承载版本化根目录的目录上的符号链接会被拒绝而不会被跟随，因此清除不会删除它所指定存储之外的任何内容。
- 导出在写入归档之前，会就 chat 历史中的密钥发出警告。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `archive with a !!js expression causes no evaluation or write` | 含有 `!!js` 的定制行在求值之前被拒绝，且不写入任何文件。 |
| `archive with an insert row is refused` | `insert` 形式的定制行以 `ARCHIVE_EXPRESSION_REFUSED` 被拒绝。 |
| `archive that sets a sandbox mode, credential reference, reach row or egress is refused` | 每个此类行都以 `ARCHIVE_DENIED_ROW` 被拒绝，且没有任何行被应用。 |
| `traversal, link, size, ratio, case, truncation, version and canary fixtures cause no write` | 每个夹具都以其错误代码被拒绝，且工作区存储保持不变。 |
| `unverified archive imports only with the unverified label` | 没有签名或签名校验失败的归档，在差异屏幕与报告中都显示未校验标记。 |
| `imported plugin declarations are listed and never installed` | 导入之后，归档声明的任何插件都不会被安装。 |
| `imported presets do not raise permissions` | 导入的预设不能授予高于本人自有预设的权限。 |
| `imported skills start disabled` | 每个导入的 skill 在导入之后都处于禁用状态。 |
| `imported chat stays out of model context until trusted` | 未受信任的 chat 显示其横幅，且在本人将其标记为受信任之前，其历史不出现在任何模型请求中。 |
| `import into an existing identifier never overwrites` | 标识符已存在的导入会写入一个新工作区，并使已有的工作区保持不变。 |
| `canary is absent from the index and every generation after purge` | 清除之后，canary 文本不出现在全文索引中，也不出现在该 chat 的任何会话代次中。 |
| `purge refuses a symbolic link at a store` | 预置在附件存储上的符号链接被以 `TRASH_STORE_REFUSED` 拒绝，其指向的文件保持不变。 |
| `purge leaves no cached title or first message on disk` | 清除之后，该 chat 的投影缓存文档不存在，因此该 chat 的缓存标题、第一条消息、计划、目标与待办都不再留在磁盘上。 |
| `purge with clear-logs chosen leaves no canary residue anywhere` | 接受清理提议并清除之后，canary 文本不出现在任何存储与任何日志文件中。 |
| `purge without clear-logs leaves residue only in retained process logs` | 未接受清理提议并清除之后，canary 文本只残留在保留期内的运行日志中。 |
| `export warns about secrets found in chat history` | 对含有植入密钥的 chat 导出，会在写入归档之前显示警告。 |

<a id="decided-values"></a>
## 决定的取值

- 归档上限为：100,000 个条目，解压后总计 4 GiB，单个条目 1 GiB，单个条目的压缩比率为 100:1。
- 回收站为每个条目保留 30 天。
- 已清除的内容在运行日志中至多保留 14 天，即运行日志约定的保留期。
- 导入的 chat 在本人将其标记为受信任之前都是未受信任的。其横幅写明来源。删除它会把它移入回收站，清除它则会立即将其移除。
- 归档签名算法为 Ed25519，签名密钥为导出 home 的密钥。
