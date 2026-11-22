---
description: "Delorun 首次运行的设计：从安装到第一次 chat 只需一条命令，启动器的进度，按使用场景并分成若干部分的 setup，后台启动，studio 中的新手引导，以及不重复询问同一个问题的规则。"
---

# 首次运行

[English](first-run.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

一条命令 `npx delorun` 就能带一个人从零开始到第一次 chat。启动器在下载和验证发布版本期间说明它在做什么。setup 先询问此人将如何使用 Delorun，然后问一个可用的 chat 所需的少数几个问题；审阅界面上的“更多设置”则询问其他所有会改变这台电脑的问题。然后 setup 启动 Delorun（除非此人另行选择，否则在后台），并打开 studio，由新手引导涵盖 setup 没有涵盖的内容，并且在终端和 studio 之间不会重复询问同一个问题。终端只用于 setup 和运维：聊天在 studio 中进行。setup 的答案见[约定 C11](../contracts/c11-setup-answers.zh.md)。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- **启动器。**npm 启动器在做任何其他事情之前，会拒绝低于 24.9 的 Node，并给出它所需的版本。安装时，它为每一步打印一行：渠道指出的发布版本、带有发布根的签名检查、带有结果的发布日志检查、带有大小的下载，以及安装。当发布日志检查没有运行时，它会打印原因，以及一条指出该发布版本的警告。
- **裸命令。**当 home 没有 CLI profile 时，不带命令的 `delorun` 会运行 setup。有 profile 时，如果 setup 的 `background` 答案如此说明，它会在后台启动 Delorun，否则在终端中启动，并且无论哪种方式都会打开 studio；`--foreground` 让一次启动保持在终端中。
- **按使用场景进行的 setup。**setup 以 “How will you use Delorun?” 开始：只有我在这台电脑上、也从我的手机或另一台设备、或脚本和自动化。答案设定默认值，并决定主流程询问哪些部分（`privacy` 显示一条说明，然后是 `import`、`key` 和 `prompts`，以及手机场景的 `reach`）；审阅界面的“更多设置”询问 `background`、`profile` 及其余部分。setup 以打印后续步骤结束，并且不启动任何东西。第一个问题之后的每个问题都提供返回的办法，审阅界面在写入任何东西之前列出各个答案。`delorun setup <section>` 对已完成 setup 的 profile 再次运行某个部分，`delorun setup --list` 列出这些部分。`--yes` 和 `--config` 在没有终端的情况下给出答案。
- **密钥。**在提示处输入的密钥，在存储之前会用一次发往提供方的实时请求进行检查；检查失败时，此人可以重新输入或继续。
- **结尾。**终端运行时会提议用 `npm install -g delorun@<version>` 安装 `delorun` 命令，版本为启动它的启动器的版本（`DELORUN_LAUNCHER_VERSION`），默认选中“是”，并在此人拒绝或安装失败时打印那一行；不是由启动器启动的运行不提供安装，并说明如何安装固定的版本。然后它按 `background` 答案所说，在后台或在终端中启动 Delorun，并在任一种启动之后打开 studio。它会打印 Delorun 在终端关闭之后是否继续运行、studio 的地址，以及 `delorun status`、`delorun logs --follow` 和 `delorun stop`。没有浏览器可打开时，它会打印地址和 SSH 端口转发那一行。`--yes` 和 `--config` 不启动任何东西，并打印要运行的命令。
- **记录。**setup 把此人看到、回答或跳过了哪些部分，写入 profile 中的 `setup-answers.json`。
- **之后的地址。**`delorun status` 打印 studio 的地址，不带令牌，以及 `Run delorun open to open the studio in your browser.` `delorun doctor` 检查 profile 的 studio 所用的端口，当这个 home 自己的 Delorun 占用它时，把它报告为被 Delorun 使用，而不是失败。
- **默认工作区。**`delorun start` 在 Host 启动之前解析 studio 的默认工作区：当平台报告了一个不是用户主目录的文档文件夹时，就是其中的 `Delorun/default-workspace`，否则在用户主目录中。该文件夹在 studio 第一次需要它时创建，并且绝不会在 Delorun home 之内，也不会在沙箱拒绝作为可写根的任何位置。在其 `workspace-controller` 行上设置了 `defaultWorkspaceDirectory` 的 profile 保留它自己的文件夹。
- **studio。**Delorun 的 profile 用 Delorun 自己的通知替换上游的预览通知。`@delorun/bundle-studio` 挂载 `@delorun/plugin-onboarding`，它的对话框以预览通知开始，询问语言和外观，提供 Claude Code 和 Codex 委托 bundle 以及推荐的插件，并以打开一个带有起始提示的 chat 结束：在默认工作区中，或者当此人已经有一个时，在最近使用的工作区中。两者都不存在时，最后一步提供 Delorun 自己的文件夹选择器，它只添加此人选择或创建的文件夹，并拒绝用户主目录本身、文件系统根目录、Delorun home、stock home 以及包含其中之一的任何文件夹，同时说明原因和应当选择什么。“设置”→“通用”→“Getting started”会再次显示引导，重新加载会让它保持打开，直到完成或被跳过。它的 reach 步骤从不显示，因为目前不存在 reach。

<a id="the-rules"></a>

## 规则

1. 终端用于 setup 和运维：安装、setup、启动、更新、恢复、reach、设备、doctor 和日志。所有聊天都在 studio 中。
2. `npx delorun` 是第一条命令，也是之后的每一条命令：没有 profile 时它运行 setup，有 profile 时它在后台启动 Delorun 并打开 studio。Delorun 从不编辑 shell 启动文件。
3. 每次启动，而不仅仅是第一次，都会说明 Delorun 在终端关闭之后继续运行，说明如何打开 studio，并指出 `delorun status`、`delorun logs --follow` 和 `delorun stop`。`--foreground` 让一次启动保持附着在终端上。
4. 每个问题要么生效，要么不问。上游的两项数据共享选择加入不是 setup 的问题：它们保持关闭，隐私说明会告诉你“设置”→“安全”→“隐私”可以更改它们。
5. 主流程是通往可用 chat 的最短路径：隐私说明；仅当 `~/.dsh` 是目录且 Delorun home 没有 chat 时才询问的 “Copy your DeepSeek Harness chats, attachments and workspace list? They are only read, and nothing in them changes.”，并在任何东西改变之前先给出预览；用一次实时请求检查的密钥；以及提示问题。其他每个答案都采用其默认值。
6. “更多设置”和手机使用场景添加会改变电脑的部分：reach，带有[远程访问设计](reach.zh.md)的检查和那一条命令；命令在哪里运行，仅当 Docker 工作区是发布版本的一部分且仅在 Docker 应答之后才显示；Delorun 是否在后台持续运行；以及 profile 的名称和端口。每个部分也可以通过 `delorun setup <section>` 运行。
7. studio 的第一分钟是一个以 chat 结束的流程。Delorun 的预览通知是新手引导的第一个界面；之后的步骤是语言和外观、提供 Claude Code 和 Codex 委托 bundle 并说明每个可以做什么、推荐的插件，以及 reach。最后一个界面在默认工作区中打开一个带有两三个起始提示的新 chat；没有默认工作区时，它会打开最近使用的工作区，或让此人选择一个可以容纳工作区的文件夹。新手引导可以从“设置”重新打开。
8. 不重复询问任何问题。新手引导读取 `setup-answers.json` 的部分记录，并略去终端已涵盖的内容。唯一的例外是 reach：只要 reach 尚未设置，新手引导就会显示它的步骤，包括此人在终端中跳过它之后，作为一段带有要在电脑上运行的命令的说明。当 setup 存储了一个可用的密钥时，上游的密钥对话框保持隐藏。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- `npx delorun` 在任何 Delorun 检查之前运行 npm 所提供的启动器。没有任何工作流发布它，所以它不带 npm 构建证明；此人按[信任页面](../guide/safety-and-updates/trust.zh.md#checking-it-yourself)所描述的方式在带外检查它，[威胁模型](../security/threat-model.zh.md#releases-the-log-and-the-rebuild)陈述了这一局限。
- `npm install -g delorun@<version>` 以此人自己的权限安装到此人的全局 npm 前缀中。
- 后台启动让 Delorun 在终端关闭之后继续运行；此人用 `delorun stop` 停止它。

<a id="denial-tests"></a>

## 拒绝测试

上述规则改变询问什么以及何时询问；它们所依赖的保护保留各自的拒绝测试，其中有 C11 的 `yes run leaves reach and credential forwarding off` 和 `config file cannot enable reach`。首次运行增加：

- `no question is asked in the studio that setup answered`
- `setup asks no question whose answer it does not apply`
- `the import changes nothing before the person confirms the preview`

<a id="implementation-status"></a>

## 实现状态

启动器的进度及其 Node 检查、带有七个部分的按使用场景进行的 setup（主流程中的 `privacy`、`import`、`key` 和 `prompts`，手机场景的 `reach`，以及“更多设置”下的 `background`、`reach` 和 `profile`）、返回、审阅界面、setup 的结尾（仅后续步骤）及其部分记录均已构建。studio 中的新手引导（包括它的起始提示、文件夹选择器以及从“设置”重新打开）已构建，`delorun start` 解析的默认工作区也已构建。当 setup 的答案如此说明时（这是默认值），裸命令在后台启动，否则在终端中启动。规则 3 对后台启动已构建，后台启动会打印该消息；在终端中的启动不会打印它。stock home 的导入已构建，即 setup 的 `import` 部分和 `delorun import-home`（见 [C8](../contracts/c08-archive-and-trash.zh.md#the-stock-home-import)）。reach 部分已为此人自己的 tailnet 上的 Tailscale 构建，带有 `delorun reach on tailscale` 的检查和信任声明；Docker 部分和新手引导的 reach 步骤尚未构建。
