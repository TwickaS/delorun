---
description: "契约 C3：Delo 更新应用之前显示的更新报告，其条目（插件、组合包、行、原因、已验证或未验证）与原因代码，CLI home 与桌面 Host 的版本与更新状态，健康检查标准，回滚触发条件，以及撤销与恢复的检查与批准提示。"
---

# C3 更新报告

[English](c03-update-report.md) | 中文

## 摘要

更新应用之前，Delo 会显示目标发布将在本人（the person）的 profile 中改变或破坏什么：它将停用、移除或更改的每个插件、组合包与 profile 行，连同原因，以及该预测是基于 Delo 能够读取的元数据（已验证）还是不能读取的元数据（未验证）。本人确认之前，任何内容都不会应用。CLI（命令行界面）home 与桌面 Host 是彼此独立更新的两套安装，报告同时显示两者的版本与更新状态。切换之后，健康检查会在 120 秒内判定更新是否成立；检查失败会自动回滚，本人之后也可以随时回滚。profile 历史（profile history）的撤销与恢复会运行与安装相同的插件检查，并在应用之前列出它们会改变的内容。类型位于 [`@delo/contract-update-report`](../../packages/contract-update-report/README.zh.md)。

## 目录

- [安装与更新状态](#installations-and-update-states)
- [何时生成报告](#when-a-report-is-made)
- [报告字段](#report-fields)
- [条目](#items)
- [原因](#reasons)
- [已验证与未验证](#verified-and-unverified)
- [应用更新](#applying-an-update)
- [健康检查](#health-check)
- [回滚触发条件](#rollback-triggers)
- [撤销与恢复](#undo-and-restore)
- [值与限制](#values-and-limits)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="installations-and-update-states"></a>

## 安装与更新状态

| 安装 | Id | 更新途径 |
| --- | --- | --- |
| CLI home：运行时仓库（runtime store）与 home 进程（home process） | `cli-home` | `delorun update` 与 studio 的「Update now」，经由更新通道（[C19](c19-home-process.zh.md)） |
| 桌面应用及其 Host | `desktop-host` | Delo 更新源上的桌面更新程序（[C2](c02-release-manifest.zh.md#desktop-updates-and-rollback)） |

每套安装都有自己的 profile，以及自己的 Delo 与 DSH 版本；更新其中一套从不切换另一套。每套安装都在 [C1](c01-home-layout.zh.md) 指定的路径写入自己的状态记录（安装 id、Delo 版本、DSH 版本、通道、更新状态、目标版本、时间），每份报告都会读取另一套安装的记录。记录缺失或无法读取时，该安装显示为 `unknown`。

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

<a id="when-a-report-is-made"></a>

## 何时生成报告

报告针对一套安装与一个目标发布生成，时机是在目标的文件下载、验证（[C2](c02-release-manifest.zh.md#client-verification)、[C18](c18-release-log.zh.md)）并暂存之后，且在 profile 或活动运行时中的任何内容改变之前。验证失败的目标不会得到报告；更新随即停止。报告读取 profile 与暂存的目标，不导入任何插件代码。

<a id="report-fields"></a>

## 报告字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema` | `delo.update-report/1` | 报告格式。 |
| `installation` | `cli-home` 或 `desktop-host` | 正在更新的安装。 |
| `from`、`to` | `{ "delo", "dsh", "channel" }` | 正在运行的版本与目标版本（[C17](c17-plugin-versions.zh.md#the-two-versions)）。 |
| `release` | `{ "manifest": sha256, "signature", "freshness", "log" }` | 目标的 manifest（元数据清单）摘要与各项检查的结果；凡是显示出来的报告，这三项均为 `passed`。 |
| `generated` | 时间戳 | 报告的生成时间。 |
| `installations` | `{ "id", "delo", "dsh", "state", "target"? }` 的列表 | 两套安装的版本与更新状态。 |
| `items` | 条目列表 | 发生改变的全部内容，先按种类、再按主体排序。 |
| `counts` | `{ "disabled", "removed", "changed", "unverified" }` | 具有每种效果的条目数，以及未验证条目数。 |

报告保存在快照的历史版本中，因此历史会显示该更新被预测将改变什么。

<a id="items"></a>

## 条目

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `kind` | `plugin`、`bundle` 或 `row` | 条目所涉及的内容。 |
| `subject` | 对象 | 对于 `plugin`：`{ "name", "version" }`；对于 `bundle`：`{ "package" }`；对于 `row`：`{ "id"?, "name", "layer" }`，其中 `layer` 指明持有该行的组合包、profile patch、home patch 或 overlay。 |
| `reason` | 原因代码 | 改变的原因（[原因](#reasons)）。 |
| `effect` | `disabled`、`removed`、`changed` 或 `kept` | 它在目标上会发生什么；`kept` 只出现在本人应当看到的已豁免或未验证主体上。 |
| `verification` | `verified` 或 `unverified` | 预测是否基于 Delo 读取的元数据（[已验证与未验证](#verified-and-unverified)）。 |
| `detail` | 对象 | 该原因的事实，例如要求范围、版本轴、撤销消息或替代组合包。 |
| `actions` | 列表 | 提供的选项：`update-plugin`、`keep-disabled`、`allow-version`、`skip-update`。 |

<a id="reasons"></a>

## 原因

| 原因 | 种类 | 效果 | 消息 |
| --- | --- | --- | --- |
| `dsh-requirement-unmet` | plugin | disabled | `<plugin> requires DSH <range>; Delo <to.delo> runs DSH <to.dsh>.` |
| `delo-requirement-unmet` | plugin | disabled | `<plugin> requires Delo <range>; the update installs Delo <to.delo>.` |
| `requirement-unreadable` | plugin | disabled | `<plugin> declares engines.<axis> in a form Delo cannot read.` |
| `requirement-exempted` | plugin | kept | `<plugin> requires <DSH or Delo> <range>; your exemption for this exact version covers <version>.` |
| `exemption-not-carried` | plugin | disabled | `<plugin> runs today under your exemption for <from version>; the exemption does not cover <to version>.` |
| `requirement-undeclared` | plugin | kept | `<plugin> declares no DSH requirement, so its compatibility with DSH <to.dsh> is not stated.` |
| `plugin-revoked` | plugin | disabled | `<plugin> is revoked: <reason>, <message>.`（[C13](c13-catalogue-revocation.zh.md#revocation-list)） |
| `manifest-unreadable` | plugin | kept | `Delo could not read <plugin>'s package.json; it cannot predict what the update does to it.` |
| `bundle-retired` | bundle | removed | `<bundle> is retired in DSH <to.dsh> and leaves the bundle list.`（上游的 `RETIRED_BUNDLES`） |
| `bundle-template-normalised` | bundle | changed | `The bundle list matches an installation-owned list that DSH <to.dsh> replaces with its template.` |
| `bundle-skipped` | bundle | disabled | `<bundle> cannot load on the target: <reason>.`（上游的 `skippedBundles`） |
| `row-disabled` | row | disabled | `Row <id or name> in <layer> loads <plugin>, which the update disables.` |
| `row-include-blocked` | row | disabled | `Include <file> reaches <plugin>, which the update disables, so the whole Include is disabled.` |

任一版本轴不匹配时，报告会写明两个目标版本，其 `actions` 提供将插件更新到满足目标的版本，并针对未满足的那条轴，提供在目标版本上的精确版本豁免（[C17](c17-plugin-versions.zh.md#exemptions)）。

<a id="verified-and-unverified"></a>

## 已验证与未验证

当条目陈述的每项事实都读自 Delo 检查过的来源时，该条目为 `verified`：已安装插件的 `package.json`、暂存目标的包，以及已验证的 manifest。当某项事实缺失或无法读取时，条目为 `unverified`，例如无法解析的 manifest、模块无法解析的行，或未声明要求的插件。未验证条目从不被算作安全：报告在每个此类条目旁显示 "Delo cannot predict this item"，摘要也会统计它们。健康检查将它们与报告列出的条目同等对待。

<a id="applying-an-update"></a>

## 应用更新

1. 本人确认报告；`delorun update` 会打印报告并询问，`delorun update --yes` 会确认一份既没有 `disabled` 或 `removed` 条目、也没有未验证条目的报告。
2. 写入快照：一个名为「Before update to Delo <to.delo>」的 profile 历史版本，包含 profile patch、home patch、组合包列表、两个豁免文件、该 profile 的 `pnpm-workspace.yaml` 以及报告。
3. 运行中的 chat 结束，或由本人停止；CLI 的切换经由 home 进程的更新握手进行，该握手从不在 chat 运行时切换（[C19](c19-home-process.zh.md)），桌面应用则在其重启前步骤中完成这一步。
4. 目标启动，健康检查开始运行。

<a id="health-check"></a>

## 健康检查

目标启动后 120 秒内以下各项全部成立时，更新成立：

- H1. 目标的运行时文件依据其 manifest 验证通过，且其发布日志状态不是 `failed`（[C2](c02-release-manifest.zh.md#client-verification)、[C18](c18-release-log.zh.md#check-states)）。
- H2. Host 达到就绪：对于 `cli-home`，home 进程的 Host 已就绪，且 studio 的回环监听器对索引请求返回状态 200；对于 `desktop-host`，Host 通过 host 协议报告就绪，且主窗口加载 studio。
- H3. 目标停用、跳过或移除的每个插件、组合包与行，都是报告列出过的。
- H4. 报告未列出的每一行加载时都没有插件加载错误，但上一个发布也记录过其加载错误的行除外。
- H5. profile 的组合包列表等于报告预测的列表。

<a id="rollback-triggers"></a>

## 回滚触发条件

以下情况会运行自动回滚：

- T1. 任一健康标准未满足；
- T2. 目标启动 120 秒后健康检查仍未完成；
- T3. 目标的 Host 进程在健康检查期间退出。

应本人请求，本人之后可以随时从 studio 的更新界面、`delorun recover` 或桌面应用的回滚功能进行回滚。

回滚会恢复快照中的文件，并将安装切换回被替换的发布：对于 `cli-home`，是运行时仓库保留的运行时（[C1](c01-home-layout.zh.md)）；对于 `desktop-host`，是缓存的上一个发布（[C2](c02-release-manifest.zh.md#desktop-updates-and-rollback)）。回滚不改变 profile 与运行时仓库之外的任何 chat、工作区或文件。自动回滚之后，studio 会写明未满足的标准，失败的发布只有在显示该失败的情况下才会再次提供。失败的回滚会使状态保持为 `failed`，并提供安全模式与 `delorun recover`。

<a id="undo-and-restore"></a>

## 撤销与恢复

撤销（恢复到最近一次之前的版本）与恢复（任一历史版本）会带回 profile 文件，并随之带回插件版本、构建批准与豁免。在写入任何内容之前，两者都会：

- 对其带回的每个插件版本运行安装时运行的检查：两条版本轴（[C17](c17-plugin-versions.zh.md)）、撤销列表（[C13](c13-catalogue-revocation.zh.md)）、完整性固定值、pnpm 的构建批准，以及在挂载了 `pluginAudit` 服务时运行该服务，其发现显示为 [C13](c13-catalogue-revocation.zh.md#listed-findings) 中的状态；Delo 本身不运行任何插件审计；
- 显示一个批准提示，列出发生改变的插件（新增、移除或换成另一个版本）、发生改变的构建（恢复的版本允许、拒绝或保持待定的 pnpm `allowBuilds` 条目）以及发生改变的豁免（向 `compatibility.json` 与 `delo-compatibility.json` 新增或从中移除的授权）；
- 只在本人批准之后应用，并将结果写为一个新的历史版本。

当前撤销列表所撤销的插件版本会以停用状态恢复，并附上原因。撤销列表过期期间，如果一次撤销或恢复会安装 profile 中没有的插件版本，它会等待一份新鲜的列表，与新的插件索引安装相同（[C13](c13-catalogue-revocation.zh.md#stale-state)）。安装步骤失败的恢复会还原它写入的每个文件。

<a id="values-and-limits"></a>

## 值与限制

| 值 | 数值 |
| --- | --- |
| 健康检查时限 | 目标启动后 120 秒 |
| 每份报告读取的状态记录 | 2，每套安装一份 |

<a id="consumers"></a>

## 使用方

- `delo/packages/update/`（WP3.4）：生成报告。
- 上游的 `compatibility-preflight.ts`、`profile.ts`、`profile-sanitize.ts` 与插件管理器的恢复功能（WP3.5）：不静默停用，在规范化与清理之前写入历史版本，事务性恢复。
- `delo/packages/profile-safety/`（WP3.6）：撤销、恢复、安全模式与 `delorun recover`。
- studio 的更新界面与桌面更新程序（WP6.3）。

<a id="compatibility"></a>

## 兼容性

报告的 `schema` 指明其主版本；原因代码在该版本中构成封闭列表，新增原因即为新的主版本，因此读取方永远不会遇到它不认识的代码。上游自身的启动行为只按 WP3.5 列出的方式改变：启动时不兼容的插件会以 Update、Keep disabled 与 Roll back 报告，而不是被静默停用；桌面的致命错误恢复「Disable third-party plugins」会写入一个历史版本，并提供「Restore profile from before the update」；profile 规范化会先写入一个历史版本。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 任何更新都不会停用、移除或更改报告未列出的插件、组合包或行；健康检查强制执行这一点，否则回滚。
- R2. 本人确认报告之前不应用任何内容，且只有通过签名、新鲜度与日志检查的目标才会有报告。
- R3. 未验证条目以未验证的身份显示，从不被算作安全。
- R4. 健康检查失败会自动回滚；本人之后可以随时回滚；回滚不改变 profile 与运行时仓库之外的任何内容。
- R5. 撤销与恢复对其带回的内容运行安装时的插件检查，并在应用之前列出发生改变的插件、构建与豁免。
- R6. 显示两套安装的版本与更新状态，更新其中一套从不切换另一套。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 负责方 | 所示行为 |
| --- | --- | --- |
| `c03-unnamed-disable-rolls-back` | WP3.4, WP3.5 | 停用了报告未列出插件的目标未通过 H3，并回滚到上一个发布与快照。 |
| `c03-health-timeout-rolls-back` | WP3.4 | Host 在启动 120 秒后仍未就绪的目标会回滚。 |
| `c03-unverified-metadata-shown` | WP3.4 | `package.json` 无法解析的插件显示为 `manifest-unreadable` 与 `unverified`，且 `--yes` 不会确认该报告。 |
| `c03-delo-requirement-excludes-target` | WP3.4 | `engines.delo` 排除目标的插件显示为 `delo-requirement-unmet`，并附有两个目标版本。 |
| `c03-no-report-for-unverified-target` | WP3.4 | manifest 签名验证失败的目标不产生报告，更新停止。 |
| `c03-no-silent-disable-at-start` | WP3.5 | 启动时不兼容的插件以 Update、Keep disabled 与 Roll back 报告。 |
| `c03-sanitize-writes-history` | WP3.5 | 桌面致命错误恢复在停用第三方插件之前写入一个历史版本。 |
| `c03-restore-lists-changes` | WP3.6 | 恢复一个会带回插件、构建批准与豁免的版本时，在任何文件改变之前，批准提示中显示全部三项。 |
| `c03-restore-revoked-stays-disabled` | WP3.6 | 恢复一个含有已撤销插件版本的版本时，该插件版本以停用状态恢复，并附上原因。 |
| `c03-failed-restore-reverts` | WP3.5 | 安装步骤失败的恢复让每个 profile 文件保持原样。 |
| `c03-desktop-update-leaves-cli` | WP3.4, WP6.3 | 更新桌面 Host 不改变 CLI home 的版本与状态，且两者都出现在报告中。 |
