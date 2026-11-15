---
description: "从 stock DeepSeek Harness 切换到 Delorun：delorun import-home 和 setup 会从 ~/.dsh 复制什么，哪些由你逐项选择，哪些被保留不动或留在原处及原因，预览与试运行，你的密钥，之后要安装的插件，以及如何切换回去。"
---

# 从 DeepSeek Harness 切换

[English](switching.md) | 中文

## 摘要

本页帮助你从 stock DeepSeek Harness 迁移到 Delorun，而不丢失你的 chat。stock DeepSeek Harness 把你的 [chat](../reference/glossary.zh.md#chat)、[工作区](../reference/glossary.zh.md#workspace)、[profile](../reference/glossary.zh.md#profile) 和设置保存在名为 `~/.dsh` 的文件夹中。Delorun 保有自己的 [home](../reference/glossary.zh.md#home)，即 `~/.delorun`，并把你选择的内容从 `~/.dsh` 复制进去。复制只读取 `~/.dsh`，其中的任何内容都不会改变，所以 stock DeepSeek Harness 会和以前完全一样地继续工作，你随时可以切换回去。

你需要先安装 Delorun（见[安装与首次运行](install.zh.md)），并且为了复制密钥或安装插件，需要一个终端。

## 目录

- [导入你的 home](#import-your-home)
- [会带过来什么](#what-carries-over)
- [哪些被保留不动](#what-is-held-back)
- [留在原处的工作区和 chat](#workspaces-and-chats-that-stay-behind)
- [哪些留在原处](#what-stays-behind)
- [来自 DeepSeek 网站的 chat](#chats-from-the-deepseek-website)
- [导入之后的插件](#plugins-after-the-import)
- [已经有 chat 的 home](#a-home-that-already-has-chats)
- [切换之后有什么变化](#what-changes-when-you-switch)
- [Ask less (like DeepSeek Harness)](#ask-less-like-deepseek-harness)
- [切换回去](#going-back)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="import-your-home"></a>

## 导入你的 home

当 `~/.dsh` 是文件夹而不是链接，并且你的 Delorun home 还没有任何 chat 时，第一次 `delorun setup` 会问：“Copy your DeepSeek Harness chats, attachments and workspace list? They are only read, and nothing in them changes.”它会先显示将要复制什么，答案默认为“否”，在你回答“是”之前不会复制任何东西。setup 只复制你的 chat、附件和工作区列表。

想复制其余内容，请自己运行导入：

```text
delorun import-home --dry-run      # show what would be copied, write nothing
delorun import-home                # show it, ask, then copy
delorun import-home --from /path/to/another/dsh-home
delorun import-home --profile work  # import into the CLI profile work
```

导入会在复制任何东西之前先询问，所以它需要一个终端；没有终端时，不会导入任何东西。

`delorun import-home` 首先询问你的 chat、附件和工作区列表。然后它会分别询问下面每一项，只有你回答“是”才会复制：你的 profile、你的设置、你的 `AGENTS.md` 指令、你的 skill 和你的 DeepSeek 密钥。其中每一项都可能改变 Delorun 运行什么或 agent 被告知什么，所以导入在询问之前会先展示它：将要落地的确切设置，以及你的指令的前几行。

导入之前请先停止 DeepSeek Harness 和 Delorun。如果 `~/.dsh` 中的某个文件在导入复制它的过程中发生变化，导入会停止，你的 Delorun home 保持原样。如果你的电脑在导入过程中停机，Delorun 下次启动时会删除它已复制的那一部分。

<a id="what-carries-over"></a>

## 会带过来什么

- **chat。**每个 chat 及其每一个已保存的版本，原样复制。Delorun 打开它们的方式与 DeepSeek Harness 相同。较旧的 DeepSeek Harness 以未压缩形式存储的 chat 会留在原处。
- **工作区。**你的工作区列表，所以你的 chat 会出现在相同的文件夹下。
- **附件。**你的 chat 所引用的图片和文件。
- **profile，在你同意时。**每个 profile 保留它的名称、插件列表和普通设置。Delorun 会把自己的 bundle `@delorun/bundle-local` 添加到每个 profile，以便应用 Delorun 的隐私默认值；该 profile 首次启动时还会添加 `@delorun/bundle-studio`，即 Delorun 的 studio 附加功能。用 `delorun --profile <name>` 启动其中一个。如果某个 stock profile 与你的 Delorun home 已有的 profile 同名（例如 `default`），它会留在原处，因为导入从不替换已有的 profile。
- **设置，在你同意时。**你的 home 补丁 `cordis.patch.yml` 和较旧的 `settings.yaml` 设置，前提是你的 Delorun home 没有自己的这些文件。
- **指令和 skill，在你同意时。**你的 `AGENTS.md` 和你的 skill。每个 chat 都会读取这些指令，而 skill 可以告诉 agent 该做什么，所以在回答“是”之前请先阅读它们。
- **你的 DeepSeek 密钥，在你同意时。**导入会按名称列出你存储的密钥，从不显示其值，并且只提供 DeepSeek 密钥，把它复制到 Delorun 的凭据文件中，该文件只有你能读取。其他密钥请在 Delorun 中重新添加。

在 DeepSeek Harness 中以完全访问运行的 chat，在 Delorun 中会以更安全的预设 Workspace Write 打开，直到你在 Delorun 中为它的工作区开启完全访问：在 chat 中选择 Full access，在请求它的批准卡片上选择“Allow for this chat”，或使用“设置”→“安全”→“权限”，或 `delorun workspace full-access <folder> on`。

导入从不运行 `~/.dsh` 中的任何东西。

<a id="what-is-held-back"></a>

## 哪些被保留不动

只有改变 Delorun 的外观以及它默认使用哪个模型的设置会被带过来：你的主题和字体、chat 和输入框的显示方式、你的语言，以及你的默认模型名称。你的设置和 profile 补丁中的其他一切都被保留不动，即使你对设置或 profile 回答了“是”，因为设置可能运行代码、把你的请求或密钥发往另一个地址，或关闭某项保护。预览会列出每一项被保留的设置及原因，导入会把它们写入 `~/.delorun/archive/stock-import/` 下一个没有任何东西读取的文件。请自己把你信任的内容从那里复制到你自己的设置中。

通过路径、链接、git 地址或 URL 安装的 profile 插件不会被带过来；如果你信任它，请自己重新添加。导入也不会带过来 profile 的锁文件、版本豁免以及它批准过的安装脚本。

<a id="workspaces-and-chats-that-stay-behind"></a>

## 留在原处的工作区和 chat

预览会列出每个工作区及其文件夹。位于存放着你的设置和密钥的文件夹中的工作区，会连同它的 chat 一起留在原处：磁盘根目录、你的用户主目录本身、其中的隐藏文件夹（例如 `.ssh` 或 `.config`），以及 DeepSeek Harness 或 Delorun 的 home。如果一个 chat 在其工作区文件夹之外工作，或停在某一轮的中途，它就会留在原处，因为继续它会把它未完成的工具调用提供给重试；请先在 DeepSeek Harness 中完成或关闭它，然后再次导入。

在你对 profile、设置或指令回答“是”之前，导入会逐页展示将要落地的全部文本。对于 skill，它会列出每个文件，并在你要求时展示 skill 的指令。

<a id="what-stays-behind"></a>

## 哪些留在原处

预览会列出每个不被复制的项目及原因：

- 日志、缓存、已安装的运行时和已安装的插件包，这些会重新创建；
- 桌面应用自己的 profile `desktop`；
- profile 的更改历史，它在 Delorun 中从头开始，以及实时分享链接；
- chat 搁置的工具输出，它们留在 `~/.dsh`，以及这套安装的匿名标识符；
- `.env`，其中可能含有密钥：请手工复制你需要的内容；
- 你授予工具的权限和计划中的后续任务，Delorun 会重新询问；
- 符号链接、管道、其他已挂载的驱动器、具有多个硬链接的文件，以及 DeepSeek Harness 不会写入的名称，这些永远不会被跟随或复制；
- 内容与其存储名称不符的附件；
- 由比你的 Delorun 所能读取的更新的 DeepSeek Harness 写下的 chat、以未压缩形式存储的 chat，以及过大或此版本无法读取的文档；
- 导入不认识的任何东西。

<a id="chats-from-the-deepseek-website"></a>

## 来自 DeepSeek 网站的 chat

上面的导入从 `~/.dsh` 复制 chat。你在 chat.deepseek.com 上的 chat 是另一个来源：从网站导出它们，再用可选的 chat 导入插件加载该文件，见[导入你的 DeepSeek 网站 chat](import-deepseek-chats.zh.md)。

<a id="plugins-after-the-import"></a>

## 导入之后的插件

已安装的插件包不会被复制。预览会把每个 profile 的每个插件和 bundle 列为已带过来、待安装、已添加或未带过来。对于每个有待安装内容的 profile，请运行导入打印的命令，例如：

```text
delorun plugin --profile web install
```

安装会像 DeepSeek Harness 那样运行 pnpm。插件的安装脚本只有在你批准之后才会运行，因为你在 DeepSeek Harness 中给出的批准不会被带过来。DeepSeek Harness 已淘汰的插件会被列为未带过来。

<a id="a-home-that-already-has-chats"></a>

## 已经有 chat 的 home

导入会拒绝已经存有 chat 的 Delorun home，所以你不会意外地混合两份历史。加上 `--merge` 再次运行，就可以把你的 stock chat 添加到它们旁边。如果某个 chat 或文件已经以相同内容存在于你的 Delorun home 中，就会被跳过；同名但内容不同的则会让导入停止，导入从不覆盖任何东西。

除非你用字节数给出更大的上限，例如用 `--max-size 8589934592` 表示 8 GiB，否则导入最多复制 4 GiB。

<a id="what-changes-when-you-switch"></a>

## 切换之后有什么变化

你的 chat 和工作区看起来和以前一样，你的插件在安装之后也和在 DeepSeek Harness 中一样工作。有几件事在 Delorun 的 studio 中表现不同：

- **Delorun 在哪里运行。**`delorun` 在后台运行 Delorun 并打开 studio；`delorun stop` 会停止它（见[日常使用](daily-use.zh.md)）。
- **你的 home。**Delorun 保有自己的 home `~/.delorun`，从不写入 `~/.dsh`（见[你的 Delorun home](home.zh.md)）。
- **命令能触及什么。**模型运行的命令不能写入也不能读取 Delorun 的 home，每个新工作区都以 Workspace Write 开始（见 [Delorun 保护什么](safety.zh.md)）。
- **同意。**在 setup 默认的 Ask me first 下，Delorun 会在模型写入指令文件或安排工作之前询问，把运行命令的新 MCP 服务器扣住直到你允许，并在工作区获得完全访问之前询问一次（见[同意](safety.zh.md#consents)）。
- **`web_fetch`。**它不会获取你自己电脑或网络上的地址（见 [web_fetch 防护](safety.zh.md#the-web_fetch-guard)）。
- **数据共享。**DeepSeek 的会话日志上传在你于“设置”→“安全”→“隐私”中开启之前是关闭的。
- **更新。**Delorun 每天检查一次是否有更新的发布版本，在你确认之前显示更新会改变什么，并且可以回退（见[更新](updates.zh.md)）。
- **外观。**Delorun 的主题、侧边栏、chat 状态和设置布局。

[Delorun 与 stock DeepSeek Harness](delorun-vs-stock.zh.md)列出了每一处差异以及 Delorun 不包含什么，[对等清单](../reference/parity.zh.md)列出了每个被更改的默认值及其依据。

## Ask less (like DeepSeek Harness)

下面每一项都把一处差异恢复为 DeepSeek Harness 的行为，你可以随时改回去：

| 开关 | 位置 | 它改变什么 |
| --- | --- | --- |
| 提示：**Ask less (like DeepSeek Harness)** | `delorun setup prompts`，或 setup 中的提示问题 | 关闭完全访问同意、指令文件同意、MCP 服务器同意和计划任务同意。`web_fetch` 防护保持开启。 |
| 外观：关闭 **Delorun look** | “设置”→“通用”→“外观”，或新手引导的 studio 外观 | 原始外观，没有 Delorun 的主题、侧边栏、chat 状态、设置布局和新手引导。在“设置”→“通用”中再次开启 **Delorun look** 即可切换回来。 |
| 关闭 **Check for new releases** | “设置”→“通用”→“更新”，或 `delorun setup privacy` | 不发出检查发布版本的请求；你运行 `delorun update` 时它仍然可用。 |
| 开启 **DeepSeek session-log upload** | “设置”→“安全”→“隐私” | 发往 DeepSeek API 的每个请求都携带你的一部分会话日志，与 DeepSeek Harness 相同。 |

有些差异没有开关：模型运行的命令从不写入 Delorun 的 home，`web_fetch` 总是拒绝本地地址，Delorun 会检查它运行的每一个发布版本。

<a id="going-back"></a>

## 切换回去

`~/.dsh` 保持不动，所以 stock DeepSeek Harness 的工作方式和导入之前一样。你在 Delorun 中开始的 chat 留在你的 Delorun home 中；`delorun export` 会把 chat 和工作区写成文件，另一个 home 可以用 `delorun import` 导入它们。

<details>
<summary>边界情况</summary>

- 如果 `~/.dsh` 不存在或无法读取，那么 `delorun import-home` 会以 `DSH_IMPORT_SOURCE_UNUSABLE` 拒绝，且不导入任何东西。请用 `--from <dir>` 指定另一个 stock home。
- 如果 `~/.dsh` 是链接而不是文件夹，那么 setup 不会提供导入。
- 如果你在没有终端的情况下运行导入，那么不会导入任何东西，因为它在复制之前要先询问。
- 如果导入时 DeepSeek Harness 或 Delorun 正在运行，请先停止两者。复制过程中发生变化的文件会让导入停止，并让你的 Delorun home 保持原样。
- 如果你的电脑在导入过程中停机，那么 Delorun 下次启动时会删除它已复制的那一部分。
- 如果你的 Delorun home 已经有 chat，那么导入会拒绝，直到你加上 `--merge`。
- 如果复制会超过 4 GiB，那么它会停止。请用字节数给出更大的上限，例如 `--max-size 8589934592`。
- 如果某个 chat 因为停在某一轮的中途而留在原处，那么请先在 DeepSeek Harness 中完成或关闭它，然后再次导入。

</details>

<details>
<summary>进一步了解</summary>

- `delorun import-home --dry-run` 显示一切而不写入任何东西，是安全的第一次查看。
- `delorun import-home --profile work` 导入到 profile `work` 中。
- 被保留不动的设置保存在 `~/.delorun/archive/stock-import/` 下。请从那里复制你信任的内容。
- 用 `delorun export` 和 `delorun import` 在不同的 Delorun home 之间移动 chat（见[日常使用](daily-use.zh.md#trash-export-and-import)）。

</details>

<a id="next"></a>

## 接下来

- 启动 Delorun：[日常使用](daily-use.zh.md)。
- 查看模型提供方：[模型提供方](providers.zh.md)。
- 同时带上 DeepSeek 网站上的 chat：[导入你的 DeepSeek 网站 chat](import-deepseek-chats.zh.md)。
- 了解 Delorun 相对 stock 改变了什么：[Delorun 与 stock DeepSeek Harness](delorun-vs-stock.zh.md)。
- 如果出了问题：[归档、导入与回收站](troubleshooting.zh.md#archives-imports-and-the-trash)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[归档与回收站约定](../contracts/c08-archive-and-trash.zh.md#the-stock-home-import)准确定义了导入复制、保留不动和拒绝的内容，[对等清单](../reference/parity.zh.md)列出了 Delorun 更改的每个默认值及其依据。
