---
description: "契约 C3：Delorun 更新应用之前显示的更新报告，其条目（插件、组合包、行、原因、已验证或未验证）与原因代码，CLI home 与桌面 Host 的版本与更新状态，健康检查标准，回滚触发条件，以及撤销与恢复的检查与批准提示。"
---

# C3 更新报告

[English](c03-update-report.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

更新应用之前，Delorun 会显示目标发布将在本人（the person）的 profile 中改变或破坏什么：它将停用、移除或更改的每个插件、组合包与 profile 行，以及本人修改过的 harness 的每个文件（并说明该修改是否沿用），连同原因，以及该预测是基于 Delorun 能够读取的元数据（已验证）还是不能读取的元数据（未验证）。本人确认之前，任何内容都不会应用。CLI（命令行界面）home 与桌面 Host 是彼此独立更新的两套安装，报告同时显示两者的版本与更新状态。切换之后，健康检查会在 120 秒内判定更新是否成立；检查失败会自动回滚，本人之后也可以随时回滚。profile 历史（profile history）的撤销与恢复会运行与安装相同的插件检查，并在应用之前列出它们会改变的内容。类型位于 [`@delorun/contract-update-report`](../../packages/contract-update-report/README.zh.md)。

<a id="status"></a>

## 状态

CLI home 的更新与回滚已构建，并由 `delorun update` 与 `delorun recover` 使用；studio 与桌面应用的更新与回滚尚未构建，撤销与恢复在运行时不带其检查与批准提示。

- **已构建并已使用：** `delorun update` 针对通道上最新的发布生成报告，在本人确认之前不应用任何内容（`--yes` 只确认没有 `disabled`、`removed` 或未验证条目且 `log` 为 `passed` 的报告），写入快照，在 CLI profile 的更新闸门拒绝新轮次期间等待运行中的 chat，取得会话数据副本（session-data copy），在 120 秒内运行 H1 至 H5，并在其中任一项失败时自动回滚。`delorun recover` 通过同一张表回滚，恢复 profile 历史版本，进入与退出安全模式，并丢弃已搁置（set aside）的数据。[更新检查](#update-check)（update check）在从运行时仓库运行的 CLI home 的 Host 中运行，写入其记录，并把提示提供给终端、studio 的侧边栏与 `delorun doctor`。
- **已构建并已使用：** 报告的 `harness` 条目，运行中 runtime 所运行的、非其签名文件的每个文件对应一条（[C21](c21-changes.zh.md#harness-edits)），与目标的已验证文件合并，由 `delorun update` 打印，`--yes` 按其规则处理；并在切换之前应用这些条目（[更新期间的 harness 文件](#harness-files-across-an-update)）。
- **尚未构建：** studio 的更新界面、「Update now」与回滚；桌面更新程序对本报告与本流程的使用；状态记录，报告会读取它们，但没有任何安装写入它们，因此另一套安装始终显示 `unknown`；撤销与恢复的批准提示与安装时插件检查（R5），因此 `delorun recover restore` 会立即应用一个版本，并在之后列出改变的内容；撤销列表（没有任何发布发布撤销列表，因此每份报告都把 `revocations` 列为未检查）；H1 的发布日志条件，因为 H1 只检查运行时文件；还原中途失败的恢复，这样的恢复会让 profile 处于部分恢复状态；带有 Update、Keep disabled 与 Roll back 的启动报告，因为上游的启动会停用不兼容的行，并向标准错误打印一行；桌面的致命错误恢复写入历史版本并提供更新之前的 profile；profile 规范化之前的历史版本。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

## 目录

- [状态](#status)
- [安装与更新状态](#installations-and-update-states)
- [更新检查](#update-check)
- [何时生成报告](#when-a-report-is-made)
- [报告字段](#report-fields)
- [条目](#items)
- [原因](#reasons)
- [已验证与未验证](#verified-and-unverified)
- [数据格式](#data-formats)
- [应用更新](#applying-an-update)
- [更新期间的 harness 文件](#harness-files-across-an-update)
- [健康检查](#health-check)
- [回滚触发条件](#rollback-triggers)
- [回滚](#rollback)
- [撤销与恢复](#undo-and-restore)
- [值与限制](#values-and-limits)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="installations-and-update-states"></a>

## 安装与更新状态

| 安装 | Id | 更新途径 |
| --- | --- | --- |
| CLI home：运行时仓库（runtime store）与 home 进程（home process） | `cli-home` | `delorun update`，经由更新通道（[C19](c19-home-process.zh.md)） |
| 桌面应用及其 Host | `desktop-host` | Delorun 更新源上的桌面更新程序（[C2](c02-release-manifest.zh.md#desktop-updates-and-rollback)） |

每套安装都有自己的 profile，以及自己的 Delorun 与 DSH 版本；更新其中一套从不切换另一套。报告会在 [C1](c01-home-layout.zh.md) 指定的路径读取每套安装的状态记录（安装 id、Delorun 版本、DSH 版本、通道、更新状态、目标版本、时间）。没有任何安装写入其记录，因此两者都显示为 `unknown`；记录缺失或无法读取时，该安装显示为 `unknown`。

| 状态 | 含义 |
| --- | --- |
| `current` | 通道上没有更新的发布，或尚未检查。 |
| `available` | 一个新鲜的时间戳提供了一个更新的发布。 |
| `downloading` | 正在下载目标的文件。 |
| `verifying` | 正在检查目标的签名、摘要与日志条目。 |
| `reporting` | 正在生成报告。 |
| `awaiting-confirmation` | 报告已显示，正在等待本人。 |
| `waiting-for-chats` | 已确认；正在等待运行中的 chat 结束，或等待本人停止它们。 |
| `applying` | 快照已写入，切换正在进行。 |
| `health-check` | 目标正在运行，健康检查正在进行。 |
| `rolling-back` | 回滚正在恢复快照与上一个发布。 |
| `rolled-back` | 回滚之后，上一个发布重新运行。 |
| `failed` | 验证、切换或回滚失败；原因会与 `delorun recover` 及安全模式一同显示。 |
| `unknown` | 仅用于另一个安装：其状态记录不存在或无法读取。 |

桌面应用将上游的 `DesktopUpdateState.phase` 映射到这些状态：`idle` 映射为 `current`，`checking` 映射为 `current`，`available` 映射为 `available`，`downloading` 映射为 `downloading`，`verifying` 映射为 `verifying`，`ready` 映射为 `awaiting-confirmation`，`installing` 映射为 `applying`，`error` 映射为 `failed`。

<a id="update-check"></a>

## 更新检查

在任何报告之前，运行中的安装通过更新检查得知存在更新的发布（[设计](../design/update-notice.zh.md)）。检查会获取通道的 `timestamp.json`、任何更新的根文件、通道的 manifest（元数据清单）及其发布日志 bundle，并像更新那样，依据同一组启动器根与该安装记录的通道验证它们（[C2](c02-release-manifest.zh.md#client-verification) 的第 1 至 3 步与 [C18](c18-release-log.zh.md) 的 bundle 检查），但不运行在线日志检查；它不下载任何归档，不在 `trust/` 下写入任何内容，也不发送任何标识符。它在 CLI home 的 Host 中运行，Host 按墙上时钟每小时查看一次，因此睡眠过的机器会在第一次唤醒时补上检查：当上次检查距今至少达到 `delorun-update-check` 行的 `intervalHours` 时它就检查；检查失败后，分别在一小时、两小时、四小时之后依此类推地重试，等待时间从不超过该间隔。每次检查有一个 `timeoutSeconds` 截止时间。`delorun update --check` 按需运行它。该行的 `enabled` 是 C16 开关 `update_check`（[C16](c16-parity-composition.zh.md)）。

每次检查都以 0600 模式写入 `run/<profile>/update-check.json`，schema 为 `delorun.update-check/1`：`checked`，检查的时间；`newest`，最近一次成功检查所验证的最新发布，附带其 `delorun` 与 `dsh` 版本、其 `channel`、`security`（manifest 不带该标记时为 false），以及 manifest 携带 `summary` 时的 `summary`；`verified`，`newest` 被验证的时间；`timestamp`，指明 `newest` 的时间戳的版本；以及 `failure`，上次检查失败的原因，取值为代码 `running-release-unreadable`、`trust-state-invalid`、`unreachable`、`download-refused`、`deadline`、`unverified`、`log-bundle-invalid`、`regressed` 与 `internal` 之一。记录只保存代码，从不保存失败本身的文本，因为该文本可能带有通道主机选定的文字；home 日志保存该文本，并转义其中的控制字符。失败的检查保留 `newest`、`verified` 与 `timestamp`。当通道时间戳的版本低于记录中的版本，或其在同一通道上的发布低于 `newest` 时，检查为 `regressed`。权限比 0600 模式宽松或无法通过验证的记录按不存在读取。

当 `newest.delorun` 比正在运行的 Delorun 版本更新时，存在一条提示。它写明正在运行的发布、更新的发布、按语义化版本划分的跨度（`patch`、`minor` 或 `major`），以及该更新的发布会在任一版本轴上停用 profile 中多少个已安装插件；这一数目由[条目](#items)中的插件评估在没有撤销列表的情况下决定，依据读取提示时已安装的 profile。提示指明 `delorun update`，不应用任何内容。终端把它显示为一行；studio 的侧边栏通过 Connection 路由 `GET /api/delorunUpdateCheck.notice` 显示它，该路由向所有者回答 `{ "notice": <notice> | null }`，并拒绝远程访问设备；`delorun doctor` 把它显示为其 `update` 行。开关关闭时，该行不注册任何路由，下一次启动会移除该记录。

Host 还以 `{ "host": <字符串或 null> }` 回答 `GET /api/delorunUpdateCheck.channel`，无论检查是否开启。`host` 是启动器记录在主目录 `trust/channel.json` 中的渠道来源的主机（有端口时包含端口）；该渠道提供时间戳、根文件、清单和日志记录，因此检查不会联系其他主机。生产渠道为 `null`，联系 releases.delorun.com 和 GitHub。工作室用它在发布检查的同意文案中写明所联系的主机。

<a id="when-a-report-is-made"></a>

## 何时生成报告

报告针对一套安装与一个目标发布生成，时机是在目标的文件下载、验证（[C2](c02-release-manifest.zh.md#client-verification)、[C18](c18-release-log.zh.md)）并暂存之后，且在 profile 或活动运行时中的任何内容改变之前。验证失败的目标不会得到报告；更新随即停止。报告读取 profile 与暂存的目标，不导入任何插件代码。

<a id="report-fields"></a>

## 报告字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema` | `delorun.update-report/2` | 报告格式。 |
| `installation` | `cli-home` 或 `desktop-host` | 正在更新的安装。 |
| `from`、`to` | `{ "delorun", "dsh", "channel" }` | 正在运行的版本与目标版本（[C17](c17-plugin-versions.zh.md#the-two-versions)）。 |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | 目标的 manifest 摘要与各项检查的结果。`signature` 与 `freshness` 为 `passed` 或 `failed`：运行时仓库在生成报告时验证签名，安装则在文件落地之前验证了新鲜度。`log` 是安装记录在 `trust/release-log.json`（[C18](c18-release-log.zh.md)）中的状态：`verified` 对应 `passed`；在线检查未完成或没有记录任何状态时为 `unchecked`；可验证的失败为 `failed`。报告只为 `passed` 与 `unchecked` 生成，且未能访问日志时报告会写明这一点。 |
| `generated` | 时间戳 | 报告的生成时间。 |
| `installations` | `{ "id", "delorun", "dsh", "state", "target"? }` 的列表 | 两套安装的版本与更新状态。 |
| `items` | 条目列表 | 发生改变的全部内容，先按种类、再按主体排序。 |
| `notChecked` | `revocations` 的列表 | 报告未读取的来源；报告会如实写明，而不是把它们算作已检查。`revocations` 表示目标没有发布撤销列表，报告写明：`Not checked: revocations. This release publishes no revocation list; the health check after the switch holds what one would show.` |
| `counts` | `{ "disabled", "removed", "changed", "unverified", "data", "harness" }` | 具有每种效果的条目数、未验证条目数、`data` 条目数，以及 `harness` 条目数。 |

报告保存在快照的历史版本中，因此历史会显示该更新被预测将改变什么。没有任何发布会读回已保存的报告，因此 `log` 的 `unchecked` 取值属于格式 2，无需新版本：较早发布写入的报告从不携带该取值。

<a id="items"></a>

## 条目

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `kind` | `plugin`、`bundle`、`row`、`data` 或 `harness` | 条目所涉及的内容。 |
| `subject` | 对象 | 对于 `plugin`：`{ "name", "version" }`；对于 `bundle`：`{ "package" }`；对于 `row`：`{ "id"?, "name", "layer" }`，其中 `layer` 指明持有该行的组合包、profile patch、home patch 或 overlay；对于 `data`：`{ "directories": ["sessions", "storages"] }`；对于 `harness`：`{ "file" }`，即文件相对于 runtime 根目录的路径。 |
| `reason` | 原因代码 | 改变的原因（[原因](#reasons)）。 |
| `effect` | `disabled`、`removed`、`changed` 或 `kept` | 它在目标上会发生什么；`kept` 只出现在本人应当看到的已豁免或未验证主体上。 |
| `verification` | `verified` 或 `unverified` | 预测是否基于 Delorun 读取的元数据（[已验证与未验证](#verified-and-unverified)）。 |
| `detail` | 对象 | 该原因的事实，例如要求范围、版本轴、撤销消息、替代组合包，或 harness 文件的 `merge`、`result` 与 `diff`。 |
| `actions` | 列表 | 提供的选项：`update-plugin`、`keep-disabled`、`allow-version`、`skip-update`、`copy-session-data`、`continue-without-copy`。 |

<a id="reasons"></a>

## 原因

报告用运行中发布的规则判定目标的插件，因为报告由运行中的发布构建：声明 `engines.delorun` 的插件只按该范围判定（[C17](c17-plugin-versions.zh.md)）。回滚的报告同样如此，它由执行回滚的那个发布来判定被回滚到的发布。

| 原因 | 种类 | 效果 | 消息 |
| --- | --- | --- | --- |
| `dsh-requirement-unmet` | plugin | disabled | `<plugin> requires DSH <range>; Delorun <to.delorun> runs DSH <to.dsh>.` |
| `delorun-requirement-unmet` | plugin | disabled | `<plugin> requires Delorun <range>; the update installs Delorun <to.delorun>.` |
| `requirement-unreadable` | plugin | disabled | `<plugin> declares engines.<axis> in a form Delorun cannot read.` |
| `requirement-exempted` | plugin | kept | `<plugin> requires <DSH or Delorun> <range>; your exemption for this exact version covers <version>.` |
| `exemption-not-carried` | plugin | disabled | `<plugin> runs today under your exemption for <from version>; the exemption does not cover <to version>.` |
| `requirement-undeclared` | plugin | kept | `<plugin> declares no DSH requirement, so its compatibility with DSH <to.dsh> is not stated.` 只有当插件既未声明 `engines.delorun`、`engines.dsh`，也没有 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer 时才给出：`engines.delorun` 自行声明兼容性，并在 Delorun 上单独决定（[C17](c17-plugin-versions.zh.md)）。 |
| `plugin-revoked` | plugin | disabled | `<plugin> is revoked: <reason>, <message>.`（[C13](c13-catalogue-revocation.zh.md#revocation-list)） |
| `manifest-unreadable` | plugin | kept | `Delorun could not read <plugin>'s package.json; it cannot predict what the update does to it.` |
| `bundle-retired` | bundle | removed | `<bundle> is retired in DSH <to.dsh> and leaves the bundle list.`（上游的 `RETIRED_BUNDLES`） |
| `bundle-template-normalised` | bundle | changed | `The bundle list matches an installation-owned list that DSH <to.dsh> replaces with its template.` |
| `bundle-skipped` | bundle | disabled | `<bundle> cannot load on the target: <reason>.`（上游的 `skippedBundles`） |
| `row-disabled` | row | disabled | `Row <id or name> in <layer> loads <plugin>, which the update disables.`；带 `detail.bundlePatch` 时：`Delorun <to.delorun> switches off row <id> through its bundle <bundle>; the row stays in your profile but does not run.` |
| `row-include-blocked` | row | disabled | `Include <file> reaches <plugin>, which the update disables, so the whole Include is disabled.` |
| `data-format-changed` | data | changed | `Delorun <to.delorun> keeps chat data in a format Delorun <from.delorun> may not read.` |
| `data-format-unknown` | data | changed | `Delorun cannot tell whether Delorun <from.delorun> reads the chat data Delorun <to.delorun> writes.` |
| `harness-change-carried` | harness | kept | `Your change to <file> carries over to Delorun <to.delorun>.` |
| `harness-change-merged` | harness | changed | `Your change to <file> and Delorun <to.delorun>'s change to it merge into a file neither has; read the merge before you confirm.` |
| `harness-change-conflicts` | harness | disabled | `Your change to <file> conflicts with Delorun <to.delorun>'s file; the new release's file runs, and yours is kept beside it as <file>.mine.`；对于 `release-changed-removed`：`You removed <file>, and Delorun <to.delorun> changed it; the new release's file runs.` |

`bundle-skipped` 条目与组合包层的行来自目标将加载的组合包列表：模板，或去掉已退役组合包之后的 profile 列表。每个组合包先从目标的安装锚点解析，再从 profile 解析，与上游的 profile 加载的解析方式相同。目标会跳过这样的组合包：无法解析、未声明 `dsh.bundle`、所列 `dsh.bundle.platforms` 不含本机平台、其 DSH 要求（`engines.dsh`，否则为其 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` peer）目标不满足且没有精确版本豁免涵盖，或其 `engines.delorun` 目标不满足。已加载组合包在 `dsh.bundle.patch` 中声明的 patch 文件会像 profile patch 那样逐行遍历，每一行的 `layer` 都是该组合包。带 `id` 且字面为 `disabled: true` 的 patch 条目，或带 `id` 的已停用插入行，会关闭该行；报告会列出目标的组合包 patch 停用而运行中版本的 patch 没有停用的每一行（`row-disabled`，带 `detail.bundlePatch`，`disabled`，`verified`），因此 H3 接受它。运行中版本的 patch 用同一读取器从其自身 runtime 读取。`!!js` 表达式视为未停用。

`harness` 条目为 `verified`，来自对三方内容的三向合并：运行中版本的签名文件、运行中 runtime 所运行的内容（已批准的内容；对于启动失败而被排除的变更，则仍被排除，改为运行实际在运行的内容），以及目标的签名文件，在目标的文件列表验证之后读取；其 `detail.merge` 指明结果。当目标保持该文件不变（`release-unchanged`），或目标的文件已等于已批准的内容（`in-release`）时，变更原样沿用（`harness-change-carried`，无操作）。当两个版本的文件都有差异，且从运行中版本的文件到已批准内容的 patch 能在无模糊匹配、无换行符转换的情况下应用于目标的文件，或只有执行位不同时，目标运行双方都没有的合并结果（`merged`，`harness-change-merged`，操作 `skip-update`）：该条目带有 `detail.diff`，即从目标的文件到合并后文件的统一 diff，执行位不同时带有 `old mode` 与 `new mode` 行，其大小限制与 [C21](c21-changes.zh.md) 的 diff 相同（二进制或大于 1 MiB 的一侧不含行，报告的合并 diff 总量超过 256 KiB 后任何 diff 都不含行，各自以 `notShown` 说明原因），`delorun update` 会把它打印在该条目之下。对于目标运行的、沿用或合并变更所涉及的每个文件，`detail.result` 保存其所运行内容的 SHA-256 与执行位。其余情形都是冲突（`harness-change-conflicts`，操作 `skip-update`）：编辑重叠（`edits-overlap`）、双方都修改了非 UTF-8 文本的文件（`binary`）或大于 1 MiB 的文件（`too-large`）、目标删除了本人修改过的文件（`release-removed`）、本人删除了目标修改过的文件（`release-changed-removed`），或双方以不同内容新增同一文件（`both-added`）。冲突文件绝不会悄悄保留任何一方。回滚的报告没有 `harness` 条目，因为回滚到的 runtime 运行它自己的已批准文件。

任一版本轴不匹配时，报告会写明两个目标版本，其 `actions` 提供将插件更新到满足目标的版本，并针对未满足的那条轴，提供在目标版本上的精确版本豁免（[C17](c17-plugin-versions.zh.md#exemptions)）。

每个插件的两条轴由上游自己的评估决定，即插件安装程序与启动预检调用的函数（`evaluatePluginCompatibility` 与 `evaluateDelorunRequirement`），以目标的 DSH 与 Delorun 版本代替正在运行的版本，且不带豁免；报告随后按轴应用豁免文件。在 DSH 轴上，声明了 `engines.dsh` 时由它单独决定；否则每个 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` peer 范围都必须接受目标的 DSH，`workspace:` peer 接受任何版本。未满足的 peer 在 `<range>` 中写作 `<peer range> (peer <package>)`，因此报告会停用下一次启动将停用的每个插件。上游拒绝读取的声明，包括不是字符串的 peer 范围，为 `requirement-unreadable`。更新检查用同一评估统计它将停用的插件，`delorun plugin check` 则为单个插件显示该评估（[C17](c17-plugin-versions.zh.md#checking-a-plugin-before-it-is-installed)）。

<a id="verified-and-unverified"></a>

## 已验证与未验证

当条目陈述的每项事实都读自 Delorun 检查过的来源时，该条目为 `verified`：已安装插件的 `package.json`、暂存目标的包，以及已验证的 manifest。当某项事实缺失或无法读取时，条目为 `unverified`，例如无法解析的 manifest、模块无法解析的行、未声明要求的插件，或其 `package.json`、`dsh.bundle`、要求或 patch 文件不是上游可读取形式的组合包，后者是一个 `bundle-skipped` 条目。未验证条目从不被算作安全：报告在每个此类条目旁显示 "Delorun cannot predict this item"，摘要也会统计它们。健康检查将它们与报告列出的条目同等对待。

<a id="data-formats"></a>

## 数据格式

每个运行时发行包（runtime closure）都在其根目录携带 `data-formats.json`，并列在其已签名的文件列表中（[C2](c02-release-manifest.zh.md)）：`{ "schema": "delorun.data-formats/1", "persistence": <SHA-256 of upstream's docs/persistence-schema.json at the built commit>, "delorunRecords": { <record name>: <version> } }`。`delorunRecords` 列出 Delorun 自己的包在 home 下保存的每份带版本的记录。

报告比较正在运行的发布与目标发布。当两份 manifest 的 `dsh` 版本不同、`persistence` 摘要不同，或 `delorunRecords` 不同时，chat 数据即有差异；上游的 schema 清单涵盖 Session 头、信封与事件，但不涵盖 `storages/` 下的任何存储单元，因此 `dsh` 版本不同本身就算作一处差异。任何差异都是一个原因为 `data-format-changed` 的 `verified` `data` 条目，Delorun 将每处差异都视为单向的。任一方的 `data-formats.json` 缺失或无法读取时为 `data-format-unknown`，即 `unverified`，并按同样方式对待。不存在降级拒绝：该比较从不阻止回滚。

`data` 条目提供 `copy-session-data`（默认）与 `continue-without-copy`。其 detail 保存副本的文件数与大小，以及 home 所在文件系统的可用空间，报告在旁边写明：`Without the copy, Delorun cannot go back to <from.delorun> after <to.delorun> first starts.` 没有任何差异时不提供副本，`delorun update --data-copy` 仍会取得一份。

`delorun repair` 把 home 的 `data-format.json`（[C1](c01-home-layout.zh.md)）与它所安装的发布作比较，而此处的比较读取的是两个发布：记录更新或无法排序时，修复以 `DATA_NEWER` 被拒绝；记录无法与该发布比较（发布格式无法读取，或版本不是 semver）的 home，以 `DATA_UNREADABLE` 被拒绝；只有没有记录的 home 才会继续。`--restore-copy` 只在副本的格式等于或早于该发布时（否则为 `DATA_COPY_NEWER`），把写入这些数据的发布所对应的副本放回，这会通过下文的恢复把今天的 `sessions/` 和 `storages/` 搁置，然后把副本的事实写为 home 的记录。

会话数据副本以真正的副本（`COPYFILE_FICLONE`，不可用时回退为完整复制）保存 home 的 `sessions/` 与 `storages/`，从不使用硬链接。`attachments/` 留在原处，因为没有任何操作从中删除内容；`cache/` 不纳入副本，会重建；Delorun 在 `secrets/` 下的记录从不被复制或恢复：上一个发布能读取当前发布写入的每份记录。副本在运行中的 chat 结束、Host 停止之后，在持有 home 锁期间，写入 `data-copies/<to.delorun>/`，旁边是 `copy.json`（两个发布的 `data-formats.json`、文件数与字节总数）；写入时使用临时名称，并在运行时切换之前重命名并同步。放不下的副本会以 `DATA_COPY_NO_SPACE` 拒绝更新，除非本人选择不带副本继续。只保留一份副本：后一次更新提交时，其副本替换较早的那份；在切换之前结束的更新，其副本会被移除。

<a id="applying-an-update"></a>

## 应用更新

1. 本人确认报告；`delorun update` 会打印报告并询问，`delorun update --yes` 会确认一份没有 `disabled` 或 `removed` 条目、没有 `harness-change-merged` 条目、没有未验证条目且 `log` 为 `passed` 的报告。有 `data` 条目时，本人还要就副本作出选择：`--yes` 会取得副本，拒绝则需要 `--no-data-copy` 或提示中的第二个选项。
2. 写入快照：一个名为「Before update to Delorun <to.delorun>」的 profile 历史版本，包含 profile patch、home patch、组合包列表、两个豁免文件、该 profile 的 `pnpm-workspace.yaml` 以及报告。更新记录 `run/<profile>/update.json`（[C1](c01-home-layout.zh.md)）写明两个版本、数据是否有差异、是否取得副本，以及快照的历史版本（`snapshot`）。
3. 运行中的 chat 结束，或由本人停止；CLI 的切换经由 home 进程的更新握手进行，该握手从不在 chat 运行时切换（[C19](c19-home-process.zh.md)），桌面应用则在其重启前步骤中完成这一步。在 Host 已停止且持有 home 锁时，如果本人选择了会话数据副本，则写入该副本。
4. 更新记录的 `targetStarted` 被写入并同步，随后目标启动，健康检查开始运行。

<a id="harness-files-across-an-update"></a>

## 更新期间的 harness 文件

当运行中 runtime 的 harness 变更在其可写副本中等待评审时，更新会以 [C19](c19-home-process.zh.md) 的 `HARNESS_CHANGES_PENDING` 拒绝：一次在 `update.prepare`、拉取任何内容之前，一次在切换之前。本人须先应用或丢弃这些变更，这样更新就不会留下未经查看的变更。当副本无法扫描时（因为超出扫描限制、某个条目无法读取，或文件在读取期间发生变化），更新在同样两个时点以 `HARNESS_COPY_UNREADABLE` 拒绝，并写明失败原因和清除它的命令：`delorun changes edit-harness --discard`，或修复副本后运行 `delorun changes list`。

在切换之前，即会话数据副本写入之后、在 harness 的锁内（runtime 切换在该锁内运行），home 进程针对目标的已验证文件重新规划合并，并与本人所确认报告中的 `harness` 条目比较；该报告是它在 `update.prepare` 时保留的，它不从客户端读取报告的任何内容。某个文件只出现在其中一方、`merge` 不同或 `result` 不同，都会以 `HARNESS_REPORT_STALE` 拒绝更新，该错误写明文件并提示本人重新运行 `delorun update`；不会为目标写入任何内容，更新以 `aborted` 结束，Host 重新运行。否则，它写入目标 runtime 的 harness 文件（[C21](c21-changes.zh.md#harness-edits)）。先前安装在 `changes/harness/<to>/` 下留下的内容会先被移除，绝不合并。每个沿用的文件成为目标的一个已批准文件，其 `signed` 为目标的文件，并记录为目标 runtime 的一次已应用 `harness-edit`，`decidedFrom: "update"`；目标已持有的文件不需要任何操作。有冲突的文件运行目标的文件：当运行中的 runtime 有可写副本，或任一文件冲突时，目标获得一个可写副本，本人修改过的每个冲突文件以 `<file>.mine` 保留其中，它从不算作变更；本人删除的文件没有需要保留的内容。切换前如有任何失败，为目标写入的内容会被移除，更新以 `aborted` 结束，Host 重新运行。运行中 runtime 的记录、副本和日志条目从不被写入，因此回滚到它时会再次运行其已批准文件。目标的组合树由它的首次启动构建，其签名入口通过交接描述符（[C21](c21-changes.zh.md#harness-edits)）交给它，因此健康检查覆盖它所运行的文件。

<a id="health-check"></a>

## 健康检查

目标启动后 120 秒内以下各项全部成立时，更新成立：

- H1. 目标的运行时文件依据其 manifest 验证通过；不读取发布日志状态（[C2](c02-release-manifest.zh.md#client-verification)、[C18](c18-release-log.zh.md#check-states)）。
- H2. Host 达到就绪：对于 `cli-home`，home 进程的 Host 已就绪，且其回环监听器对 `GET /delorun/health` 返回状态 204（该路由只回答本机发往该监听器且 `Host` 为回环名称的请求，其他请求一律得到 421；绑定到所有地址的监听器经 `127.0.0.1` 询问），该路由仅在 Host 以所有者浏览器的身份在进程内读取 studio 索引并得到状态 200 时才如此回答；该路由不读取 cookie、不返回任何内容，因此 studio 的登录要求保持有效：没有会话 cookie 的每个页面与 API 请求都会得到 401；对于 `desktop-host`，Host 通过 host 协议报告就绪，且主窗口加载 studio。
- H3. 目标停用、跳过或移除的每个插件、组合包与行，以及 CLI profile 所保护插件的每个设置发生变化的行，都是报告列出过的。sandbox 行的保护单独比较，任何报告都不能为更弱的保护开脱：目标的该行必须保护同一个 home，拒绝上一个 Host 的该行所拒绝的每个套接字、隐藏其隐藏的每个逃逸目录，且不得让受限命令读取上一行未允许读取的 home 条目，因此发布可以收紧保护，但不能放宽。启动在本机上发现的套接字（Docker context 的套接字及其真实路径、Docker Desktop 的套接字）除非 profile 的某一层列出它们，否则不计入上一个 Host 的保护，因为下一次启动可能发现不同的套接字；回滚的目标不受它所替换的发布的保护约束；受保护的 home、其读取豁免、home 自身的套接字与逃逸目录由发布与 home 决定。
- H4. 报告未列出的每一行加载时都没有插件加载错误，但上一个发布也记录过其加载错误的行除外。
- H5. profile 的组合包列表等于报告预测的列表。

<a id="rollback-triggers"></a>

## 回滚触发条件

以下情况会运行自动回滚：

- T1. 任一健康标准未满足；
- T2. 目标启动 120 秒后健康检查仍未完成；
- T3. 目标的 Host 进程在健康检查期间退出。

应本人请求，本人之后可以随时用 `delorun recover rollback` 回滚。studio 没有更新界面，桌面应用也没有 Delorun 回滚。

回滚会恢复快照中的文件，并将安装切换回被替换的发布：对于 `cli-home`，是运行时仓库保留的运行时（[C1](c01-home-layout.zh.md)）；对于 `desktop-host`，是缓存的上一个发布（[C2](c02-release-manifest.zh.md#desktop-updates-and-rollback)），该项尚未构建。自动回滚之后，`delorun update` 会写明未满足的标准。失败的回滚会使状态保持为 `failed`，并提供安全模式与 `delorun recover`。

<a id="rollback"></a>

## 回滚

`cli-home` 的每种回退方式都读取更新记录并应用同一张表：握手的 `rollback`、自动回滚、中断的更新之后的重启，以及在没有 home 进程运行时执行的 `delorun recover rollback`。它们都不会自行交换运行时指针。不是仅限 profile 的回滚，在另一个进程（包括另一个 profile 的 home 进程）使用 chat 数据期间会拒绝；在没有 home 进程运行时执行的 `delorun recover rollback` 会在检查之前把自己登记为 chat 数据的独占使用者，因此它运行期间不会有 home 进程启动（[C19](c19-home-process.zh.md)）。只有当记录表明已取得副本且副本不早于该更新时，副本才算存在。在任何内容改变之前，要回滚到的版本必须已安装并通过其启动检查；随后记录被标记为 `rolling-back`，数据、profile 与运行时依次跟进。发现 `rolling-back` 记录的启动或 `delorun recover` 会完成该回滚，且只有在回滚到的版本健康启动之后，记录才会移除。在该表拒绝的自动回滚之后，没有任何启动会在未经询问的情况下运行新发布：本人用 `delorun recover rollback --profile-only` 或安全模式作出选择。

| 数据有差异 | 目标已启动 | 副本 | 回滚的行为 |
| --- | --- | --- | --- |
| 否 | 均可 | — | 恢复 profile 快照并切换到上一个运行时。此后写入的 chat 保留。 |
| 是 | 否 | 均可 | 同上；目标从未打开过数据。 |
| 是 | 是 | 存在 | 写明自更新以来新建或改变了多少个 chat，以及它们被搁置而非删除。把现有的 `sessions/` 与 `storages/` 移到 `data-set-aside/<to.delorun>-<time>/`，把副本移到原位，恢复快照并切换运行时。 |
| 是 | 是 | 不存在 | 以 `ROLLBACK_NEEDS_DATA_COPY` 及原因拒绝，并提供 `delorun recover rollback --profile-only`，它恢复快照并保留目标运行时。 |

回滚不删除任何内容：已搁置的数据会一直保留，直到本人移除它，`delorun recover status` 会列出它及其大小。`delorun recover discard` 会获取 home 锁，并在恢复或回滚运行期间、以及对于更新记录仍引用的副本拒绝执行。`delorun headless` 把自己登记为 chat 数据的使用者，在更新、回滚或恢复进行期间拒绝运行，并在其运行期间使更新、副本、恢复或回滚拒绝执行。恢复在第一次重命名之前写入日志 `data-copies/restore.json`，每一步都是一次目录重命名；`delorun start` 与 `delorun recover` 会在任何 Host 启动之前完成进行中的恢复。

本流程适用于 `cli-home`，它是唯一应用本流程的安装。桌面 Host 共享 `sessions/` 且不获取 home 锁，因此在有一把锁同时覆盖两套安装、且其更新程序使用本流程之前，它不会发布。

<a id="undo-and-restore"></a>

## 撤销与恢复

撤销（恢复到最近一次之前的版本）与恢复（任一历史版本）会带回 profile 文件，并随之带回插件版本、构建批准与豁免。`delorun recover restore <version>` 规划恢复，立即写入计划列出的文件，并在应用之后打印改变的内容；它不运行下面的任何检查，不显示提示，也不传入撤销列表。中途失败的恢复会让 profile 处于部分恢复状态，并将其报告为失败的恢复。要求是，在写入任何内容之前，两者都会：

- 对其带回的每个插件版本运行安装时运行的检查：两条版本轴（[C17](c17-plugin-versions.zh.md)）、撤销列表（[C13](c13-catalogue-revocation.zh.md)）、完整性固定值、pnpm 的构建批准，以及在挂载了 `pluginAudit` 服务时运行该服务，其发现显示为 [C13](c13-catalogue-revocation.zh.md#listed-findings) 中的状态；Delorun 本身不运行任何插件审计；
- 显示一个批准提示，列出发生改变的插件（新增、移除或换成另一个版本）、发生改变的构建（恢复的版本允许、拒绝或保持待定的 pnpm `allowBuilds` 条目）以及发生改变的豁免（向 `compatibility.json` 与 `delorun-compatibility.json` 新增或从中移除的授权）；
- 只在本人批准之后应用，并将结果写为一个新的历史版本。

当前撤销列表所撤销的插件版本会以停用状态恢复，并附上原因。撤销列表过期期间，如果一次撤销或恢复会安装 profile 中没有的插件版本，它会等待一份新鲜的列表，与新的插件索引安装相同（[C13](c13-catalogue-revocation.zh.md#stale-state)）。安装步骤失败的恢复会还原它写入的每个文件。撤销列表并不存在，本段所述内容均未构建。

<a id="values-and-limits"></a>

## 值与限制

| 值 | 数值 |
| --- | --- |
| 健康检查时限 | 目标启动后 120 秒 |
| 每份报告读取的状态记录 | 2，每套安装一份 |
| 保留的会话数据副本 | 1 |
| 更新检查间隔 | 默认 24 小时，范围 1 至 480 |
| 更新检查截止时间 | 默认 15 秒，范围 1 至 120 |

<a id="consumers"></a>

## 使用方

- `delorun/packages/update/`：生成报告。
- 上游的 `compatibility-preflight.ts`、`profile.ts`、`profile-sanitize.ts` 与插件管理器的恢复功能：不静默停用，在规范化与清理之前写入历史版本，事务性恢复。
- `delorun/packages/profile-safety/`：撤销、恢复、安全模式与 `delorun recover`。
- studio 的更新界面与桌面更新程序。

<a id="compatibility"></a>

## 兼容性

报告的 `schema` 指明其主版本；原因代码在该版本中构成封闭列表，新增原因即为新的主版本，因此读取方永远不会遇到它不认识的代码。格式 1 和 2 已退役：没有任何 Delorun 版本写过它们，因此不存在它们的读取器。0.1.0-rc.1 至 rc.3 写过格式 3，所以其原因列表是封闭的；此后的改动只增加了格式 3 的读取方会忽略的可选 `detail` 字段（`bundlePatch`），需要新原因的版本写格式 4，并附带格式 3 的读取器。对上游自身启动行为的必要改动是：启动时不兼容的插件以 Update、Keep disabled 与 Roll back 报告，而不是在标准错误上打印一行后被停用；桌面的致命错误恢复「Disable third-party plugins」写入一个历史版本，并提供「Restore profile from before the update」；profile 规范化先写入一个历史版本；这三项均未构建，规范化会在不写历史版本的情况下改写组合包列表。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 任何更新都不会停用、移除或更改报告未列出的插件、组合包或行；健康检查强制执行这一点，否则回滚。
- R2. 本人确认报告之前不应用任何内容，且只有通过签名与新鲜度检查、且日志检查未失败的目标才会有报告；未完成的日志检查显示为 `unchecked`，`--yes` 不会确认它。
- R3. 未验证条目以未验证的身份显示，从不被算作安全。
- R4. 健康检查失败会自动回滚；本人之后可以随时回滚；回滚改变 profile 与运行时仓库，仅在恢复本人取得的副本时才改变 chat 数据，较新的数据会被搁置。
- R5. 撤销与恢复对其带回的内容运行安装时的插件检查，并在应用之前列出发生改变的插件、构建与豁免。
- R6. 显示两套安装的版本与更新状态，更新其中一套从不切换另一套。
- R7. 数据有差异的更新，在本人看到 `data` 条目并就副本作出选择之前不会应用。
- R8. 任何回滚都不删除 chat 数据。
- R9. 更新检查不发送任何关于本人或 profile 的信息，只显示其已签名元数据验证通过的发布，不应用任何内容，从不延迟启动，且在其开关关闭时不运行。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 组件 | 所示行为 |
| --- | --- | --- |
| `c03-unnamed-disable-rolls-back` | `update`, 插件管理器 | 停用了报告未列出插件的目标未通过 H3，并回滚到上一个发布与快照。 |
| `c03-health-timeout-rolls-back` | `update` | Host 在启动 120 秒后仍未就绪的目标会回滚。 |
| `c03-unverified-metadata-shown` | `update` | `package.json` 无法解析的插件显示为 `manifest-unreadable` 与 `unverified`，且 `--yes` 不会确认该报告。 |
| `c03-yes-refuses-unchecked-log` | release-chain | `log` 为安装所记录的 `unchecked` 的报告会显示该状态以及未能访问日志的那一行；`--yes` 拒绝它，不应用任何内容。 |
| `c03-delorun-requirement-excludes-target` | `update` | `engines.delorun` 排除目标的插件显示为 `delorun-requirement-unmet`，并附有两个目标版本。 |
| `c03-no-report-for-unverified-target` | `update` | manifest 签名验证失败的目标不产生报告，更新停止。 |
| `c03-no-silent-disable-at-start` | 插件管理器 | 启动时不兼容的插件以 Update、Keep disabled 与 Roll back 报告。 |
| `c03-sanitize-writes-history` | 插件管理器 | 桌面致命错误恢复在停用第三方插件之前写入一个历史版本。 |
| `c03-restore-lists-changes` | `profile-safety` | 恢复一个会带回插件、构建批准与豁免的版本时，在任何文件改变之前，批准提示中显示全部三项。 |
| `c03-restore-revoked-stays-disabled` | `profile-safety` | 恢复一个含有已撤销插件版本的版本时，该插件版本以停用状态恢复，并附上原因。 |
| `c03-failed-restore-reverts` | 插件管理器 | 安装步骤失败的恢复让每个 profile 文件保持原样。 |
| `c03-desktop-update-leaves-cli` | `update`, 桌面更新器 | 更新桌面 Host 不改变 CLI home 的版本与状态，且两者都出现在报告中。 |
| `c03-data-change-named` | update | 数据事实不同的两个发布产生一个 `data-format-changed` 条目，附带副本大小与可用空间。 |
| `c03-unknown-data-format-is-unverified` | update | 没有 `data-formats.json` 的发布产生 `data-format-unknown`，即 `unverified`，且 `--yes` 不会确认该报告。 |
| `c03-yes-takes-the-copy` | update | 对带有 `data` 条目的报告执行 `delorun update --yes` 会取得会话数据副本。 |
| `c03-copy-without-space-refuses` | update | 大于可用空间的副本会以 `DATA_COPY_NO_SPACE` 拒绝更新，运行时保持不变。 |
| `c03-rollback-restores-copy-and-sets-aside` | update | 目标启动之后的回滚会恢复副本，并把较新的数据移到 `data-set-aside/`。 |
| `c03-rollback-without-copy-refuses` | update | 目标启动之后、数据已改变且没有副本的回滚会以 `ROLLBACK_NEEDS_DATA_COPY` 拒绝，而 `--profile-only` 恢复快照并保留目标。 |
| `c03-rollback-before-first-start-needs-no-copy` | update | 目标启动之前的回滚无需副本即可恢复快照与运行时，并保留数据。 |
| `c03-pointer-swap-applies-the-table` | update | 在没有 home 进程运行时执行的 `delorun recover rollback` 会应用该表；它从不单独交换指针。 |
| `c03-second-rollback-keeps-both-set-asides` | update | 两轮更新加回滚会留下两个搁置目录。 |
| `c03-interrupted-restore-completes-before-a-host-starts` | update | 在两次重命名之间被终止的恢复会在下一次启动时、Host 启动之前完成。 |
| `c03-peer-requirement-excludes-target` | update-notice | 只通过 peer 声明其 DSH 范围、且其中一个 peer 排除目标的插件为 `dsh-requirement-unmet` 并被停用，附带上游预检为它报告的要求。 |
| `update-notice-sends-no-identifier` | update-notice | 检查的每个请求都是对通道文件的裸 `GET`，不带查询、cookie、请求体、profile、插件或正在运行的版本。 |
| `update-notice-unverified-index-silent` | update-notice | 未通过验证的时间戳或 manifest 会记录失败，并保留上次验证的发布。 |
| `update-notice-replayed-timestamp-refused` | update-notice | 早于已存储时间戳的时间戳会被拒绝。 |
| `update-notice-writes-no-trust-state` | update-notice | 检查让 `trust/` 保持原样，且不运行在线日志检查。 |
| `update-notice-deadline` | update-notice | 主机始终不回答时，检查在其截止时间结束。 |
| `update-notice-regressed` | update-notice | 早于记录中的时间戳，或同一通道上更低的发布，会记录 `regressed`，并保留此前验证的发布。 |
| `update-notice-hostile-text` | update-notice | 主机放在未签名字段中的文字既不会进入记录，也不会进入 `delorun doctor`，home 日志保存的是其转义后的形式。 |
| `update-notice-manifest-length-capped` | update-notice | 声明的 manifest 超过其大小上限的时间戳会在获取 manifest 之前被拒绝。 |
| `update-notice-retries-after-failure` | update-notice | 失败的检查会在一小时之后重试，然后是两小时与四小时之后，从不晚于该间隔。 |
| `update-notice-wall-clock` | update-notice | 睡眠超过间隔的机器会在其第一次整点唤醒时检查。 |
| `update-notice-running-release-retried` | update-notice | 读取失败之后，会再次读取正在运行的发布的文件。 |
| `update-notice-record-unremovable` | update-notice | 无法移除的记录会被写入日志，启动继续。 |
| `update-report-applies-nothing` | update | `delorun update --report` 打印报告，不询问任何内容，也不应用任何内容。 |
| `update-notice-off-makes-no-request` | update-notice | 开关关闭时，该行不挂载任何服务与路由。 |
| `update-notice-remote-session-offers-no-action` | update-notice | 远程会话的提示不提供任何控件。 |
| `c03-harness-change-carried` | update | 目标未改动的 harness 文件的变更为一个 `harness-change-carried` 条目，`kept` 且 `verified`，写明目标所运行内容的 SHA-256，`--yes` 仍会确认该报告；应用更新时会写入带有沿用文件的目标记录和一条在 `update` 时决定的已应用日志条目，回滚则再次运行上一个 runtime 自己的记录（`harness-items.spec.ts`、`harness-update.integration.spec.ts`、`update.e2e.integration.spec.ts`）。 |
| `c03-harness-change-merged` | update | 目标改动过但与之不重叠的 harness 文件的变更为一个 `harness-change-merged` 条目，`changed` 且 `verified`，提供 `skip-update`，并附带从目标的文件到合并后文件的 diff；`delorun update` 打印该 diff，`--yes` 不会确认该报告（`@delorun/update` 与 CLI 中的 `harness-items.spec.ts`、`command.spec.ts`、`harness-merge.spec.ts`）。 |
| `c03-harness-report-stale` | update | 在 harness 锁内合并结果与已确认报告的 `harness` 条目在文件、`merge` 或 `result` 上不同的应用，会在写入或切换任何内容之前以 `HARNESS_REPORT_STALE` 拒绝；home 进程把它保留的报告交给沿用步骤（`harness-carry.integration.spec.ts`、`harness-update.integration.spec.ts`、`handshake.integration.spec.ts`）。 |
| `c03-harness-conflict-keeps-mine` | update | 与目标冲突的 harness 文件变更为一个 `harness-change-conflicts` 条目，`disabled`，提供 `skip-update`，`--yes` 不会确认该报告；应用更新时运行目标的文件，并把本人的内容以 `<file>.mine` 写在目标可写副本中它的旁边（`harness-items.spec.ts`、`command.spec.ts`、`harness-update.integration.spec.ts`）。 |
| `c03-previous-release-reads-delorun-records` | update | `delorunRecords` 列出的每份记录都按所列版本写入，且一个发布写入的更新记录会由同一读取方读回。 |
