---
description: "约定 C22：Delorun 版本对插件作出的承诺：该承诺涵盖的接口及其清单，补丁、次版本和主版本发布各可以更改什么，次版本之内固定的上游基线，1.0 之前的版本如何解读，插件如何用 engines.delorun 以 Delorun 为目标，以及发布工具的补丁规则。"
---

# C22 Delorun 版本对插件的承诺

[English](c22-delorun-plugin-interface.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

插件运行在两条版本轴上（[C17](c17-plugin-versions.zh.md)）：上游的 `engines.dsh` 和 Delorun 的 `engines.delorun`。两条轴相互独立；一条轴上的范围从不代替另一条。本页说明 Delorun 的版本对声明了 `engines.delorun` 的插件作出哪些承诺：承诺涵盖哪些接口，各类发布可以更改什么，次版本发布保持同一个上游基线，以及 1.0 之前的版本如何解读。对于会破坏该承诺的补丁发布，发布工具在能够机械检查的范围内拒绝。`delorun plugin check <directory>` 向作者展示其范围允许什么。清单的类型位于 [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md)。

<a id="status"></a>

## 状态

清单、补丁规则和 `delorun plugin check` 均已构建；没有任何发布工作流运行应用该规则的签名命令。

- **已构建并已使用：** 清单 `plugin-interface.json`，以及在源码声明了清单未列出的接口时失败的规格；位于 `delorun/apps/release/src/` 下的签名命令中的补丁规则，由人手动运行（[C2](c02-release-manifest.zh.md#status)）；以及 `delorun plugin check`。
- **尚未构建：** 发布工作流，因此该规则只在有人为发布签名时才应用（[发布工作流设计](../design/release-workflow.zh.md)）。

## 目录

- [状态](#status)
- [涵盖的接口](#covered-interfaces)
- [各类发布可以更改什么](#what-each-release-may-change)
- [1.0 之前的版本](#versions-before-10)
- [以 Delorun 为目标](#targeting-delorun)
- [检查插件](#checking-a-plugin)
- [补丁规则](#the-patch-rule)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="covered-interfaces"></a>

## 涵盖的接口

该承诺涵盖清单 `delorun/packages/contract-plugin-versions/plugin-interface.json`（schema `delorun.plugin-interface/1`）中 `covered` 之下的条目，不涵盖其他任何内容：

| 种类 | 涵盖的内容 | 声明位置 |
| --- | --- | --- |
| `service` | 浏览器中的 Cordis 服务 `delorunStudio` 和 `delorunOnboarding`，以及 `delorunWorkspaces` 和 `delorunChatStates`：它们的名称，以及声明它们所用类型的成员 | 指名的源文件中的 `interface Context` 成员 |
| `event` | 无：Delorun 没有为第三方插件记录任何事件，因此它声明的每个事件都是 `internal` | 指名的源文件中的 `interface Events` 成员 |
| `manifest-field` | `engines.delorun` 及其评估（[C17](c17-plugin-versions.zh.md#evaluation)） | 上游的 `plugin-compatibility.ts` 加上 Delorun 的编辑 |

`service` 或 `event` 条目写明成员、其源文件及其一侧：`host` 或 `browser`（位于 `client/` 目录下的源文件）。`delorun/packages/*/src` 或 `delorun/apps/*/src` 下 `.ts`、`.tsx` 或 `.d.ts` 文件中 `declare module '@deepseek-ai/cordis'` 里声明的其他每个服务和每个事件，都列在 `internal` 之下：Delorun 自己的代码使用它，而使用它的插件得不到任何承诺。上游的接口属于上游轴。Delorun 在 home 之下的文件、它的配置行和它的 Connection 路由不是插件接口。

当某个 Delorun 包或应用声明了清单未列出的服务或事件，或者清单列出了已不再被声明的服务或事件时，发布工具的一个规格会失败。

<a id="what-each-release-may-change"></a>

## 各类发布可以更改什么

| 发布 | 涵盖的接口 | 上游基线（`dsh`） | 数据格式 |
| --- | --- | --- | --- |
| 补丁，`x.y.z` 到 `x.y.z+1` | 不变：不增加、不移除、不更改任何内容 | 不变 | 不变 |
| 次版本，`x.y` 到 `x.y+1` | 可以增加；从 1.0 起，不得移除或不兼容地更改任何一个 | 可以移动 | 可以更改；更新报告会写明（[C3](c03-update-report.zh.md#data-formats)） |
| 主版本，`x` 到 `x+1` | 可以移除或更改任何一个 | 可以移动 | 可以更改 |

只要可以做成补丁，安全修复就是补丁，因此它不会在任何一条轴上关闭任何插件。无法保持基线或涵盖接口的修复作为次版本发布，并且更新提示会说明它将关闭多少个插件（[设计](../design/update-notice.zh.md)）。

<a id="versions-before-10"></a>

## 1.0 之前的版本

在 1.0 之前，次版本发布 `0.y` 到 `0.y+1` 被当作主版本来解读：它可以移除或更改涵盖的接口。补丁 `0.y.z` 到 `0.y.z+1` 保持上述承诺。以 `^` 写成的范围，例如 `^0.1.0`，允许 `>=0.1.0 <0.2.0`，也就是恰好一个次版本及其补丁。像 `0.2.0-rc.1` 这样的预发布版本参与范围匹配（[C17](c17-plugin-versions.zh.md#the-two-versions)），并且除其自身版本之外不对插件作出任何承诺。

<a id="targeting-delorun"></a>

## 以 Delorun 为目标

使用涵盖接口的插件声明 `engines.delorun`：

- 在 1.0 之前，为 `^0.<minor>.0`，即它所测试的次版本及其补丁。
- 从 1.0 起，为 `^<major>.<minor>.0`，即它所需要的次版本以及该主版本的每个后续次版本。

它还为所使用的上游接口声明 `engines.dsh`，因为之后的 Delorun 次版本可能移动上游基线。不使用任何涵盖接口的插件不声明 `engines.delorun`，可以在任何 Delorun 上运行，就像在 stock DSH 上一样。

<a id="checking-a-plugin"></a>

## 检查插件

`delorun plugin check <directory>` 将该目录的 `package.json` 当作 JSON 读取，最多 1 MiB，并且不运行插件的任何文件。它拒绝作为符号链接、FIFO 或任何非普通文件的 `package.json`，不跟随也不等待它，并在打印清单的字符串时转义终端控制字符。它用上游的 `evaluatePluginCompatibility`（安装程序和启动预检运行的评估）对照运行中的发布评估两条轴，不应用任何豁免，并打印：

- 插件的名称和版本，以及运行中的 Delorun 和 DSH 版本；
- 对于上游轴，`engines.dsh` 及其是否允许运行中的 DSH，或者每个 `@deepseek-ai/dsh*` peer 范围及其是否允许，或者什么都未声明；
- 对于 Delorun 轴，`engines.delorun` 及其是否允许运行中的 Delorun，或者什么都未声明以及以运行中次版本为目标的范围；
- 安装程序是否在此发布上接纳该插件，以及在不接纳时它的拒绝消息。

当安装程序接纳该插件时它以 0 退出，当它拒绝该插件或无法读取其声明时以 1 退出。

With `--json` it prints one JSON object on one line, and no other output, for tools that must not read English text. Its fields, all always present:

| Field | Meaning |
| --- | --- |
| `decidedBy` | `delorun` when `engines.delorun` is declared, else `dsh` when `engines.dsh` is, else `peer` when a `@deepseek-ai/dsh*` peer is, else `none`. |
| `range` | The range that decided, as written; `null` for `none`. |
| `checkedAgainst` | The version the range was checked against; `null` for `none`. |
| `verdict` | `admitted` or `refused`. |
| `readable` | `false` when a declaration is in a form Delorun cannot read. |

The exit code is the same as without `--json`. The record is the return value of `decidePluginVersion` in `@delorun/update`, a pure function of a parsed manifest, a Delorun version and a DSH version.

<a id="the-patch-rule"></a>

## 补丁规则

当存在更早的发布标签 `vx.y.w`（`w` 小于 `z` 且不是预发布）时，若该标签的提交与本发布的提交之间有下列任一项不同，签名就拒绝发布 `x.y.z`（[C2](c02-release-manifest.zh.md)）：

- 上游版本，即 `packages/boot/app-boot/package.json` 的 `version`，它还必须等于草稿的 `dsh`；
- 数据格式：`docs/persistence-schema.json` 和 `delorun/packages/update/src/data-records.json`；
- 清单的 `covered` 列表，或者发布提交不再声明的涵盖服务或事件，或不再读取的涵盖 manifest 字段。

`x.y.0` 发布不是补丁，不作比较。某个次版本尚无更早发布被打标签的补丁版本会被拒绝，除非签名者传入 `--first-of-line`，并且更早的标签必须位于发布提交的历史上，且与 `delorun/changelog/changelog.json` 在发布提交处记录的版本一致（[C2](c02-release-manifest.zh.md)），因此没有已发布标签的检出不会跳过该规则。

<a id="consumers"></a>

## 消费方

- `delorun/apps/release`：签名时的补丁规则，以及清单的规格。
- `delorun/apps/cli`：`delorun plugin check`。
- 插件作者，通过本页和该命令。

<a id="compatibility"></a>

## 兼容性

清单的 `schema` 写明其主版本。把条目从 `internal` 移到 `covered` 是次版本发布的更改；把条目从 `covered` 移到 `internal` 会把它移出承诺，从 1.0 起这需要主版本发布。

<a id="security"></a>

## 安全

### 要求

- R1. `delorun plugin check` 从不导入、require 或运行它所检查的插件的任何文件。
- R2. 补丁发布从不移动上游基线、更改数据格式或更改涵盖的清单，并且缺少更早的发布标签从不跳过这项检查。

### 拒绝测试

| 测试 | 组件 | 所示行为 |
| --- | --- | --- |
| `plugin-check-imports-no-code` | update-notice | 入口文件和安装脚本会写入 canary 的插件，在检查之后不留下 canary。 |
| `patch-rule-refuses-base-move` | update-notice | 上游版本与更早发布不同的补丁拒绝签名。 |
| `patch-rule-refuses-draft-base-mismatch` | update-notice | 其 `dsh` 与发布提交的上游版本不同的草稿拒绝签名。 |
| `patch-rule-refuses-persistence-change`, `patch-rule-refuses-delorun-record-change` | update-notice | 数据格式不同的补丁拒绝签名。 |
| `patch-rule-refuses-interface-removal`, `patch-rule-refuses-interface-addition` | update-notice | 涵盖的清单不同的补丁拒绝签名。 |
| `patch-rule-refuses-missing-inventory` | update-notice | 更早发布没有清单的补丁拒绝签名。 |
| `patch-rule-refuses-patch-without-earlier-release` | update-notice | 其次版本没有更早发布的补丁版本，在没有 `--first-of-line` 时拒绝签名。 |
| `patch-rule-refuses-tag-on-wrong-commit`, `patch-rule-refuses-release-missing-from-changelog` | update-notice | 不在发布提交历史上的更早发布标签，或与已提交的 changelog 不一致的标签，拒绝签名。 |

### 本约定不能证明的内容

- 该规则比较名称；它不比较声明的文本。对每个涵盖声明的文本计算哈希，可以捕获被更改的成员类型，这是该规则的下一步。补丁之内被更改的类型或行为只能由评审捕获。
- 该规则根据仓库的标签找到更早的发布，并对照 git 的历史和已提交的 changelog 检查。该 changelog 记录的是版本而不是提交，因此被移到另一个祖先提交的标签可以通过（[C2](c02-release-manifest.zh.md#what-this-does-not-prove)）。
