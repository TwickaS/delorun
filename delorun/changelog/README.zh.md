# Changelog

[English](README.md) | 中文

## 摘要

本文件夹是 Delorun 变更日志的唯一归处。它用使用 Delorun 的本人能够理解的语言，记录从 stock DeepSeek Harness（分叉点，上游发布版本 `dsh-v0.2.2-rc.1`）到本人正在运行的 Delorun 的完整路径。

变更日志在开发期间就是正确的，而不只是在发布时。本人能感知到的每件事对应一个片段文件，之后对同一件事的更改会编辑该文件。汇编把这些片段分批整理成小的预览子版本，所以结果读起来是寥寥几步，而不是一份 pull request 清单。

## 目录

- [文件夹](#folders)
- [片段格式](#fragment-format)
- [就地编辑](#edit-in-place)
- [变更归属](#where-a-change-belongs)
- [子版本](#sub-versions)
- [汇编写出的内容](#what-assembly-writes)
- [谁读取数据文件](#who-reads-the-data-file)
- [命令](#commands)
- [无需片段的情形](#when-no-fragment-is-needed)

<a id="folders"></a>

## 文件夹

| 文件夹 | 保存内容 |
| --- | --- |
| `unreleased/` | 现在已存在且可用、但尚未进入已汇编版本的内容所对应的片段。下一个子版本会取用它们。 |
| `pending/` | 本人尚无法触达的内容所对应的片段，例如没有任何命令或随附 profile 使用的库。每个片段在 `waits:` 行中说明必须先接通什么。它们像任何片段一样接受检查，但从不被汇编。 |
| `releases/<version>/` | 已汇编版本所取用的片段，以及 `releases/<version>.md`，即该版本的发布说明。 |

某个功能的接通工作会把它的片段从 `pending/` 移回 `unreleased/`，并删除 `waits:` 行。描述本人尚无法做到之事的片段不属于 `unreleased/`：变更日志会因此作出承诺。

<a id="fragment-format"></a>

## 片段格式

按它所描述的内容给文件命名，使用小写单词并以连字符分隔，例如 `setup.md`。文件包含带有下列字段的 front matter，然后是针对这一个功能的一行或多行项目符号：

```markdown
---
area: Commands
section: Added
---

- `delorun doctor` checks Docker, the DeepSeek API key's format, the Delorun home's permissions and whether the studio's port is free.
```

| 字段 | 是否必需 | 值 |
| --- | --- | --- |
| `area` | 是 | 下面各领域之一。领域是本人遇到该变更的地方。 |
| `section` | 是 | 下面各部分之一。一个片段只有一个部分；包含两个部分的变更的功能有两个片段。 |
| `replaces` | 否 | 较早片段（已发布或未发布）的文件名，在持续比较中，本片段的项目符号取代该片段的项目符号。 |
| `waits` | 仅限 `pending/` | 本人能触达该功能之前必须接通的内容。 |

| `area` | 适用于 |
| --- | --- |
| Install and update | 把 Delorun 装到电脑上并保持最新 |
| Setup | home、首次运行和 `delorun setup` |
| Studio | studio 显示的内容，包括其品牌 |
| Chats and workspaces | chat、文件夹、工作区以及其中运行的内容 |
| Safety and privacy | 保护措施、同意、留在本机的内容 |
| Reach | 从其他设备使用一个 home |
| Plugins | 加载、配置和约束插件 |
| Commands | `delorun` 命令 |
| Compatibility | Delorun 与 DeepSeek Harness 版本及插件的关系 |

| `section` | 适用于 |
| --- | --- |
| Added | 新功能或新选项 |
| Changed | DeepSeek Harness 中已有内容的行为不同 |
| Fixed | DeepSeek Harness 行为中修复的缺陷 |
| Security | 修复的漏洞或新增的保护 |
| Removed | 被移除的内容，以及取代它的内容 |
| From upstream | Delorun 现已包含、本人会注意到的 DeepSeek Harness 变更 |

各领域按第一张表的顺序输出。在一个领域之内，各部分按 Added、Changed、Fixed、Security、Removed 的顺序输出，所以功能的描述排在其修复和保护之前。除此之外，部分只改变一个项目符号的读法：`Security`、`Removed` 和 `Fixed` 输出加粗的前缀词，`Added` 和 `Changed` 输出普通项目符号。

写的是对本人而言发生了什么变化，而不是代码如何改变。不要使用内部名称、issue 或 pull request 编号、工作包名称或决定 ID；门禁会拒绝 `#` 后跟数字、`WP` 后跟数字，以及 `D`、`A` 或 `C` 后跟最多三位数字。每个项目符号占一个物理行。破坏性变更还要链接 `delorun/docs/upgrade-guide/` 下的升级指南。写的是本人用这个构建能做什么；描述没有任何命令、profile 或屏幕能触达的内容的项目符号，应放在 `pending/` 中。

<a id="edit-in-place"></a>

## 就地编辑

之后对同一件事的更改应编辑它的片段，而不是另加一个。对尚未随任何已汇编版本发布的功能的修复不是 `Fixed` 项目符号，因为从来没有人遇到过那个缺陷：应更正该功能的项目符号。当某个功能已经被汇编进某个版本、而它的行为又发生了变化，且较早的项目符号不再成立时，应为该变更新增一个片段，带 `replaces: <earlier fragment file name>`。较早的版本条目保留其原话，作为该版本的记录；持续比较会丢弃被取代的项目符号。

片段文件名在 `unreleased/` 和 `releases/` 之间保持唯一，所以 `replaces` 恰好指名一个片段。汇编会拒绝重复的名称，以及不指名任何片段的 `replaces`。

<a id="where-a-change-belongs"></a>

## 变更归属

写片段之前，运行 `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --list-unreleased`。它按领域输出未发布的片段，即下一个子版本将包含的内容，以及待处理的片段和它们各自在等待什么。如果已有片段描述了这件事，就编辑它。如果某个待处理片段描述的是你正在接通的内容，就在同一次变更中把它移到 `unreleased/`。

<a id="sub-versions"></a>

## 子版本

第一个发布版本之前的版本是预览子版本，即 `0.1.0-preview.N`，N 从 1 开始。当一批工作线落在本人可安装的构建上时，由负责人汇编一个，绝不针对单个 pull request。它所通往的发布版本是 `0.1.0`。汇编 `0.1.0` 会把其各预览的条目折叠成一个条目，以子标题的形式呈现，所以发布后的变更日志不会读起来像一长串预览。

预览排在其发布版本之前（`0.1.0-preview.2` 在 `0.1.0-preview.10` 之前，`0.1.0-preview.10` 在 `0.1.0` 之前）。版本的日期记录为汇编它的那一天。

<a id="what-assembly-writes"></a>

## 汇编写出的内容

汇编读取 `unreleased/` 中的片段、较早版本在 `releases/` 下取用的片段、数据文件，以及 `delorun/upstream-patches.json` 中的上游发布版本。它写出：

| 文件 | 内容 |
| --- | --- |
| `delorun/changelog/changelog.json` | 记录：持续比较和每个已汇编版本，最新的在前。 |
| 仓库根目录的 `CHANGELOG.md` | 由一个纯函数渲染成 Markdown 的相同内容，所以两者不会不一致。 |
| `delorun/changelog/releases/<version>.md` | 该版本的发布说明；当 `--advisories` 指定了报告时，还包含已接受的安全公告。 |
| `delorun/changelog/releases/<version>/` | 已取用的片段，从 `unreleased/` 移入。 |

`CHANGELOG.md` 以一个持续部分开头，即「Delorun compared with DeepSeek Harness `<upstream release>`」，每次汇编都会重新生成。它包含每个已发布和已汇编片段中仍然成立的每个项目符号，按领域分组。它是从分叉点出发的完整路径。当较晚的片段在 `replaces` 中指名某项目符号所在的文件时，该项目符号即被去除。在其下，每个版本是一个条目，最新的在前：带版本和日期的标题、按固定顺序排列的领域，以及指名该版本所基于的上游发布版本的「From upstream」块。

数据文件的格式如下：

```json
{
  "schema": "delorun.changelog/1",
  "upstream": { "ref": "dsh-v0.2.2-rc.1", "commit": "<sha>" },
  "compared": [{ "area": "Commands", "section": "Added", "text": "..." }],
  "versions": [{
    "version": "0.1.0-preview.1",
    "date": "YYYY-MM-DD",
    "preview": true,
    "areas": [{ "area": "Commands", "items": [{ "section": "Added", "text": "..." }] }],
    "fromUpstream": { "ref": "dsh-v0.2.2-rc.1", "items": [{ "area": "Compatibility", "text": "..." }] },
    "previews": []
  }]
}
```

`previews` 保存最终版本所折叠的各预览，最新的在前，每个带有其 `version`、`date`、`areas` 和 `fromUpstream` 条目；对预览以及没有预览的版本，它为空。

<a id="who-reads-the-data-file"></a>

## 谁读取数据文件

`changelog.json` 供 `delorun changelog` 命令、更新报告的「新增内容」部分、studio 中的变更日志面板，以及文档站点的变更日志页面读取。这些在本构建中都尚不存在；它们各自在构建时读取该文件。在此之前，该文件和 `CHANGELOG.md` 就是全部接口。

<a id="commands"></a>

## 命令

从仓库根目录运行它们。

| 命令 | 作用 |
| --- | --- |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --list-unreleased` | 按领域输出未发布的片段，以及待处理片段和它们各自在等待什么。 |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --dry-run --version 0.1.0-preview.1` | 输出该版本将写出的条目和说明，不写入任何内容。 |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --version 0.1.0-preview.1 [--date YYYY-MM-DD]` | 汇编该版本：写出数据文件、`CHANGELOG.md` 和说明，并移动已取用的片段。 |
| `node_modules/.bin/tsx delorun/apps/release/src/changelog/check.ts --base <rev>` | `gates:changelog` 门禁：`<rev>` 之后每个更改了产品文件的提交，都要添加一个片段或带有写明原因的尾注，并且 `unreleased/` 和 `pending/` 中的每个片段都能解析且领域有效。 |

`--first-public-release` 允许 `1.0.0`，否则它会被拒绝。`--advisories <report> --manifest <manifest>` 把已签名发布版本的已接受安全公告添加到其说明中。汇编会拒绝已被汇编的版本、已被汇编的发布版本的预览、无法解析的片段，以及没有任何内容可汇编的运行。

<a id="when-no-fragment-is-needed"></a>

## 无需片段的情形

本人无法感知的变更，在其每个提交的末尾加上一条给出原因的尾注：

```text
Changelog: none (tests only)
```

只更改 Markdown 文件、双语配对记录（`*.i18n.yaml`），或 `delorun/docs/`、`docs/`、`.agents/`、`delorun/apps/tools/`、`delorun/apps/release/`、`.github/` 或本文件夹之下文件的提交，既不需要片段，也不需要尾注。`gates:commits` 门禁会在整个范围内检查尾注的原因。
