---
description: "@delo/update 包，供 Delo 更新路径与 studio 更新界面的维护者使用：契约 C3 的更新前报告，列出更新将停用、移除或更改的每个插件、组合包与 profile 行，以及各自的原因、该预测是否基于 Delo 能够读取的元数据、两套安装的版本与更新状态，还有 `delorun update --yes` 必须通过的关卡。"
kind: "package-library"
---

# @delo/update

[English](README.md) | 中文

## 摘要

本包构建[契约 C3](../../docs/contracts/c03-update-report.zh.md) 的更新报告：目标发布将在本人（the person）的 profile 中改变或破坏什么，并在任何内容改变之前显示。它读取 profile 与已暂存的目标，不导入任何插件代码，并返回报告中的事实——目标将停用、移除或更改的每个插件、组合包与 profile 行，连同各自的原因、该预测是 `verified` 还是 `unverified`，以及报告给出的选项；两套安装的版本与更新状态；以及计数。报告是 [`@delo/contract-update-report`](../contract-update-report/README.zh.md) 的实例，其类型就是报告的格式。runtime store 的 `prepare` 与 `reportRollback`（[`@delo/runtime-store`](../runtime-store/README.zh.md)）通过 home process 的更新握手（[`@delo/home-process`](../home-process/README.zh.md)）调用它，`delorun update` 在请求本人确认之前打印该报告。

## 目录

- [报告决定什么](#what-the-report-decides)
- [两条版本轴](#the-two-version-axes)
- [组合包与行](#bundles-and-rows)
- [两套安装](#both-installations)
- [不经询问即确认](#confirming-without-asking)
- [句子](#the-sentences)
- [供其他包使用的接缝](#seams-for-other-packages)
- [尚未实现](#not-yet-implemented)
- [测试](#tests)

## 报告决定什么

`buildUpdateReport(input)` 接收正在更新的那套安装、两个发布、profile 的事实、目标的事实以及两份状态记录，并返回报告。它按种类——`plugin`、`bundle`、`row`——再按主体对条目排序，并把每种效果的条目数以及未验证的条目数填入 `counts`。

有两项拒绝是报告自身的保证，并以带类型的 `UpdateReportError` 抛出。签名、新鲜度或发布日志检查未通过的目标完全得不到报告（`REPORT_TARGET_UNVERIFIED`），因为契约 C3 的 R2 规定：只有通过这些检查的目标才存在报告。而当条目陈述的事实缺失或无法读取时，该条目就是 `unverified`：无法解析的 `package.json`、不是范围的声明、未声明任何要求的插件、其所载插件的元数据无法读取的行。未验证的条目从不被当作安全，R3 要求这一点可见而不是被隐藏。

有三项契约留给报告决定的取舍，记录在此。被目标撤销列表撤销的插件只得到一条 `plugin-revoked` 条目，而不再有要求条目，因为无论其范围如何，该列表都拒绝该版本，而给出豁免就等于允许继续运行被列表撤销的版本。清单无法读取的插件被保留，标记为 `manifest-unreadable` 与 `unverified`：没有任何东西说明更新会破坏它，也没有任何东西说明不会。不改变任何内容的条目——被保留的插件、被替换的组合包列表、随插件条目而来的停用行——不给出操作，因为契约 C3 的封闭列表列出的是能改变结果的选择。

## 两条版本轴

每个已安装的插件都按[契约 C17](../../docs/contracts/c17-plugin-versions.zh.md) 的两条轴检查：`engines.dsh` 对照更新将安装的 DSH，`engines.delo` 对照它将安装的 Delo。语义沿用上游 `plugin-compatibility.ts` 向前一个发布的做法：当版本满足范围（预发布版本参与其中）时范围即被满足；空、`workspace:` 或无效的范围则未被满足。

每条轴各有 profile 中的一个精确版本豁免文件（[`@delo/contract-plugin-versions`](../contract-plugin-versions/README.zh.md) 给出两者的文件名），把精确的 `package@version` 键映射到该轴的精确版本。豁免只接纳一个版本，从不接纳范围，因此有三种结局彼此不同，报告也把它们分开：目标不满足且无豁免覆盖的插件是 `dsh-requirement-unmet` 或 `delo-requirement-unmet`，会被停用；豁免中列明目标版本的插件是 `requirement-exempted`，会被保留；而在今天凭覆盖当前运行版本的豁免运行的插件，若豁免未列明目标版本，则是 `exemption-not-carried`，会被停用——其句子会同时列出两个版本，本人因此看到更新夺走了什么。任一轴不匹配都按契约 C3 的要求给出 `update-plugin` 与 `allow-version`，并在句子中列出两个目标版本。

## 组合包与行

组合包条目由目标自身的表决定。目标退役列表中的组合包会离开组合包列表（`bundle-retired`，移除）。目标无法加载的组合包被停用，并带上上游的失败文本（`bundle-skipped`）。当 profile 的列表匹配上一份由安装方拥有、DSH 会以其模板替换的列表时，整个列表被替换：离开的每个组合包与模板新增的每个组合包都是 `bundle-template-normalised`，而 `predictBundleList` 返回目标的模板，健康检查标准 H5 用它比对 profile。

行条目由 profile 的各层决定。每一层——组合包、profile patch、home patch 或 overlay——逐行遍历。载入被更新停用的插件的行是 `row-disabled`，其句子列出该行、该层与该插件。当一个 Include 内任一行触达此类插件时，整个 Include 被停用（`row-include-blocked`），因为 Include 作为一个文件载入。行的条目携带停用它的插件条目的验证状态，因此依赖无法读取的元数据的行也同样是未验证的。

## 两套安装

`installations` 始终包含两套安装，按显示顺序、`cli-home` 在前。每一项是各安装写入、由调用方读取的记录；缺失或无法读取的记录会让该安装显示为 `unknown` 且不带版本——报告不虚构任何状态。更新其中一套绝不会切换另一套：桌面 Host 的报告显示 CLI home 自己的 Delo 版本、DSH 版本与状态保持不变，而构建器完全不写入任何内容。

## 不经询问即确认

`confirmsWithoutAsking(report)` 就是 `delorun update --yes` 所应用的规则：它确认一份没有任何 `disabled` 或 `removed` 条目、也没有未验证条目的报告。其他情况都需要本人，这也正是为什么一个全部由未声明要求的插件组成的 profile 无法在无人值守下被确认——它们与目标的兼容性并未被陈述。

## 句子

`reasonMessage(item, versions)` 用契约 C3 原因表给出的措辞陈述每个原因，`UNVERIFIED_NOTE` 是显示在未验证条目旁的句子。这些文字放在本包中，因为它们是契约的一部分，而不是某个界面的文案：`delorun update` 原样打印它们。这些文字只到达人，这里没有任何内容会是会话事件或工具结果，因此没有模型会看到它，也没有会话记录会携带它。

## 供其他包使用的接缝

`src/service.ts` 把报告挂载为 Cordis 服务 `ctx.updateReport`，它正是 runtime store 接缝所声明的 `UpdateReporter`——`build(version)` 返回 `{ report, disabledPlugins }`，其中 `disabledPlugins` 是健康检查用来约束目标的插件 id（H3）。

| 接口 | 由谁实现 | 在其落地之前 |
| --- | --- | --- |
| `ReportSources`：`running`、`statuses`、`profile`、`target`、`now` | CLI 的更新路径：profile 的读取器、C1 runtime store 提供的已安装目标，以及两套安装的状态记录 | CLI 尚无更新命令，因此 `delorun update` 不打印报告 |
| `UpdateReportService.build` | `delo/packages/runtime-store` 的 `HomeRuntimeStore.prepare` 与 `reportRollback` | store 的 prepare 以其自身的 `VERIFY_FAILED` 拒绝，且不构建报告 |

同一时间只构建一份报告，对已在构建的同一版本的第二次请求会加入该构建。构建是上下文的 effect，因此已销毁的上下文不会返回报告：仍在等待的调用方会收到 `REPORT_DISPOSED` 拒绝，而不会被交给一份来自已不存在上下文的报告。

## 尚未实现

- `ReportSources` 背后的读取器。profile 的插件、组合包列表、层与豁免文件，已安装目标自身的表，以及两份状态记录，各自都是其所有者要读取的文件，由 CLI 的更新路径组合起来；本包决定它们的含义。
- 已保存报告的读取器尚未校验任何内容：保存在某个 profile 历史版本中的报告，由其读取器按契约类型读回，报告格式自身的校验器将随历史读取器一起落地。
- studio 的更新界面（WP6.3）会显示这份报告。其文案在落地时经由 Web UI 的语言字典；本包的句子属于 CLI。
- 健康检查自身的标准（H1 至 H5）与回滚触发条件运行在 home process 的握手中，不在本包。`disabledPlugins` 与 `predictBundleList` 正是 H3 与 H5 比对的依据。

## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/update` 运行这些规格：清单读取器的四种分类，带有更新前后两侧豁免的两条版本轴，报告的形态、顺序、计数与两套安装，组合包与行条目，契约 C3 陈述的句子，`--yes` 关卡，以及服务的构建、加入、版本检查与销毁。`tests/denial.spec.ts` 按契约 id 承载契约 C3 为本包列出的拒绝测试：`c03-unverified-metadata-shown`、`c03-delo-requirement-excludes-target`、`c03-no-report-for-unverified-target` 与 `c03-desktop-update-leaves-cli`。
