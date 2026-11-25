---
description: "日常使用 Delorun：启动、打开和停止 studio，status、doctor、verify 和 logs，工作区以及模型可以在其中改动什么，你自己的更改，安全模式与恢复，回收站与归档，以及 plugin 和 headless 命令。"
---

# 日常使用

[English](daily-use.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页介绍你每天使用的命令，以及你对模型可以改动什么所做的选择。它假定 Delorun 已经安装并完成 setup（见[安装与首次运行](../get-started/install.zh.md)）。Delorun 为每个 [profile](../../reference/glossary.zh.md#profile) 作为一个后台程序运行，即 [home 进程](../../reference/glossary.zh.md#home-process)，它在你的浏览器中提供 [studio](../../reference/glossary.zh.md#studio)。几条命令可以启动、打开、停止和检查它。每个 chat 在一个[工作区](../../reference/glossary.zh.md#workspace)中工作，这是一个模型可以读取和更改其中文件的文件夹。当你添加的某样东西使 Delorun 无法启动时，安全模式会在不带你的插件的情况下启动它，直到你修好为止。

## 目录

- [启动、打开与停止](#start-open-and-stop)
- [检查发布版本与你的设置](#check-the-release-and-your-setup)
- [工作区与模型可以改动的内容](#workspaces-and-what-the-model-may-change)
- [把 Delorun 变成你的](#make-delorun-yours)
- [安全模式与恢复](#safe-mode-and-recovery)
- [回收站、导出与导入](#trash-export-and-import)
- [plugin 与 headless 命令](#the-plugin-and-headless-commands)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="start-open-and-stop"></a>

## 启动、打开与停止

| 命令 | 作用 |
| --- | --- |
| `delorun` | 启动 Delorun 并打开 studio。在新的 home 上，它会先运行 setup（见[安装与首次运行](../get-started/install.zh.md)）。 |
| `delorun start` | 启动 Delorun 但不打开 studio。`--open` 同时打开它。 |
| `delorun start --foreground` | 在当前终端中运行 Delorun。按 Ctrl-C 停止。 |
| `delorun open` | 用一次性登录链接在浏览器中打开 studio。`--print` 改为打印该链接（见[没有浏览器的电脑](../get-started/install.zh.md#a-computer-without-a-browser)）。 |
| `delorun status` | 显示 Delorun 是否在运行、studio 的地址、正在运行的发布版本以及正在运行的 chat 数量。`--verbose` 会加上进程 id、启动 id 和上一个发布版本。`--json` 以 JSON 格式打印。 |
| `delorun stop` | 在正在运行的 chat 结束各自的轮次之后停止 Delorun。 |
| `delorun stop --now` | 立即停止。它会取消正在运行的轮次和后台任务。 |

`delorun` 和 `delorun start` 在后台运行 Delorun，所以你关闭终端之后它仍会继续运行，除非你在 setup 的“更多设置”下对后台问题回答了“否”。`delorun setup background` 会再次询问。后台启动会打印 `Delorun is running in the background for the profile default at <address>; it keeps running after this terminal closes.`，然后说明如何查看、跟踪和停止它。

`delorun stop` 会停止新的轮次，打印 `Waiting for N running chat(s) to end…`，并最多等待 30 分钟，之后无论如何都会停止。完成后它会打印 `Delorun stopped for the profile default.` `delorun stop --now` 则改为取消正在运行的 chat。

大多数命令可以在命令名之后带上 `--profile <name>`，以对另一个 profile 操作，例如 `delorun status --profile work`。`DELORUN_PROFILE` 为每条命令设置它（见[你的 Delorun home](../customising/home.zh.md#profiles)）。

<details>
<summary>边界情况</summary>

- 如果 Delorun 已经在运行，那么 `delorun start` 会这样说明且不做任何更改。请用 `delorun open` 打开它。
- 如果某条命令需要 Delorun 正在运行而它没有运行，那么该命令会以退出码 3 退出。请用 `delorun start` 启动它。退出码：0 完成，1 失败，2 命令行错误，3 未运行（见[故障排查](../help/troubleshooting.zh.md#reading-a-refusal)）。
- 如果 `delorun start` 以 `Delorun did not start. Delorun stopped with exit code 1 before it was running.` 结束，那么请运行 `delorun logs` 查看原因，并运行 `delorun doctor` 检查你的设置。studio 端口被占用时会显示为 `fail port`（见[启动与停止](../help/troubleshooting.zh.md#starting-and-stopping)）。
- 如果 `delorun stop --now` 无法结束进程，那么它会用信号停止它，并警告它启动的命令可能仍在运行。
- 如果你在 Delorun 运行时运行 `delorun trash`、`export` 或 `import` 命令，那么它会拒绝，并要求你先运行 `delorun stop`。

</details>

<details>
<summary>进一步了解</summary>

- 用 `delorun --profile work` 在第一个 profile 旁边运行第二个 profile（见[你的 Delorun home](../customising/home.zh.md#profiles)）。
- 用 `delorun setup background` 让 Delorun 在终端中而不是后台运行。
- 用手机访问 studio：[用手机访问 studio](reach.zh.md)。相关命令是 `delorun reach` 和 `delorun devices`。

</details>

<a id="check-the-release-and-your-setup"></a>

## 检查发布版本与你的设置

- **`delorun doctor`** 检查你的 home 的权限、Docker 是否有响应、你的 DeepSeek 密钥的格式（不发送它）、studio 的端口是否空闲、在 Linux 上 bubblewrap 是否能为命令提供沙箱（`sandbox` 一行）、工作区注册表能否读取、profile 是否会在没有其保护的情况下运行（`dangerous-mode`）、最近一次发布日志检查、最近一次更新检查，以及最近一次导入 DeepSeek Harness home 的情况（`import`）。每一行以 `pass`、`warn` 或 `fail` 开头。当有检查失败时它以 1 退出；它还会报告你的更改和你的 CLI profile 的插件。在没有 Docker 的电脑上出现 `warn docker` 是无害的：使用你电脑自己文件夹的工作区无需它也能工作。
- **`delorun verify`** 对照已签名的 manifest 和公开的发布日志检查已安装的发布版本。它运行两项检查，即发布签名和已安装的文件，并把其他检查列为 `not run`。它的报告以 `this is not a full verification of this Delorun` 结尾。
- **`delorun logs`** 打印每份日志的位置，以及正在运行的 Delorun 的最近记录（见 [Delorun 的日志存放在哪里](../help/logs.zh.md)）。
- **`delorun --version`** 打印 Delorun 的版本以及它所运行的 DeepSeek Harness 的版本。

<details>
<summary>边界情况</summary>

- 如果 `doctor` 显示一行以 `!` 开头的 `key`，那么没有设置 DeepSeek 密钥。请运行 `delorun setup key`，或设置 `DEEPSEEK_API_KEY`。
- 如果 `doctor` 显示 `warn release-log`，那么尚未记录发布日志检查。请运行 `delorun verify`。
- 如果你从源码检出运行，那么 `doctor` 会报告它不检查任何发布渠道。
- 如果 `verify` 离线运行，请添加 `--offline` 以跳过在线日志检查。这些检查以你的身份运行，所以以你的身份运行的程序可能改动它们。

</details>

<details>
<summary>进一步了解</summary>

`delorun verify --release <version>` 检查另一个已安装的发布版本。`delorun verify --json` 和 `delorun status --json` 为脚本打印 JSON。

</details>

<a id="workspaces-and-what-the-model-may-change"></a>

## 工作区与模型可以改动的内容

工作区是你电脑上的一个文件夹。每个 chat 都在其中一个工作区里工作。没有任何东西能撤销智能体对工作区文件所做的更改：撤销涵盖你的 chat 和 Delorun 的设置，不涵盖你的项目（见[撤销涵盖什么](../help/known-issues.zh.md#what-undo-covers)）。请把重要的工作区放在 git 中，并在让智能体修改大量文件之前先提交。工作区的权限预设决定模型运行的命令可以做什么：

- **[Workspace Write](../../reference/glossary.zh.md#workspace-write)。**每个新工作区开始时使用的预设。命令在[沙箱](../../reference/glossary.zh.md#sandbox)（一个被围起来的区域）中运行：它们可以在工作区和获许的临时文件夹内写入。需要更多权限的命令会先询问你，你批准或拒绝那一条命令。
- **[完全访问](../../reference/glossary.zh.md#full-access)。**命令在沙箱之外运行，可以写入你的用户能写入的任何地方，不再询问。

在 Workspace Write 工作区中，模型运行的命令不能写入你的 Delorun home、不能读取其中的密钥或令牌，也不能连接其控制套接字（前提是你的系统强制执行这些规则，见 [Delorun 保护什么](../safety-and-updates/safety.zh.md#the-sandbox)）。

在 setup 默认的 **Ask me first** 下，Delorun 在给予某个工作区完全访问之前，会为每个工作区询问你一次。你要在运行 Delorun 的那台电脑上回答：在 chat 中选择 Full access，使用“设置”→“安全”→“权限”，或在请求它的批准卡片上选择 Allow for this chat（见[完全访问](../safety-and-updates/safety.zh.md#full-access)）。其他[同意](../../reference/glossary.zh.md#consent)会在模型编辑指令文件、添加 MCP 服务器或安排工作之前询问（见[同意](../safety-and-updates/safety.zh.md#consents)）。

<details>
<summary>边界情况</summary>

- 如果你在 `delorun setup prompts` 中选择 **Ask less (like DeepSeek Harness)**，那么工作区会像 DeepSeek Harness 那样不再每次询问，在 studio 自己的确认之后切换为完全访问。
- 如果某个 chat 是从 DeepSeek Harness 或另一个 home 复制来的，并在那里以完全访问运行，那么它会以 Workspace Write 打开。请再次为它的工作区开启完全访问。
- 如果你选择了 Delorun 拒绝作为工作区的文件夹，那么它会指出原因。被拒绝的文件夹包括文件系统根目录、你的用户主目录本身、你的 Delorun home、DeepSeek Harness 的 home，以及包含其中任一个的文件夹。
- 如果你在手机上使用 studio，那么授予完全访问每次都会要求 Face ID 或你的 PIN，除非 Face ID 通行期（pass）已开启（见[用手机访问 studio](reach.zh.md)）。
- 如果你想再次关闭完全访问，请使用“设置”→“安全”→“权限”中的 Revoke，在 chat 中选择 Workspace Write，或运行 `delorun workspace full-access <folder> off`。

</details>

<details>
<summary>进一步了解</summary>

- `delorun workspace full-access` 列出工作区及其预设。`delorun workspace full-access <folder> on` 显示完全访问意味着什么，并在你于终端中确认之后记录它。`off` 无需询问就撤回它。
- `delorun workspace external-agents` 列出获许在工作区中无需询问就启动的外部 agent。[Delorun 保护什么](../safety-and-updates/safety.zh.md#external-agents)对它们作了说明。
- `delorun mcp list`、`accept`、`decline` 和 `revoke` 在终端中回答 MCP 服务器的问题（见 [MCP 服务器](../safety-and-updates/safety.zh.md#mcp-servers)）。
- 在“设置”→“安全”→“网络”中限制沙箱中的命令可以访问的网络范围（见[提示词注入与数据外泄](../safety-and-updates/prompt-injection.zh.md)）。

</details>

<a id="make-delorun-yours"></a>

## 把 Delorun 变成你的

Delorun 就是为了被重新塑造而构建的。你可以更改插件设置，在 Creator 模式中构建 agent 预设、skill 和插件，链接你自己的插件，或编辑 Delorun 自己的文件。Delorun 会记录每一项对它所运行内容的更改，所以你可以查看并撤销它。更新会把你的更改带到新的发布版本，或在你确认之前指出它无法带过去的更改（见[更新](../safety-and-updates/updates.zh.md)）。

- [什么该在哪里定制](../customising/customise.zh.md)比较了修改 Delorun 的各种方式，以及每种方式在更新时的代价。
- [为 Delorun 编写插件](../plugin-guides/plugins.zh.md)从一个新插件讲到一个能在你的 studio 中加载的插件。
- [修改你的 harness](../customising/changing-your-harness.zh.md)说明 `delorun changes` 记录什么、如何保护，以及如何撤销。

Delorun 对你的 profile 所做的每一项更改，同时也是 profile 历史的一个版本，`delorun recover` 可以恢复它。

<a id="safe-mode-and-recovery"></a>

## 安全模式与恢复

当某个插件或 profile 更改使 Delorun 无法启动，或使它行为异常时，请在不带你自己的插件的情况下启动它：

```sh
delorun recover safe-mode        # the next start leaves out your plugins
delorun start
delorun recover exit-safe-mode   # once it works: the next start loads everything again
```

安全模式会略去你添加的每个 bundle 和插件，包括从文件夹安装的插件，并保留 DeepSeek Harness 自己的 bundle 和 Delorun 的 bundle。它不更改任何文件：你的插件及其设置仍留在你的 profile 中，安全模式下的每次启动都会说明它略去了什么。你应该会在开头看到那一行。

不带子命令的 `delorun recover` 显示你的 profile 所处的状态：安全模式是否开启、最近一次更新、你可以恢复的 profile 版本，以及你弹出或保持关闭的插件。

<details>
<summary>边界情况</summary>

- 如果 Delorun 正在运行，请先停止它：安全模式在下次启动时生效。
- 如果你想记住原因，请使用 `delorun recover safe-mode --reason <text>`。
- 如果你的 profile 会在没有保护的情况下运行，例如它的设置关闭了沙箱，那么 Delorun 会拒绝启动，并指出该设置及其文件。请删除该设置，或在安全模式下启动（见[保护与插件](../help/troubleshooting.zh.md#protections-and-plugins)）。
- 如果你想知道 Delorun 是否自行进入了安全模式，那么它没有：它从不自行开启安全模式。

</details>

<details>
<summary>进一步了解</summary>

`delorun recover restore <version>` 带回已保存的 profile 版本。`delorun recover rollback` 回到最近一次更新之前的发布版本（见[切换回去](../safety-and-updates/updates.zh.md#going-back)）。

</details>

<a id="trash-export-and-import"></a>

## 回收站、导出与导入

| 命令 | 作用 |
| --- | --- |
| `delorun trash list` | 列出已删除的 chat 和工作区，每一项带有它的 id 和永久删除前剩余的天数。 |
| `delorun trash restore <id>` | 恢复已删除的 chat；id 取自 `trash list`。工作区在 studio 中恢复。 |
| `delorun trash purge <id>`、`delorun trash empty` | 永久删除一个项目，或所有项目。 |
| `delorun export <chat-or-workspace> --out <file>` | 把一个 chat，或一个工作区的记录连同其 chat 和附件，写成由这个 home 签名的归档。工作区文件夹中的文件不包含在内。 |
| `delorun import <file>` | 检查归档，显示是谁签名的以及其中有什么，并在你确认之后导入。 |

这些命令会更改 studio 使用的 chat 数据，所以请先停止 Delorun。它运行期间这些命令会拒绝。已删除的项目会在回收站中保留 30 天。Delorun 运行期间，studio 中的“设置”→“数据”→“回收站”同样可以列出、恢复和删除项目。

<details>
<summary>边界情况</summary>

- 如果导出文件已经存在，那么 `export` 不会覆盖它。
- 如果归档中会包含看起来像密钥的东西，那么 `export` 会先询问。
- 如果你永久删除了一个 chat，那么它的片段可能仍留在捕获的日志输出中。给 `trash purge` 或 `trash empty` 加上 `--clear-logs`（见[清空日志](../help/logs.zh.md#clearing-logs)）。
- 如果你导入别人的归档，那么 chat 会显示一个说明其来源的横幅。在信任它之前请先阅读（见[归档、导入与回收站](../help/troubleshooting.zh.md#archives-imports-and-the-trash)）。

</details>

<a id="the-plugin-and-headless-commands"></a>

## plugin 与 headless 命令

- **`delorun plugin --profile <name> …`** 在你的 Delorun home 内运行 DeepSeek Harness 的 `dsh plugin`，所以插件的安装方式与在 DeepSeek Harness 本身中相同。它不应用 Delorun 的任何保护。`delorun plugin check <directory>` 读取插件的 `package.json`，不运行其中的任何文件，并说明此发布版本是否接受该插件的版本范围。
- **`delorun headless …`** 回答一个任务然后退出，与 `dsh headless` 相同，但带有 Delorun 的沙箱保护和防护措施。

<details>
<summary>边界情况</summary>

- 如果某个 headless 任务通过 `--permission-mode` 或其环境变量，在没有完全访问授权凭证（grant）的文件夹中请求完全访问，那么 `delorun headless` 会拒绝它。请先在这台电脑上用 `delorun workspace full-access <folder> on` 授予完全访问。

</details>

<a id="next"></a>

## 接下来

- 从手机打开 studio：[从手机访问 studio](reach.zh.md)。
- 把任务交给 Claude Code 或 Codex：[把工作交给 Claude Code 或 Codex](agents.zh.md)。
- 让 Delorun 保持最新：[更新](../safety-and-updates/updates.zh.md)。
- 选择模型：[模型提供方](../get-started/providers.zh.md)。
- 了解这些保护：[Delorun 保护什么](../safety-and-updates/safety.zh.md)。
- 如果出了问题：[故障排查](../help/troubleshooting.zh.md)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[home 进程约定](../../contracts/c19-home-process.zh.md)定义了 start、stop、status 及其退出码。[更新报告约定](../../contracts/c03-update-report.zh.md)定义了安全模式和 `delorun recover`。[归档与回收站约定](../../contracts/c08-archive-and-trash.zh.md)定义了回收站和归档。
