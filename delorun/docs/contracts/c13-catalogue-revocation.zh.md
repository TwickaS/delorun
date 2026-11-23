---
description: "约定 C13：Discover 首先列出的已签名插件索引文件、其条目 schema、「tested with Delorun X」徽章记录、条目可以列出并作为其作者或评审者主张的发现、带有序列号、过期时间与 24 小时最长缓存时长的已签名撤销列表、陈旧状态、在下一次加载时停用被撤销的插件，以及这两个文件的托管位置。"
---

# C13 插件索引文件与撤销列表

[English](c13-catalogue-revocation.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

插件索引是一份公开的插件清单，位于仓库 `TwickaS/delorun-plugins` 中，添加插件的方式是提交一个 PR（Pull Request）。它的发布任务使用 [C2](c02-release-manifest.zh.md#key-roles) 的插件索引密钥为两个文件签名，即索引文件与撤销列表，GitHub Pages 在 `catalogue.delorun.com` 上提供它们；该托管方不受信任，因为客户端会拒绝签名无法验证的文件。索引条目固定确切的插件版本及其完整性哈希，带有来自兼容性语料库的「tested with Delorun X」徽章，并且可以列出发现，studio 会把这些发现显示为插件作者或具名评审者的主张：Delorun 不执行插件审计，也不核实这些发现。撤销列表列出 Delorun 会在其下一次加载时停用的插件版本，并带有防止回放的序列号、一个过期时间以及 24 小时的最长缓存时长；超过该时长后，studio 进入陈旧状态。这些类型位于 [`@delorun/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.zh.md)。

<a id="status"></a>

## 状态

本页的内容均未构建：没有任何代码获取、验证或缓存插件索引文件或撤销列表。

- **已构建并已使用：** [C2](c02-release-manifest.zh.md#key-roles) 的根元数据 schema 中的 `catalogue` 密钥角色，以及 [C1](c01-home-layout.zh.md) 的 home 布局中的文件名 `catalogue/revocations.json`。插件通过上游的插件管理器安装，它把每个包的完整性哈希记录在 profile 的 `pnpm-lock.yaml` 中；Delorun 不增加自己的固定。
- **尚未构建：** `@delorun/catalogue` 包；已签名的索引与撤销列表及其发布任务；使用精确版本和完整性固定从插件索引安装；序号、过期和 24 小时缓存时长检查；陈旧状态；在下一次加载时停用被撤销的插件版本；studio 中的徽章和列出的发现；`plugin-pins` 检查，`delorun verify` 将其报告为未运行。`delorun update` 的报告把 `revocations` 列为未检查。

下文中，本列表称为尚未构建的要求与拒绝测试，在某次改动构建它们之前，不保护任何人。已安装的插件无论之后得知它的什么情况，都保持启用，直到本人移除它。

## 目录

- [状态](#status)
- [文件的托管位置](#where-the-files-are-served)
- [插件索引文件](#catalogue-index)
- [徽章记录](#badge-record)
- [列出的发现](#listed-findings)
- [从插件索引安装](#installing-from-the-catalogue)
- [撤销列表](#revocation-list)
- [获取与缓存](#fetching-and-caching)
- [陈旧状态](#stale-state)
- [停用被撤销的插件](#disabling-a-revoked-plugin)
- [插件索引仓库的 CI](#catalogue-repository-ci)
- [取值与限制](#values-and-limits)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="where-the-files-are-served"></a>

## 文件的托管位置

| URL | 文件 |
| --- | --- |
| `https://catalogue.delorun.com/index.json` | 插件索引文件，置于 [C2](c02-release-manifest.zh.md#signature-envelope) 的签名信封中。 |
| `https://catalogue.delorun.com/revocations.json` | 撤销列表，置于同一种信封中。 |

两者都使用客户端受信任根（[C2](c02-release-manifest.zh.md#root-metadata)）中的 `catalogue` 角色进行验证。GitHub Pages、DNS 或某条网络路径可以扣留或延迟这些文件，过期时间与陈旧状态限定了这种影响；它们无法在不被察觉的情况下更改或回放这些文件。这些请求不携带任何本人（the person）的标识符；它们会向托管方暴露 IP 地址与客户端版本。本人可以关闭插件索引获取；此时 Discover 不列出任何插件索引条目，studio 会说明在关闭期间被撤销的版本不会被停用。

<a id="catalogue-index"></a>

## 插件索引文件

`index.json`，schema 为 `delorun.catalogue-index/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `sequence` | 整数 ≥ 1 | 每次签名加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 恰为 `issued` 之后 7 天；发布任务每 24 小时以及每次合并时重新签名。 |
| `entries` | 条目列表 | 每个插件包一条，按 `package` 排序。 |

条目：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `package` | npm 包名 | 插件的包；在索引文件中唯一。 |
| `title`、`description` | 字符串 | 来自插件 `meta` 的句首大写（sentence case）显示文本，分别最多 80 与 300 个字符。 |
| `repository` | HTTPS URL | 插件的源码仓库。 |
| `license` | SPDX 表达式 | 与包的声明一致。 |
| `author` | `{ "name", "github" }` | 插件作者及其 GitHub 登录名。 |
| `addedBy` | 整数 | 添加该条目的 PR 编号。 |
| `versions` | 版本列表 | 最新的在前；至少 1 个。 |

版本：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 确切的语义化版本 | 一个已发布的版本。 |
| `integrity` | `sha512-` 字符串 | npm tarball 的完整性值；安装会固定它。 |
| `engines` | `{ "dsh"?, "delorun"? }` | 包声明的版本范围，复制自它的 manifest（元数据清单；见 [C17](c17-plugin-versions.zh.md)）。 |
| `badges` | 徽章记录列表 | 该版本的语料库结果。 |
| `findings` | 发现列表 | 为该版本列出的发现；可以为空。 |

<a id="badge-record"></a>

## 徽章记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `kind` | `tested-with-delorun` | 唯一的徽章类型。 |
| `delorun`、`dsh` | 确切的语义化版本 | 语料库运行时所用的 Delorun 发布版本及其上游版本。 |
| `channel` | `stable` 或 `beta` | 该 Delorun 发布版本的通道。 |
| `result` | `passed` 或 `failed` | 语料库结果。 |
| `corpus` | 40 位十六进制提交 | 所运行的语料库修订版本。 |
| `run` | HTTPS URL | 产生该结果的 CI 运行。 |
| `recorded` | 时间戳 | 发布任务记录它的时间。 |

studio 仅对 `passed` 显示徽章，并且只显示为「Tested with Delorun <delorun>」，其中写明发布版本。徽章表示该插件版本在该发布版本上通过了兼容性语料库测试；它不是背书，也不是安全审查，任何界面都不会以其他方式表述它。

<a id="listed-findings"></a>

## 列出的发现

一个版本可以列出发现。每条发现都是其作者的主张，Delorun 不予核实。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | 字符串 | 在条目内唯一，最多 64 个 `[a-z0-9-]` 字符。 |
| `severity` | `info`、`low`、`medium`、`high` 或 `critical` | 由该发现的作者评定。 |
| `title` | 字符串 | 最多 120 个字符。 |
| `detail` | 字符串 | 纯文本，最多 4,000 个字符；studio 将其作为文本渲染，绝不作为 HTML 或 Markdown 链接渲染。 |
| `author` | `{ "role", "name", "github" }` | `role` 为 `plugin-author` 或 `reviewer`；评审者以姓名与 GitHub 登录名标明。 |
| `reported` | 日期 | 该发现被列出的时间。 |
| `fixedIn` | 确切的语义化版本，可选 | 其作者称已修复该问题的后续版本。 |

显示规则：

- 每条发现在渲染时都带有其作者的角色与姓名，以及标签「Claim by <name>, not verified by Delorun」。
- 任何界面都不会就某个插件说「audited」、「safe」或「no findings」，也不会称某个插件已经核实。没有列出任何发现的版本渲染为「The catalogue lists no claims about this version. Delorun does not audit plugins.」。未挂载 `pluginAudit` 服务时，安装界面会说明来自审计的发现不可用。
- 一条发现的摘要值是该发现的 RFC 8785 规范 JSON 的 SHA-256。在安装前接受某个版本的发现，会把它们的摘要值记录到插件管理器的接受台账中（模式 0600，只含摘要值）。缺失的台账，或内容不是该记录的台账，都视为未接受，因此这些发现会再次征询；发生变化的发现具有新的摘要值，也会再次征询。

<a id="installing-from-the-catalogue"></a>

## 从插件索引安装

- Discover 通过上游的插件市场首先列出插件索引的条目，然后列出它已经列出的其他来源。
- 安装会固定确切的版本及其 `integrity`；完整性与索引文件不符的 tarball 会被拒绝。
- 安装当前撤销列表所撤销的版本会被拒绝，并给出该列表中的原因。
- 撤销列表处于陈旧状态时，安装会被拒绝（[陈旧状态](#stale-state)）。
- 安装前会检查两条版本轴（[C17](c17-plugin-versions.zh.md)）。
- 验证失败、比已存储的 `sequence` 更旧或已过期的索引文件不会被使用；Discover 会把插件索引显示为不可用并给出原因，且不列出任何插件索引条目。

<a id="revocation-list"></a>

## 撤销列表

`revocations.json`，schema 为 `delorun.catalogue-revocations/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `sequence` | 整数 ≥ 1 | 每次签名加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 恰为 `issued` 之后 48 小时；发布任务每 24 小时以及每次变更时重新签名。 |
| `revocations` | 撤销项列表 | 先按 `package`、再按 `revoked` 排序。 |

撤销项：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `package` | npm 包名 | 插件包；无论该插件以何种方式安装，撤销项都适用。 |
| `versions` | 确切语义化版本的列表 | 被撤销的版本，至少 1 个。 |
| `reason` | `malicious`、`vulnerable`、`broken` 或 `author-request` | 原因代码。 |
| `message` | 字符串 | 与原因一同显示的英文文本，最多 500 个字符。 |
| `advisory` | HTTPS URL，可选 | 关于它的公开安全公告。 |
| `revoked` | 时间戳 | 添加该项的时间。 |

含有任何格式错误撤销项的列表会被整体拒绝；客户端保留它上一次验证通过的列表。

<a id="fetching-and-caching"></a>

## 获取与缓存

- Host 在每次启动时以及运行期间每 6 小时获取撤销列表，并在 Discover 打开时以及每 24 小时获取索引文件。
- 在 `integrity.mode: off`（[C15](c15-verification-checks.zh.md#modes)）下，Host 不获取撤销列表，因此撤销列表按下述规则进入陈旧状态。
- 客户端把最新的已验证列表及其 `sequence` 与获取时间存储在 [C1](c01-home-layout.zh.md) 指定的路径。
- `sequence` 低于已存储值的列表会被拒绝；`sequence` 相等的列表必须具有完全相同的字节。
- 列表的缓存时长是自客户端上一次获取并验证列表以来经过的时间。最长缓存时长为 24 小时。

<a id="stale-state"></a>

## 陈旧状态

当缓存时长超过 24 小时、已存储的列表已超过 `expires`，或尚无任何列表通过验证时，撤销列表处于陈旧状态。处于陈旧状态期间：

- studio 显示「The plugin revocation list has been out of date since <time>; new catalogue installs are paused.」，并附上最近一次失败的原因；
- 新的插件索引安装与插件索引更新会被拒绝；
- 已安装的插件继续加载，上一份已验证列表所撤销的版本保持停用；
- Host 每 15 分钟重试一次，陈旧状态在第一份通过验证的列表出现时结束。

从文件安装插件或直接从 npm 安装插件不经过插件索引，因此不受陈旧状态影响。

`delorun verify` 会报告陈旧状态（[C15](c15-verification-checks.zh.md)）。

<a id="disabling-a-revoked-plugin"></a>

## 停用被撤销的插件

- 当新验证通过的列表撤销某个已安装的版本时，正在运行的插件不会被停止。studio 显示该插件、原因与消息，以及重启提示。
- 在下一次加载时，profile 中该版本的行会在 Loader 导入它之前被停用，这一改动是一个注明该撤销的 profile 历史（profile history）版本（[C3](c03-update-report.zh.md)）。
- 插件的界面提供更新到列表未撤销的版本与保持停用两个选项。重新启用被撤销的版本需要本人在写明原因的界面上确认，接受台账会针对该确切的 `package@version` 与列表的 `sequence` 记录这一确认；之后若有列表以新的原因再次撤销它，则会再次征询。

<a id="catalogue-repository-ci"></a>

## 插件索引仓库的 CI

- 语料库任务针对当前的 stable 与 beta Delorun 发布版本运行插件代码。它不持有任何可以写入索引文件、徽章或仓库的 token，也从不在 `pull_request_target` 下运行 PR 代码。
- 一个独立的发布任务不运行任何插件代码；它以产物形式读取语料库结果，对其进行校验，写入徽章记录，并用插件索引密钥为两个文件签名。
- 更改某个条目的 PR，在该条目未通过本 schema 校验时失败。

<a id="values-and-limits"></a>

## 取值与限制

| 取值 | 数值 |
| --- | --- |
| 撤销列表最长缓存时长 | 24 小时 |
| 撤销列表过期时间 | `issued` 之后 48 小时，每 24 小时重新签名 |
| 运行期间撤销列表的刷新 | 每 6 小时 |
| 陈旧状态下的重试间隔 | 15 分钟 |
| 索引文件过期时间 | `issued` 之后 7 天，每 24 小时重新签名 |
| 解析前的索引文件大小上限 | 16 MiB |
| 解析前的撤销列表大小上限 | 1 MiB |
| 每个版本的发现数 | 最多 50 条 |
| 文本上限 | 标题 80、描述 300、发现标题 120、发现详情 4,000、撤销消息 500 个字符 |
| 请求超时 | 30 秒 |

<a id="consumers"></a>

## 消费方

- `TwickaS/delorun-plugins`：索引文件、其 schema 检查、语料库与发布任务。
- `delorun/packages/catalogue/src/revocation/`：获取、陈旧状态与加载时停用。
- Discover 的配置与 studio 插件：列出条目、徽章、发现与安装。
- `delorun verify`（[C15](c15-verification-checks.zh.md)）与更新报告（[C3](c03-update-report.zh.md)）。

<a id="compatibility"></a>

## 兼容性

每个文件的 `schema` 写明其主版本，且读取方会拒绝未知字段，因此任何新字段都意味着一个新的主版本；只要仍支持只读取旧版本的客户端，新版本就与旧版本并列发布。插件索引角色的密钥只通过一个新的根版本轮换（[C2](c02-release-manifest.zh.md#key-rotation)）。上游的插件市场及其其他来源保持上游发布时的原样；插件索引只是又一个被首先列出的来源。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 两个文件都使用插件索引密钥签名，并从不受信任的托管方提供；无法验证的文件不会被使用。
- R2. 撤销列表带有 `sequence`、签发后 48 小时的过期时间以及 24 小时的最长缓存时长；更低的 `sequence` 会被拒绝。
- R3. 陈旧的列表会拒绝新的插件索引安装，让已安装的插件继续加载且已被撤销的版本保持停用，在 studio 中说明这一点，并进行重试。
- R4. 格式错误的撤销项会导致整个列表被拒绝；安全相关的行失败时关闭（fail closed）。
- R5. 被撤销的版本在下一次加载时被停用，并附带其原因、一个历史版本与重启提示。
- R6. 徽章只显示「Tested with Delorun X」并写明发布版本，且只有不运行任何插件代码的发布任务会写入徽章。
- R7. 任何界面都不声称 Delorun 审计插件；发现在渲染时标明其作者，作为 Delorun 不予核实的主张，且接受台账失败时关闭（fail closed）。
- R8. 语料库任务不持有任何写入 token，且没有任何插件索引工作流使用 `pull_request_target`。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 组件 | 它展示的行为 |
| --- | --- | --- |
| `c13-replayed-list-refused` | `catalogue` | 一份有效签名、但 `sequence` 低于已存储值的撤销列表会被拒绝，已存储的列表保持不变。 |
| `c13-foreign-key-list-refused` | `catalogue` | 由插件索引角色之外的密钥签名的列表会被拒绝。 |
| `c13-malformed-revocation-refuses-list` | `catalogue` | 一份有效签名、但含有一个格式错误撤销项的列表会被整体拒绝。 |
| `c13-stale-after-24-hours` | `catalogue` | 当替身服务器不可达、且上一次获取发生在 24 小时 1 秒之前时，studio 显示陈旧通知，插件索引安装被拒绝，已安装的插件正常加载，上一份列表所撤销的版本保持停用。 |
| `c13-expired-list-is-stale` | `catalogue` | 已超过其 `expires` 的列表即使在 24 小时内获取过，也会进入陈旧状态。 |
| `c13-revoked-disabled-at-next-load` | `catalogue` | 新被撤销的已安装版本会持续运行直到重启，重启提示显示其原因，重启后其所在的行被停用，并产生一个历史版本。 |
| `c13-revoked-install-refused` | Discover 插件 | 安装被撤销的版本会被拒绝，并给出列表中的原因。 |
| `c13-integrity-mismatch-refused` | Discover 插件 | 完整性与索引条目不符的 tarball 会被拒绝。 |
| `c13-plugin-cannot-write-badge` | `delorun-plugins` | 语料库任务中试图写入徽章或推送的 fixture（测试前置数据）插件会因没有 token 而失败，其尝试不会留下任何徽章记录。 |
| `c13-no-pull-request-target` | `delorun-plugins` | 对任何使用 `pull_request_target` 的插件索引工作流，工作流 lint 都会失败。 |
| `c13-no-audited-wording` | Discover 插件 | 安装一个 fixture 插件时，不渲染任何「audited」、「safe」或「no findings」字样，不称该插件已经核实，并说明 Delorun 不审计插件。 |
| `c13-findings-labelled-as-claims` | Discover 插件 | fixture 条目的发现在渲染时带有其作者的角色与姓名，以及「not verified by Delorun」标签。 |
| `c13-missing-ledger-asks-again` | Discover 插件 | 当接受台账缺失或格式错误时，这些发现会在安装前再次征询。 |

<a id="what-this-does-not-prove"></a>

### 这些检查不能证明什么

- **撤销在下次加载时生效。** 新近被撤销的版本会一直运行，直到 Host 再次加载它；撤销列表无法停止已经在运行的插件代码。从撤销到生效之间，最多有 6 小时等待下一次刷新，另加本人重启之前的时间。
- **徽章的写入。** 只有发布作业才能写入徽章，这一点由 `TwickaS/delorun-plugins` 的 CI 配置保证：语料作业不持有写入令牌，由单独的作业发布，工作流 lint 拒绝 `pull_request_target`。客户端只验证插件索引密钥的签名，因此被攻破的发布作业或插件索引密钥可以签署任何徽章；徽章写入的拒绝测试在那个仓库中运行，而不在本仓库中。
- **列出的发现。** Delorun 不核实列出的发现。一条发现陈述的是其作者的主张；没有列出发现，并不说明插件的任何情况。
- **对时钟的依赖。** 最大缓存时长、撤销列表的过期时间与索引的过期时间都以客户端的时钟为准；时钟被调慢时，撤销列表可能在实际过期后仍被使用。
