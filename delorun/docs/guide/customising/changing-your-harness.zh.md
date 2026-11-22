---
description: "更改 Delorun 运行的内容：为什么从文件夹链接的插件运行的是保存在你的 Delorun home 中的副本，保护关闭时（默认）什么会不经审阅就加载，delorun changes 如何列出、显示、应用、丢弃和撤销更改，第二次确认，用实时重载开发插件，更改 Delorun 本身，关闭单个插件，更改使 Delorun 无法启动时会发生什么，保护设置，以及 studio 的 Changes 部分。"
---

# 修改你的 harness

[English](changing-your-harness.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

你可以更改你的 Delorun 运行的内容：你从文件夹链接的插件，以及 Delorun 自己的文件。[保护](../../reference/glossary.zh.md#changes-protection)设置决定更改是立即加载，还是等待你的审阅。

- 保护关闭时（默认），更改会不经审阅就加载并被记录。`delorun changes` 列出它、连同它的文件和差异一起显示它，并可以撤销它。
- 保护开启时，更改会等待你的审阅。你从文件夹链接的插件运行的是你批准过的副本，所以文件夹中的编辑（无论是你的还是你的 agent 的）在你应用它们之前，不会破坏任何正在运行的东西。`delorun changes` 列出等待中的更改，显示每项更改以及它能做什么的摘要，并应用、丢弃或撤销它。
- 保护开启时，在你开发插件期间，`delorun changes work` 会实时加载你的编辑，直到你完成。
- Delorun 自己的文件则在你自己的已安装发布版本的副本中更改。`delorun changes` 还可以关闭或开启单个插件，以及开启或关闭保护。
- 使 Delorun 无法启动的更改会被略去，Delorun 在没有它的情况下启动。

“设置”中 studio 的 Changes 部分在你的电脑上做同样的事。

## 目录

- [你从文件夹链接的插件](#plugins-you-link-from-a-folder)
- [查看哪些在等待审阅](#seeing-what-waits-for-review)
- [应用、丢弃与撤销](#applying-discarding-and-undoing)
- [第二次确认](#the-second-confirmation)
- [导入的 setup 中的插件代码](#plugin-code-from-an-imported-setup)
- [开发插件](#working-on-a-plugin)
- [当你的 agent 更改插件时](#when-your-agent-changes-a-plugin)
- [更改 Delorun 本身](#changing-delorun-itself)
- [关闭单个插件](#turning-one-plugin-off)
- [当更改使 Delorun 无法启动时](#when-a-change-stops-delorun-from-starting)
- [保护设置](#the-protection-setting)
- [在 studio 中](#in-the-studio)

<a id="plugins-you-link-from-a-folder"></a>

## 你从文件夹链接的插件

当你用 `delorun plugin --profile default add link:<folder>` 添加插件时，Delorun 会在你的 Delorun home 中保留该文件夹内容的一份副本，并运行这份副本，而不是该文件夹。

保护关闭时（默认），Delorun 在每次启动时再次复制该文件夹，并且在 Delorun 运行期间，每次你保存其中的文件时也会复制：新内容立即加载，并被记录为一项更改。启动时会打印 `<plugin> loaded changes without review, because protection is off: delorun changes show <id>`，`delorun plugin --profile default add link:<folder>` 也会如此。如果你保存的内容无法加载，Delorun 会回到之前运行的内容，并且在你保存别的内容之前不会再次尝试；`delorun changes list` 会显示错误。`delorun changes undo <id>` 撤回一项更改，你撤销的内容在文件夹中有别的内容之前不会再次加载。

保护开启时，文件夹中的编辑会在 `delorun changes list` 中显示为等待你审阅的更改。在你应用它之前，Delorun 运行的是你批准过的副本；你链接了但从未批准的插件则根本不运行。Delorun 运行期间也是如此：`delorun plugin --profile default add link:<folder>` 会打印 `<plugin> is not loaded until you review it: delorun changes show <id>`，无论是这条命令，还是在 studio 中恢复或撤销你的插件的某个早期版本，都不会从该文件夹加载任何东西。

副本包括该插件所链接的已安装的包，例如 pnpm 工作区中的那些包，所以对其中之一的更改，在它成为你应用过的更改的一部分之前，不是正在运行的内容。连同这些包在内，一份副本最多包含 50,000 个文件和 512 MiB。比这更大的插件会继续运行你批准过的副本，或者不运行，并且每次启动都会说明原因；保护关闭时，只有连同其已安装的包才超出限制的插件会运行，并从这些包的安装位置加载它们，每次启动都会这样说明。Delorun 无法读取的文件夹（例如一直在变化的文件夹）从不会阻止 Delorun 启动：插件运行的是你批准过的副本，启动时会指出它。

在 Delorun 运行期间重新加载它的插件之前，它会检查每个插件的副本是否就是 Changes 所保留的那份；如果不是，它不会重新加载，正在运行的内容继续运行。

<a id="seeing-what-waits-for-review"></a>

## 查看哪些在等待审阅

| 命令 | 打印 |
| --- | --- |
| `delorun changes` 或 `delorun changes list` | 首先是等待你审阅的更改，然后是你最近的更改（最新的在前）、保护设置，以及 Delorun 正在开发的插件（如果有的话） |
| `delorun changes show <id>` | 一项更改：插件、它的文件夹、它的文件（其依赖项的文件归为一组）以及该更改能做什么 |
| `delorun changes show <id> --diff` | 同上，带有差异；非常大的差异会被截断，命令会指出它略去的文件 |
| `--json` | 对 `list` 和 `show`，以 JSON 格式输出同样的内容 |
| `--profile <name>` | 另一个 CLI profile 的更改 |

一项更改的 id（例如 `c3f09a1b2c4`）准确指代所显示的内容。如果文件夹在你查看之后发生变化，该 id 就不再适用，`delorun changes list` 会显示新的 id。

<a id="applying-discarding-and-undoing"></a>

## 应用、丢弃与撤销

| 命令 | 发生什么 |
| --- | --- |
| `delorun changes apply <id>` | 逐页显示该更改的差异，然后询问；插件运行的正是你审阅过的内容。 |
| `delorun changes discard <id>` | 该更改永远不会运行，并且在文件夹含有那份内容期间不再被列出。你的文件夹保持原样。 |
| `delorun changes undo <id>` | 撤回已应用的更改：插件运行它之前运行的内容，或在撤销其安装之后什么都不运行，即停止它而不移除它：撤销时会打印 `delorun plugin remove <name>` 用于移除。 |

其中每一条命令都只在终端中运行，打印它将要做什么并要求你确认；除 `y` 或 `yes` 之外的任何回答都不会改变任何东西。`apply` 在询问之前打印差异：按 Enter 看下一页，按 `a` 看其余部分。包含控制字符的名称、行和消息，会把这些字符写成 `\uXXXX` 打印出来，所以文件无法改变你的终端所显示的内容。当输入或输出被重定向时，命令会以 “This needs you at your computer: run it in a terminal.” 拒绝。

当 Delorun 正在运行时，更改立即生效。如果插件随后无法加载，Delorun 会回到之前运行的内容、打印错误，并且该更改带着那个错误再次等待你的审阅。当 Delorun 没有运行时，下一次启动会运行该更改。每项被应用或被撤销的更改，同时也是你的 profile 历史的一个版本，`delorun recover` 可以恢复它。

<a id="the-second-confirmation"></a>

## 第二次确认

在你应用更改之前，Delorun 会打印该更改能做什么的摘要：更改同意、防护或沙箱策略；添加模型可以调用的工具；运行命令；打开网络连接；读取你的 Delorun home 下的文件；或添加依赖项或安装或构建脚本。它还会指出差异没有显示的内容：Node 可以加载的非文本文件、对于差异来说太大或超出其被截断位置的文件，以及位于插件文件夹内的包的文件。当检查标记了该更改时，`apply` 会再问一次，并指出它们发现了什么，包括差异没有显示的每个文件。

摘要帮助你阅读更改；它不是一种保护。插件的代码可以做 Delorun 能做的任何事。

<a id="plugin-code-from-an-imported-setup"></a>

## 导入的 setup 中的插件代码

`delorun setup import`（[迁移你的 setup](move-your-setup.zh.md)）会把在另一台电脑上编写的插件的文件写入你 home 中 `archive/setup-plugins/` 下的文件夹，并从该处链接插件，因此上面的规则同样适用：保护开启时，它的代码在 `delorun changes list` 中等待，直到你应用；保护关闭时，它在下一次启动时加载，并被记录为一个未经审阅的变更。

<a id="working-on-a-plugin"></a>

## 开发插件

保护关闭时，你保存的编辑已经实时加载，无需开发会话。保护开启时，在编写插件期间审阅每一次编辑会碍事：`delorun changes work <plugin>` 会要求你确认，然后加载插件文件夹现在含有的内容以及你之后保存的每次编辑，不经审阅，直到你结束开发会话或会话时间用完：两小时，或你用 `--for` 给出的分钟数，最多 480。它会打印 “Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>, at the latest until <time>.” Delorun 必须正在运行，并且一个 profile 一次只能开发一个插件；会话持续期间，`delorun status`、`delorun changes list` 和 `delorun doctor` 都会指出它。

如果某次编辑无法加载，Delorun 会回到插件最后一个成功加载的版本并继续运行它。会话保持打开，所以你的下一次编辑会再次加载；在某个版本加载成功之前，`delorun doctor` 会显示该错误。

`delorun changes done <plugin>` 把文件夹现在含有的内容显示为一个版本（例如 `3f9a2c1`），连同它的文件、它能做什么的摘要以及与你之前批准的版本的差异，并要求你批准该版本。正是那个版本成为已批准的版本，你在会话期间所做的一切更改合为一项更改，可以像其他任何更改一样用 `delorun changes undo <id>` 撤销。如果文件夹在问题等待期间发生变化，则不会批准任何东西，会话保持打开；请再次运行 `done` 查看它现在含有什么。如果该版本无法加载，也不会批准任何东西。

没有你参与就结束的会话不会批准任何东西：包括 Delorun 停止时、下次启动发现 Delorun 遗留的打开会话时，以及会话时间用完时。此时你的插件运行的是你在会话之前批准的版本，而文件夹现在的内容会像其他任何编辑一样在 `delorun changes list` 中等待你的审阅，或者在保护关闭时于下次启动时加载。

`delorun plugin dev <folder>`（见[为 Delorun 编写插件](../plugin-guides/plugins.zh.md#run-it-while-you-work-on-it)）也遵循这些规则。保护关闭时，它构建的每次编辑都会实时加载。保护开启时，编辑和文件夹中的其他编辑一样等待你的审阅，在你应用它或启动 `delorun changes work <plugin>` 之前，`delorun plugin dev` 不会从该文件夹加载任何内容。

这两条命令都只在你电脑上的终端中运行；studio 的 Changes 部分在该电脑上的浏览器中做同样的事（见[在 studio 中](#in-the-studio)）。手机只有在用 [Face ID](../everyday-use/reach.zh.md#confirm-with-face-id) 或你的 PIN 确认那一个操作之后，才能开始或结束开发会话。你的 agent 不能开始或结束开发会话。

<a id="when-your-agent-changes-a-plugin"></a>

## 当你的 agent 更改插件时

保护关闭时，agent 对插件文件夹的写入不会询问：它写入的内容像你自己的编辑一样加载并被记录。它安装、更新或移除插件的请求与在 DeepSeek Harness 中一样运行，仅需完全访问批准，它从文件夹安装的插件不经审阅就加载并被记录。

保护开启时，agent 在 chat 中第一次写入你批准过的插件的文件夹时，chat 会先询问你，指出该插件并显示差异，因为 agent 在更改你的 harness 所运行的内容。你一旦允许，agent 在同一个 chat 中对该插件的其他写入就会继续进行；另一个 chat 则会再次询问。它写入的内容与你自己的编辑一样，是 `delorun changes list` 中的一项更改，只有在你应用它之后才运行，或在你开发该插件期间立即运行。

保护开启时，当 agent 请求安装、更新或移除插件，不会安装或移除任何东西。该请求在 `delorun changes list` 中等待，被标记为在 chat 中提出的，并且 agent 会被告知它在等你。`delorun changes show <id>` 说明应用它会做什么；`delorun changes apply <id>`（或 studio 中的 Apply）像 `delorun plugin` 添加或移除插件那样运行它，`discard` 则放弃它。来自文件夹的插件在添加时不加载任何东西：它的内容是第二项更改，你像其他任何更改一样审阅并应用它。agent 不能开启或关闭插件、更改它们的设置，或带回你的插件的早期版本；它被告知这些由你自己来做。

<a id="changing-delorun-itself"></a>

## 更改 Delorun 本身

`delorun changes edit-harness` 在你的 Delorun home 的 `changes/harness/` 下制作你自己的已安装 Delorun 程序文件的副本，并打印它的文件夹。你在那里保存、添加或删除的每个文件，都是对 Delorun 本身的一项更改，由 `delorun changes list` 列出。保护关闭时，下一次 `delorun start` 会不经审阅就应用每一项这样的更改，并打印 `Delorun itself (<file>) changed without review, because protection is off: delorun changes show <id>`；`delorun changes undo <id>` 撤回其中一项。保护开启时，每一项都等待你的审阅：你用与插件更改相同的命令应用、丢弃和撤销它，已应用的更改从 Delorun 下次启动时开始运行。已安装的发布版本本身从不被编辑：Delorun 一如既往地检查它，并带着你所应用的更改运行它。

| 命令 | 发生什么 |
| --- | --- |
| `delorun changes edit-harness` | 制作你的副本并打印它的文件夹；当副本已存在时，打印文件夹且不改变任何东西。 |
| `delorun changes apply <id>` | 显示该更改并询问；Delorun 从下次启动时起运行你保存的那个文件。 |
| `delorun changes discard <id>` | 你的副本取回 Delorun 所运行的文件。 |
| `delorun changes undo <id>` | Delorun 从下次启动时起像以前一样运行该文件。 |
| `delorun changes edit-harness --discard` | 询问，然后撤回对 Delorun 本身的每一项更改并移除你的副本；下一次启动原样运行已安装的发布版本。 |

这些命令只在终端中运行，并且只在已安装的 Delorun 中运行，不在源码检出中运行。studio 的 Changes 部分在你的电脑上应用、撤销和丢弃同样的更改，其中的 Make my copy 制作你的副本。手机对丢弃、应用或撤销一项更改，以及制作你的副本，都要分别用 [Face ID](../everyday-use/reach.zh.md#confirm-with-face-id) 或你的 PIN 确认，除非 Face ID 通行期（pass）已开启。当 Delorun 在你对它应用一项更改之后立即无法启动时，包括更改的文件在 Delorun 启动之前就使其停止时，它会在没有你对它的最新更改的情况下再启动一次，对插件也是如此。当没有那项更改它也不能启动时，它会为你最新应用的更改指出 `delorun changes undo <id>`，并指出 `delorun changes edit-harness --discard`，后者撤回对 Delorun 本身的每一项更改。安全模式 `delorun recover safe-mode` 运行已安装的发布版本，不带你对它的任何更改，直到你离开安全模式。`delorun verify` 和 `delorun doctor` 列出你更改过的文件。你的更改属于已安装的版本：更新之后，更新报告会说明每一项如何延续。

你的 agent 可以替你编辑你的副本。在拥有完全访问的 chat 中，`delorun-harness-copy` 技能把它指向你的 Delorun 副本，它只在那里起作用。它从不应用、撤销或丢弃更改，也从不更改保护：这些决定始终由你作出。

<a id="turning-one-plugin-off"></a>

## 关闭单个插件

`delorun changes off <plugin>` 停止一个插件而不触动其他插件，`delorun changes on <plugin>` 再次运行它。两者都会先询问，并且都是可以用 `delorun changes undo <id>` 撤销的更改。Delorun 自己的插件始终保持开启；要在没有其他所有插件的情况下启动，请使用 `delorun recover safe-mode`。

<a id="when-a-change-stops-delorun-from-starting"></a>

## 当更改使 Delorun 无法启动时

当 Delorun 在你对插件应用了一项更改，或开启了一个插件之后立即无法启动时，它会在没有该更改的情况下再启动一次，并告诉你是哪一项：

```text
Delorun did not start with your latest change to my-plugin (c1a2b3c4d5e): SyntaxError: Unexpected token.
It starts without it now; your files are unchanged.
To try it again: delorun changes apply c1a2b3c4d5e. To undo it: delorun changes undo c1a2b3c4d5e.
```

插件运行的是它在该更改之前运行的版本，或者在该更改是添加或开启它时不运行。在你再次应用该更改或撤销它之前，每次启动都会这样说明，`delorun changes list` 和 `delorun doctor` 也会如此。Delorun 只略去那一项更改，也不改写你的任何文件。当没有它 Delorun 也不能启动时，它会停止并说明：“Delorun did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start.”

<a id="the-protection-setting"></a>

## 保护设置

| 设置 | 更改会怎样 |
| --- | --- |
| `off`（默认） | 它不经审阅就加载：插件的文件夹在每次启动时，以及 Delorun 运行期间每次你保存时；你的 Delorun 本身的副本则在下次启动时。每项更改都列在 `delorun changes list` 中，由 `delorun verify` 和 `delorun doctor` 指出，并且可以撤销。你的 agent 安装和移除插件的方式与在 DeepSeek Harness 中相同。 |
| `on` | 它等待你的审阅，只有在你应用之后才加载；你从未批准的插件不运行。你的 agent 在 chat 中第一次更改已批准的插件之前会先询问，它安装和移除插件的请求则等待你。 |

保护关闭时，任何能写入已链接插件文件夹的东西，都可以在你看到之前改变 Delorun 运行的内容：以完全访问工作的 agent、你下载的程序、任何以你的身份运行的程序。受限工作区中的命令只在沙箱允许的地方写入：该工作区内的插件文件夹，绝不是你的 Delorun home，所以它们无法改变你的 Delorun 本身的副本。当你想先审阅每一项更改时，请开启保护。

`delorun changes protection` 打印该设置及其含义。`delorun changes protection on` 或 `off` 在你电脑上的终端中更改它，studio 的 Changes 部分在你的电脑上更改它。手机可以不经提示就把它打开，只有在用 [Face ID](../everyday-use/reach.zh.md#confirm-with-face-id) 或你的 PIN 确认之后才能把它关闭。每种方式都会说明新设置的含义，例如 `off` 对应 “Changes will load without your review.”，并要求你确认；新设置立即生效，无需重启。完整的 setup 也会提供开启保护的选项。

关闭保护时会再问一次，并说明届时哪些内容会不经审阅就加载：等待中的更改会立即加载的插件，以及会在下次启动时应用的你 Delorun 副本中的文件。第二个问题能挡住一次手滑。它挡不住在你电脑前的人，因为他们也能回答它。

当手机更改该设置时，你的电脑会保留一条通知。studio 会显示它，`delorun changes list` 会把它打印在 “Changed from a phone:” 下，并在它打印到终端之后清除它。

<a id="in-the-studio"></a>

## 在 studio 中

“设置”中有一个 Changes 部分，显示 `delorun changes list` 所显示的内容：你正在开发的插件、失败的启动所略去的更改及其错误、等待你审阅的更改及其文件夹、文件数量和检查发现的内容、你的 agent 的插件请求、你最近的更改、你对 Delorun 本身的更改及其差异，还有保护设置；保护关闭时，它会说明更改不经你的审阅就加载，并且已链接的插件在你每次保存时实时重新加载。

| 操作 | 发生什么 |
| --- | --- |
| Review | 打开更改，显示它的文件夹、标记为新增、更改或移除的文件、它能做什么、差异没有显示的文件，以及差异。 |
| 审阅中的 Apply | 插件运行你审阅过的内容。当检查标记了该更改时，studio 会再问一次，并指出它们发现了什么以及差异没有显示的每个文件。 |
| 审阅中的 Discard | 该更改永远不会运行；你的文件夹保持原样。 |
| Undo、Apply again | 先询问，然后撤回已应用的更改，或再次加载失败的启动所略去的更改。 |
| Start working | 先询问，然后实时加载插件的编辑，持续两小时。会话持续期间，侧边栏底部的徽章会指出该插件。 |
| Done | 显示你的文件夹的版本（例如 `3f9a2c1`）及其差异，并批准正是那个版本；被标记的版本会再问一次。 |
| Make my copy | 制作你的 Delorun 副本，或找到你已有的副本，并显示它的文件夹。 |
| 对 Delorun 本身的更改：Review，然后 Apply | 打开在你副本中等待的更改，显示其差异和该文件的版本（例如 `9c41e07`），并应用正是那个版本。如果你打开之后文件又改了，就什么也不应用，studio 会请你再看一次。之后该行会说明这项更改是现在运行还是重启后运行。 |
| 对 Delorun 本身的更改：Discard | 先询问；你副本中的该文件恢复为已安装发布版本中的文件。 |
| Restart now | 当对 Delorun 本身的更改要在重启后运行时显示。它会说明哪些对话正在运行：Delorun 等它们结束，期间不开始新的回合，或者由你停止它们。几秒后页面会自行重新连接。如果 Delorun 无法带着你的更改启动，它会照旧运行，略过最新的那项更改并说明这一点，同时提供撤销。没有用 `delorun start` 启动时，这些更改改为在下次启动时运行。 |
| 保护开关 | 打开时询问一次，并说明关闭期间有多少更改未经审阅就加载了。关闭时询问一次，并列出关闭后会未经审阅就加载的内容。 |

agent 安装、更新或移除插件的请求，可以在第二次确认（说明 Delorun 在运行之前无法显示它安装什么）之后被应用，或被丢弃。studio 还会应用、撤销和丢弃对 Delorun 本身的更改，制作你的 Delorun 副本，以及打开或关闭保护，关闭时有上面所说的第二个问题。每个结果都会在窗口底部短暂显示，包括更改加载失败而 Delorun 回到之前运行的内容时的错误。

在你的电脑上，每个操作都可用。在手机上，该部分显示所有内容。开启保护不需要提示，其他每个操作每次都要求 [Face ID](../everyday-use/reach.zh.md#confirm-with-face-id) 或你的 PIN，除非 Face ID 通行期已开启。在手机上打开 Changes 页面从不会询问。手机不能使用的按钮会变灰，指向它时显示 “Needs your computer”。当手机更改了保护时，你电脑的 Changes 部分会显示一条带有该手机名称和时间的通知，直到你将其关闭。
