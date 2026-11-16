---
description: "@delorun/update 包，供 Delorun 更新路径与 studio 更新界面的维护者使用：约定 C3 的更新前报告，列出更新将停用、移除或更改的每个插件、组合包与 profile 行，以及各自的原因、该预测是否基于 Delorun 能够读取的元数据、两套安装的版本与更新状态，还有 `delorun update --yes` 必须通过的关卡。"
kind: "package-library"
---

# @delorun/update

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包构建[约定 C3](../../docs/contracts/c03-update-report.zh.md) 的更新报告：目标发布将在本人的 profile 中改变或破坏什么，并在任何内容改变之前显示。它读取 profile 与已暂存的目标，不导入任何插件代码，并返回报告中的事实——目标将停用、移除或更改的每个插件、组合包与 profile 行，连同各自的原因、该预测是 `verified` 还是 `unverified`，以及报告给出的选项；两套安装的版本与更新状态；以及计数。报告是 [`@delorun/contract-update-report`](../contract-update-report/README.zh.md) 的实例，其类型就是报告的格式。运行时仓库 的 `prepare` 与 `reportRollback`（[`@delorun/runtime-store`](../runtime-store/README.zh.md)）通过 home 进程 的更新握手（[`@delorun/home-process`](../home-process/README.zh.md)）调用它，`delorun update` 在请求本人确认之前打印该报告。

## 目录

- [报告决定什么](#what-the-report-decides)
- [两条版本轴](#the-two-version-axes)
- [组合包与行](#bundles-and-rows)
- [两套安装](#both-installations)
- [数据格式](#data-formats)
- [harness 变更](#harness-changes)
- [会话数据副本](#the-session-data-copy)
- [唯一的回滚函数](#the-one-rollback-function)
- [不经询问即确认](#confirming-without-asking)
- [句子](#the-sentences)
- [供其他包使用的接缝](#seams-for-other-packages)
- [尚未实现](#not-implemented)
- [测试](#tests)

<a id="what-the-report-decides"></a>

## 报告决定什么

`buildUpdateReport(input)` 接收正在更新的那套安装、两个发布、profile 的事实、目标的事实以及两份状态记录，并返回报告。它按种类（`plugin`、`bundle`、`row`、`data`、`harness`）再按主体对条目排序，并把每种效果的条目数以及与之并列的未验证、`data` 和 `harness` 条目数填入 `counts`。

有两项拒绝是报告自身的保证，并以带类型的 `UpdateReportError` 抛出。签名或新鲜度检查未通过、或发布日志检查失败的目标完全得不到报告（`REPORT_TARGET_UNVERIFIED`），因为约定 C3 的 R2 规定：只有这样的目标才存在报告；安装时记录为 `unchecked` 的发布日志检查会得到一份报告，其 `release.log` 说明这一点。而当条目陈述的事实缺失或无法读取时，该条目就是 `unverified`：无法解析的 `package.json`、不是范围的声明、未声明任何要求的插件、其所载插件的元数据无法读取的行。未验证的条目从不被当作安全，R3 要求这一点可见而不是被隐藏。

有三项约定留给报告决定的取舍，记录在此。被目标撤销列表撤销的插件只得到一条 `plugin-revoked` 条目，而不再有要求条目，因为无论其范围如何，该列表都拒绝该版本，而给出豁免就等于允许继续运行被列表撤销的版本。清单无法读取的插件被保留，标记为 `manifest-unreadable` 与 `unverified`：没有任何东西说明更新会破坏它，也没有任何东西说明不会。不改变任何内容的条目（`kept` 的插件、被替换的组合包列表、随插件条目而来的停用行）不给出操作，因为约定 C3 的封闭列表列出的是能改变结果的选择。

<a id="the-two-version-axes"></a>

## 两条版本轴

每个已安装的插件都由 `evaluatePluginAxes` 按[约定 C17](../../docs/contracts/c17-plugin-versions.zh.md) 的两条轴检查：它以更新将安装的 DSH 与 Delorun 调用上游自己的 `evaluatePluginCompatibility` 与 `evaluateDelorunRequirement`（来自 `@deepseek-ai/dsh-app-boot`），即插件安装器与启动预检所调用的同一组函数。在 DSH 轴上，声明了 `engines.dsh` 时由它单独决定；否则每个 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` peer 都必须接纳目标，因此只通过 peer 声明范围的插件，会在下一次启动将停用它时被停用。当版本满足范围（预发布版本参与其中）时范围即被满足；空、`workspace:` 或无效的范围则未被满足；上游拒绝读取的声明为 `requirement-unreadable`。

每条轴各有 profile 中的一个精确版本豁免文件（[`@delorun/contract-plugin-versions`](../contract-plugin-versions/README.zh.md) 给出两者的文件名），把精确的 `package@version` 键映射到该轴的精确版本。豁免只接纳一个版本，从不接纳范围，因此有三种结局彼此不同，报告也把它们分开：目标不满足且无豁免覆盖的插件是 `dsh-requirement-unmet` 或 `delorun-requirement-unmet`，会被停用；豁免中列明目标版本的插件是 `requirement-exempted`，会被保留；而在今天凭覆盖当前运行版本的豁免运行的插件，若豁免未列明目标版本，则是 `exemption-not-carried`，会被停用——其句子会同时列出两个版本，本人因此看到更新夺走了什么。任一轴不匹配都按约定 C3 的要求给出 `update-plugin` 与 `allow-version`，并在句子中列出两个目标版本。

<a id="bundles-and-rows"></a>

## 组合包与行

组合包条目由目标自身的表及其组合包的元数据决定。目标退役列表中的组合包会离开组合包列表（`bundle-retired`，移除）。目标无法加载的组合包被停用，并带上调用方读到的失败（`bundle-skipped`）：由上游的某条跳过规则判定时为 `verified`，组合包元数据无法读取时为 `unverified`；模板新增的组合包若目标无法加载，也会被列为已跳过。当 profile 的列表匹配上一份由安装方拥有、DSH 会以其模板替换的列表时，整个列表被替换：离开的每个组合包与模板新增的每个组合包都是 `bundle-template-normalised`，而 `predictBundleList` 返回目标的模板，健康检查标准 H5 用它比对 profile。

行条目由各层决定：先是目标加载的组合包的 patch 层（`BundleFacts.layers`），再是 profile 自己的层（`ProfileFacts.layers`）。每一层——组合包、profile patch、home patch 或 overlay——逐行遍历。载入被更新停用的插件的行是 `row-disabled`，其句子列出该行、该层与该插件。当一个 Include 内任一行触达此类插件时，整个 Include 被停用（`row-include-blocked`），因为 Include 作为一个文件载入。行的条目携带停用它的插件条目的验证状态，因此依赖无法读取的元数据的行也同样是未验证的。

<a id="both-installations"></a>

## 两套安装

`installations` 始终包含两套安装，按显示顺序、`cli-home` 在前。每一项是各安装写入、由调用方读取的记录；缺失或无法读取的记录会让该安装显示为 `unknown` 且不带版本——报告不虚构任何状态。更新其中一套绝不会切换另一套：桌面 Host 的报告显示 CLI home 自己的 Delorun 版本、DSH 版本与状态保持不变，而构建器完全不写入任何内容。

<a id="data-formats"></a>

## 数据格式

`dataFormatsOf` 根据上游的 `docs/persistence-schema.json` 与 `DELORUN_RECORDS`（Delorun 自己的包保存在 home 下的带版本记录）写出发布的 `data-formats.json`；`delorun/apps/release` 把它写在每个运行时闭包的根目录，因此签名文件列表涵盖它。`compareDataFacts` 比较两个发布：清单的 `dsh` 版本、`persistence` 摘要与 `delorunRecords`。上游的 schema 清单涵盖 Session 的头部、信封与事件，但不涵盖 `storages/` 下的任何存储单元，因此 `dsh` 版本不同本身就算作一次变更。`dataItems` 把一次变更转为一条 `data` 条目，即 `data-format-changed` 且已验证；任一侧文件缺失或无法读取则为 `data-format-unknown` 且未验证；两者都带有副本的大小与可用空间，并给出 `copy-session-data` 与 `continue-without-copy`。

<a id="harness-changes"></a>

## harness 变更

`harnessItems` 根据 `HarnessFact` 把运行中运行时的每个已批准 harness 文件转为一条 `harness` 条目：该文件，以及 CLI 的来源用 `@delorun/changes` 的三方合并、针对目标已验证的文件计算出的 `HarnessMerge`。合并结果为 `release-unchanged` 或 `in-release` 时是 `harness-change-carried`，保留，无操作；`merged` 是 `harness-change-merged`，已更改，给出 `skip-update`，并带有该事实中从目标文件到合并后文件的 `diff`，而 `confirmsWithoutAsking` 对它返回 false，所以 `--yes` 绝不会确认它；其他任何结果都是 `harness-change-conflicts`，已停用，给出 `skip-update`，`--yes` 同样绝不会确认它。已携带或已合并的条目陈述该事实的 `result`，即目标所运行内容的 SHA-256 和可执行位，应用时会与它自己的合并结果比较。全部已验证。本包不读取任何 harness 记录，也不读取任何存储，所以不依赖 `@delorun/changes`。只有目的为 `update` 的报告才读取 `ReportSources.harness`：回滚的报告（`rollback`）没有 `harness` 条目，因为回滚到的运行时运行的是它自己的已批准文件。

<a id="the-session-data-copy"></a>

## 会话数据副本

`saveDataCopy` 用 `COPYFILE_FICLONE`（不支持时退回完整复制）把 home 的 `sessions/` 与 `storages/` 复制到 `data-copies/.tmp-<16 hex>/`，同步每个文件与 `copy.json`，再把它重命名为 `data-copies/<to>/`，替换同一版本先前的副本；其他版本的副本保留。当 `sessions/` 或 `storages/` 是符号链接或不是目录时，它在写入任何内容之前以 `DATA_NOT_A_DIRECTORY` 拒绝；其中的符号链接按链接复制，从不跟随。`assertCopyFits` 以 `DATA_COPY_NO_SPACE` 拒绝大于可用空间的副本。更新提交时，`keepOnlyCopy` 删除除已提交更新的副本以外的所有副本；更新在切换之前结束时，`discardCopy` 删除已结束更新的副本；还原的日志存在期间，两者都以 `DATA_IN_USE` 拒绝。

另一次还原的日志存在期间，`restoreDataCopy` 以 `DATA_IN_USE` 拒绝。它在第一次重命名之前写入 `data-copies/restore.json`，把实时目录移到 `data-set-aside/<to>-<time>/`，把副本的目录移入 home，把 `copy.json` 放到被搁置的数据旁，并统计它搁置而副本中没有的 chat。每次重命名之后，它同步两个目录，并持久地重写日志的 `done` 计数。`recoverDataCopies` 在任何 Host 启动之前根据该日志完成被终止的还原，并删除未完成的副本：它跳过 `done` 计数的步骤，把源已不存在而目标存在的下一步视为已完成，两者都存在或都不存在时以 `DATA_RESTORE_INCONSISTENT` 拒绝，因此在任何时刻被终止的还原，最终状态都与未被中断的还原相同。

`listKeptData` 与 `discardKeptData` 即 `delorun recover status` 与 `discard`。还原的日志存在或回滚正在进行时，以及对于更新记录仍引用的副本，`discardKeptData` 以 `DATA_IN_USE` 拒绝。除 `keepOnlyCopy`、`discardCopy` 与本人的 `discard` 之外，这里没有任何内容会删除 chat 数据。

<a id="the-one-rollback-function"></a>

## 唯一的回滚函数

`rollbackUpdate` 就是约定 C3 的回滚表，每一种回退途径都调用它：home 进程 的 `rollback`、其自动回滚、更新中断后的重启，以及没有 home 进程 时的 `delorun recover rollback`。带 `profileOnly` 时它只还原 profile 快照。否则 `decideRollback` 根据更新记录以及是否存在可用副本选出表中的行：记录表明已制作副本，`data-copies/<to>/` 中有完整副本，且副本的制作时间不早于更新开始，因此先前尝试的副本从不会被还原。拒绝（`ROLLBACK_NEEDS_DATA_COPY`）发生在任何步骤之前。接着，调用方的 `preflight` 检查要回滚到的版本已安装并通过其启动检查，其错误原样传给调用方且不改变任何内容；`markRollingBack` 把阶段 `rolling-back` 写入更新记录；然后函数在行要求时还原副本，还原 profile 快照，并调用调用方的指针切换。

已处于 `rolling-back` 阶段的记录会完成那次回滚：函数从不拒绝，运行 `preflight`，完成被终止打断的还原，只在仍有可用副本时还原副本（否则数据步骤已经运行过），然后还原 profile 快照并切换运行时。

<a id="confirming-without-asking"></a>

## 不经询问即确认

`confirmsWithoutAsking(report)` 就是 `delorun update --yes` 所应用的规则：它确认一份没有任何 `disabled` 或 `removed` 条目、没有未验证条目且 `release.log` 为 `passed` 的报告。其他情况都需要本人，这也正是为什么一个全部由未声明要求的插件组成的 profile 无法在无人值守下被确认——它们与目标的兼容性并未被陈述。已验证的 `data` 条目是 `changed`，不会阻止 `--yes`，后者会制作副本；`data-format-unknown` 条目未经验证，会阻止它。

<a id="the-sentences"></a>

## 句子

`reasonMessage(item, versions)` 用约定 C3 原因表给出的措辞陈述每个原因，`UNVERIFIED_NOTE` 是显示在未验证条目旁的句子，`uncheckedMessage(source)` 是为 `notChecked` 中的来源显示的句子。这些文字放在本包中，因为它们是约定的一部分，而不是某个界面的文案：`delorun update` 原样打印它们。这些文字只到达人，这里没有任何内容会是会话事件或工具结果，因此没有模型会看到它，也没有会话记录会携带它。

<a id="seams-for-other-packages"></a>

## 供其他包使用的接缝

`buildFromSources(installation, sources, version)` 读取每项事实并返回 `{ report, health, dataDiffers }`：`health` 是约定 C3 的健康检查用来约束目标的内容（H3 的停用插件，H3 与 H4 的具名行，H5 的预测组合包列表）。它正是 运行时仓库 接缝所声明的 `UpdateReporter`，`src/service.ts` 把同一构建挂载为 Cordis 服务 `ctx.updateReport`。

| 接口 | 由谁实现 |
| --- | --- |
| `ReportSources`：`running`、`statuses`、`profile`、`target`、`data`、`harness`、`now` | `delorun/apps/cli/src/update/sources.ts`：两个运行时的 C1 store，profile 的清单、插件、patch 层与豁免文件，目标的组合包表及其加载的组合包（`bundle-layers.ts`），两份状态记录，两个发布的 `data-formats.json`，以及运行中运行时的 harness 记录与目标已验证文件的合并（`harness-items.ts`） |
| `UpdateReporter.build` | `buildFromSources`，由 `HomeRuntimeStore.prepare`（目的为 `update`）与 `reportRollback`（目的为 `rollback`）经由 CLI 的更新支持调用 |

同一时间只构建一份报告，对已在构建的同一版本的第二次请求会加入该构建。构建是上下文的 effect，因此已销毁的上下文不会返回报告：仍在等待的调用方会收到 `REPORT_DISPOSED` 拒绝，而不会被交给一份来自已不存在上下文的报告。

<a id="not-implemented"></a>

## 尚未实现

- CLI 的读取器不读取任何撤销列表，因为没有任何发布公布撤销列表；报告在 `notChecked` 中列出 `revocations`，健康检查的 H3 会捕获目标停用而报告未列出的插件。
- 已保存报告的读取器不校验任何内容：保存在某个 profile 历史版本中的报告，由其读取器按约定类型读回，报告格式自身没有校验器。
- studio 的更新界面（WP6.3）会显示这份报告。其文案在落地时经由 Web UI 的语言字典；本包的句子属于 CLI。
- 健康检查自身的标准（H1 至 H5）运行在 CLI 的 Host（`delorun/apps/cli/src/update/host.ts`）中，回滚触发条件运行在 home 进程 的握手中，都不在本包；`health` 正是它们比对的依据。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/update` 运行这些规格：清单读取器，带有更新前后两侧豁免的两条版本轴，报告的形态、顺序、计数与两套安装，组合包与行条目，约定 C3 陈述的句子，`--yes` 关卡，以及服务的构建、加入、版本检查与销毁。`tests/denial.spec.ts` 按约定 id 承载约定 C3 为本包列出的拒绝测试：`c03-unverified-metadata-shown`、`c03-delorun-requirement-excludes-target`、`c03-peer-requirement-excludes-target`、`c03-no-report-for-unverified-target` 与 `c03-desktop-update-leaves-cli`；`tests/harness-items.spec.ts` 承载 `c03-harness-change-carried`、`c03-harness-change-merged` 与 `c03-harness-conflict-keeps-mine`；`tests/data-formats.spec.ts`、`tests/data-copy.spec.ts` 与 `tests/rollback.spec.ts` 承载数据格式、副本与回滚表的拒绝测试，`delorun/apps/cli/tests/update/` 承载端到端的拒绝测试。
