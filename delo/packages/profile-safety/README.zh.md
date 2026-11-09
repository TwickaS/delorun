---
description: "@delo/profile-safety 库：约定 C3 中拒绝会丢失本人对 profile 所做改动的更新的携带检查、扩展后的 profile 历史、带审批清单的撤销与恢复、eject、安全模式，以及 delorun recover。"
---

# @delo/profile-safety

[English](README.md) | 中文

<a id="summary"></a>

## 摘要

本包让本人的 profile 在更新之后仍然是本人的。约定 [C3](../../docs/contracts/c03-update-report.zh.md) 要求任何更新都不得停用、删除或更改报告未列明的插件、bundle 或行，也要求撤销与恢复在写入任何内容之前列出它们会带回什么；本包负责做出这一判断并执行它。在更新改动任何文件之前，携带检查会把本人留下的 profile 与目标发布将留下的 profile 相比较，并在目标会删除本人添加的行、本地插件或设置，会重排或改写本人选择的 bundle 列表，或会把本人 eject 过的插件放回来时，以带类型的原因在任何改动发生之前拒绝。它写入的历史是上游 profile 历史的扩展，增加了 Delo 那一轴的豁免文件、Delo 自己的记录、home patch 的副本与更新报告，因此一个版本能带回整个 profile。eject 会移除插件，同时保留本人为它写的每一行与每一项设置；安全模式在不加载第三方插件的情况下启动，并且不修改 profile 中的任何文件；`delorun recover` 是报告 profile 在更新之后处于何种状态并执行回退方式的命令。

<a id="contents"></a>

## 目录

- [使用本包](#use-this-package)
- [携带检查](#the-carry-check)
- [profile 中包含什么](#what-a-profile-holds)
- [扩展后的历史](#the-extended-history)
- [撤销、恢复与回滚](#undo-restore-and-rollback)
- [eject](#eject)
- [安全模式](#safe-mode)
- [delorun recover](#delorun-recover)
- [错误](#errors)
- [未覆盖的范围](#not-covered)
- [开发](#development)

<a id="use-this-package"></a>

## 使用本包

```text
import { assertCarriable, planCarry, readInventory } from '@delo/profile-safety'

const before = readInventory({ profileDir, homeDir })
const plan = planCarry(before, targetInventory, { report })
assertCarriable(plan, profileDir)
```

`readInventory` 读取一个 profile 的 manifest、它自己的补丁层与 home 的补丁层，以及 Delo 的记录。目标的清单是同一种结构，读取自目标发布将留下的那个 profile，因此检查比较的是两个值，不写入任何内容。`report` 是构建过更新报告时的约定 C3 报告：某个条目列明的改动就是本人可以看到并确认的改动。`planCarry` 返回每一处差异与每一条拒绝；`assertCarriable` 抛出 `ProfileSafetyError`，携带第一条拒绝的代码、全部对象，以及提供本人的补救措施。

<a id="the-carry-check"></a>

## 携带检查

更新报告列明的差异是本人可以看到并确认的改动。报告未列明的差异绝不会被应用，而会丢失本人添加内容的差异会被直接拒绝。拒绝如下：

| 代码 | 它拒绝什么 |
| --- | --- |
| `ROW_NOT_CARRIED` | 本人补丁层添加的某一行会离开 profile，或本人停用的某一行会重新加载，而没有任何报告条目列明它。 |
| `CONFIGURATION_NOT_CARRIED` | 本人为某一行写的设置会被删除或更改，而没有任何报告条目列明该行。 |
| `LOCAL_PLUGIN_NOT_CARRIED` | 从这台机器安装的插件（`file:`、`link:`、`portal:`、`workspace:` 或路径）会离开 profile 或改到另一个 spec。 |
| `BUNDLE_LIST_NOT_CARRIED` | bundle 列表会被重排，或增加一个 bundle——这是任何报告原因都无法表达的；或丢失一个没有报告条目列明的 bundle。 |
| `EJECTED_PLUGIN_REINSTATED` | 本人 eject 过的插件会被放回来。 |
| `UNNAMED_CHANGE` | 目标会把本人没有要求、也没有报告条目列明的行、设置或插件写进本人的 profile。 |

检查在快照之前、切换之前运行，因此拒绝之后 profile 保持原样。报告自身的条目让改动可见：更新停用的插件是本人确认的条目，而加载它的那一行仍留在 profile 中，直到该插件被更新或重新启用。

<a id="what-a-profile-holds"></a>

## profile 中包含什么

`readInventory` 读取 profile 中属于本人的部分：

- bundle 列表，按应用顺序排列；
- profile 的 `cordis.patch.yml` 与 home 的补丁层添加的行，每行带有 id、插件名，以及本人补丁是否停用了它；
- 本人为某个 bundle 声明的行所写的设置，即本人设置的字段及其值；
- 从这台机器安装的插件，带有其 spec，以及 bundle 列表是否也选择了它；
- Delo 记录中的 eject。

manifest 或补丁层无法读取的 profile 会以 `PROFILE_UNREADABLE` 拒绝并指明该文件，因为对一个无法读取的 profile 做检查毫无意义。

<a id="the-extended-history"></a>

## 扩展后的历史

上游的 profile 历史跟踪插件管理写入的五个文件。Delo 的历史 `PROFILE_SAFETY_FILES` 包含这五个文件，另加四个：约定 C17 中 Delo 那一轴的 `delo-compatibility.json`、保存 eject 与恢复时保持停用的插件的 Delo 自有记录 `delo-safety.json`、作为 home patch 副本的 `home-cordis.patch.yml`，以及保存更新所见报告的 `delo-update-report.json`。`recordSnapshot` 写入更新在改动任何内容之前取得的那个版本，而约定 C3 的快照正是该版本。profile 与 home patch 之外的任何内容都不会被触碰。

<a id="undo-restore-and-rollback"></a>

## 撤销、恢复与回滚

`planRestore` 比较 profile 与某个历史版本，返回审批提示列出的计划，其结构依照约定 C3：被添加、删除或改到另一个版本的插件，发生变化的 pnpm `allowBuilds` 决定，以及任一轴文件中添加或移除的豁免。本地 `file:` spec 会出现在版本号的位置，因为那正是 profile 声明的内容。计划还会列出它将写入的文件、bundle 列表成员的变化，以及 lockfile 是否变化，因此只有在必须时才重新安装依赖集。在 `applyRestore` 之前不写入任何内容，而它只写入计划列出的文件。

当前撤销列表撤销的插件版本会以停用状态回来，并带上原因：被撤销的 bundle 离开 bundle 列表，被撤销插件的行在 profile 补丁中被停用，而插件本身仍然安装。没有 id 的行会以 `RESTORE_REFUSED` 拒绝，因为恢复无法只停用那一行。`rollbackToSnapshot` 是朝着更新所取快照执行的同一种恢复，历史中没有任何版本时会以 `RECOVER_REFUSED` 拒绝。

<a id="eject"></a>

## eject

`ejectPlugin` 从 profile 的 bundle 列表与依赖中移除一个包，并把这次 eject 记录到 `delo-safety.json`，附上本人的原因与时间。本人为它写的每一行与每一项设置都会保留，因此若再次安装，配置仍在；之后的更新也无法把该插件放回来——携带检查会以 `EJECTED_PLUGIN_REINSTATED` 拒绝。Delo 自己的 bundle 不能被 eject，因为约定 C11 的隐私默认值只在它加载时成立。

<a id="safe-mode"></a>

## 安全模式

安全模式在不加载第三方 bundle、也不加载本人为它们写的行的情况下启动 home。`delorun start` 会执行它：home 进程保留上游加载器返回的 profile，去掉其中的第三方层，并传入一个停用本人为它们写的行的覆盖补丁，因此唯一被写入的文件是标记 `run/<profile>/safe-mode.json`，位于 home 之下、profile 之外。因此以安全模式启动后，profile 的每个文件都保持原样——行、本地插件、设置、bundle 顺序与 eject——结束安全模式也无需修复。无法读取的标记会以 `SAFE_MODE_UNREADABLE` 拒绝，因此受损的 home 绝不会被当作正常的 home。

<a id="delorun-recover"></a>

## delorun recover

`delo/apps/cli/src/recover.ts` 为 `delorun recover` 运行 `recover`。不带动作时，它报告 profile 的上次更新、它的快照、最近的版本、它的 eject、恢复时保持停用的插件，以及安全模式是否开启。`--rollback` 回到更新所取的快照，`--restore <version>` 带回指定版本，`--safe-mode` 在不加载第三方插件的情况下启动，`--exit-safe-mode` 结束它。`--json` 把同一份报告打印为一个 JSON 值。

<a id="errors"></a>

## 错误

每个失败都是 `ProfileSafetyError`，带有 `code`、涉及的 `path`、本人读到的 `detail`、以约定 C3 措辞给出的 `remedies`，以及拒绝所涉及的 `subjects`。代码是封闭的：无法读取的 profile 文件为 `PROFILE_UNREADABLE`；上表中的携带代码；无法写入历史版本为 `SNAPSHOT_FAILED`；无法按请求处理的版本或包为 `RESTORE_REFUSED` 与 `EJECT_REFUSED`；非 Delo 写入的标记为 `SAFE_MODE_UNREADABLE`；历史无法提供的动作为 `RECOVER_REFUSED`。

<a id="not-covered"></a>

## 未覆盖的范围

- 更新本身：更新前报告、暂存、切换、健康检查以及运行时仓库的回滚属于更新与运行时仓库的工作包。本包判断 profile 是否能经受它们，并在之后带回 profile。
- home 锁。约定 C1 要求 `delorun recover` 在改动仓库期间持有 profile 的 home 锁；运行运行时切换的 CLI 命令负责这一点，而本包的恢复只触碰 profile 与 home patch。
- 客户端界面。studio 的更新界面、撤销与恢复提示以及安全模式开关渲染本包返回的计划。
- 插件审计。恢复会列出它带回的插件版本，这是约定 C13 对安装的要求；Delo 自身不运行插件审计。

<a id="development"></a>

## 开发

规格以 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/profile-safety` 运行，包以 `node_modules/.bin/tsc --noEmit -p delo/packages/profile-safety/tsconfig.json` 做类型检查。历史相关的规格会在临时目录中写入真实的 git 历史；其余规格使用临时 profile 目录，不写这些目录之外的任何内容。
