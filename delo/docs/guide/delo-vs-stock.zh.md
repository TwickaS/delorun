---
description: "Delorun 与 stock DeepSeek Harness 的区别：Delorun 为何存在、哪些保持不变、你会注意到的每一项差异、它更改的默认值、它移除了什么、哪些尚不可用、如何在两者之间迁移，以及路线图。"
---

# Delorun 与 stock DeepSeek Harness

[English](delo-vs-stock.md) | 中文

Delorun 尚无正式发布；本页描述构建首个发布版本所用的代码。

## 摘要

Delorun 是 DeepSeek Harness（DSH）的社区分支。它运行 DSH 自身的代码，保持 DSH 插件与会话的兼容性，安装与使用方式与 stock DSH 相同：本地运行、无需账户、一条命令打开 studio。在此之上，它增加了自己的 studio 外观、先显示将改变什么且可以回退的更新、对模型所运行命令的防护，以及通过你自己的 tailnet 从手机远程访问；其中每一项会改变模型所见内容的功能都可以切换回 stock。本页列出哪些保持不变、你会注意到的每一项差异、哪些尚不可用，以及接下来的计划。

## 目录

- [Delorun 为何存在](#why-delorun-exists)
- [哪些保持不变](#what-stays-the-same)
- [有何不同](#what-is-different)
- [不同的默认值](#defaults-that-differ)
- [Delorun 移除了什么](#what-delorun-removes)
- [尚不可用](#not-available-yet)
- [在 DSH 与 Delorun 之间迁移](#moving-between-dsh-and-delorun)
- [路线图](#roadmap)
- [面向技术读者](#for-the-technically-curious)

<a id="why-delorun-exists"></a>

## Delorun 为何存在

DSH 是一个出色的 harness，而它的维护者不接受外部贡献。Delorun 则是社区可以改动其任何部分的地方：studio、harness、它的插件与它的默认值。它的目标是让每位使用者都能有许多有能力的 agent 与自己协作，在自己的工作与自己的机器上运行，并受自己控制。

Delorun 遵守以下规则：

- **Stock 优先。**全新安装遵循 stock DSH 的工作流。Delorun 不发送任何关于你的信息；它默认的网络请求只有每次启动时的发布日志检查与每天一次的新版本检查，可在 Settings → General → Updates 中关闭（[你使用 Delorun 时信任什么](trust.zh.md#what-leaves-your-machine)）。
- **由你修改。**配置、插件、预设、skill、主题与 studio 都归你所有，没有任何隐藏的层会覆盖它们。
- **更新绝不会夺走你的工作。**更新之前，你会看到它将改变什么；你的 profile 会先被保存；一条命令即可回退（[更新](updates.md)）。
- **Delorun 无法擅自进入。**你的 studio 运行在你的电脑上，每台新设备都需要你在这台电脑上批准（[从手机访问 studio](reach.md)）。
- **诚实的声明。**只有经测试证明的防护才会被称为已强制执行，本指南会标出哪些尚不可用。

<a id="what-stays-the-same"></a>

## 哪些保持不变

- **harness。**Delorun 运行 DSH 自身的代码，固定在一个命名的 DSH 发布版本上；`delorun --version` 会打印两者的版本。
- **兼容性。**插件、预设、skill、profile、组合包、客户端 slot 与会话的工作方式与 DSH 相同，使用相同的 id 与 wire format。一项改动进入 Delorun 主干之前，会有一项检查在关闭 Delorun 所有模型可见改动的情况下，通过 Delorun 重放 DSH 自身录制的场景，结果必须一致。
- **模式。**DSH 的四种 agent 预设（Standard、PTC、Minimal 与 Creator）在每个新 chat 中都可选，默认是 Standard。
- **模型提供方。**DSH 支持的提供方，配置方式相同。
- **许可证。**MIT。

<a id="what-is-different"></a>

## 有何不同

| 方面 | stock DSH | Delorun |
| --- | --- | --- |
| 安装 | npm 包与桌面应用 | `npx delorun`，它在安装每个发布版本之前校验其签名及其在公开发布日志中的条目；支持 Linux x64 与 arm64，以及 Windows x64（包括 WSL2）（[安装与首次运行](install.md)） |
| home | `~/.dsh` | `~/.delo`，只有你能读取；`~/.dsh` 永不被修改，`delorun import-home` 会从中复制你选择的内容（[你的 Delorun home](home.zh.md)） |
| 运行 | 终端中的一条命令，或桌面应用 | `delorun` 在后台运行并打开 studio；`delorun start`、`stop`、`status`、`open`、`doctor` 与 `logs` 管理它（[日常使用](daily-use.md)） |
| 设置 | 首次运行对话框 | 终端中的 Quick 或 Full 设置：隐私、从 `~/.dsh` 导入、模型密钥、提示的谨慎程度，Full 设置还包括后台运行、远程访问、profile 与端口；脚本使用 `delorun setup --yes` |
| studio | DSH 的外观 | Delorun 的主题、侧边栏、chat 状态、设置布局与新手引导，或一个开关切换为 stock 外观 |
| 更新 | 启动时可能停用不兼容的插件 | 确认之前显示将改变什么的报告，先创建 profile 快照并可选复制你的 chat 数据，之后进行健康检查，失败时自动回滚，并可用 `delorun recover` 回退（[更新](updates.md)） |
| 你自己的修改 | Profile 层 | Profile 层、可由 `delorun recover restore` 恢复的 profile 历史、安全模式，以及拒绝丢弃你添加的插件、设置或本地插件的更新检查 |
| 命令能触及什么 | 沙箱限制文件写入 | 同一沙箱还会在你的系统能够强制执行时，阻止命令写入或读取 Delorun 的 home 及其密钥，以及连接其控制套接字与 Docker 的套接字（[Delorun 保护什么](safety.md#the-sandbox)） |
| 权限 | 所有工作区使用同一个默认值 | 每个新工作区都从 Workspace Write 开始；选择 Safer 提示时，把工作区切换为完全访问会被拒绝（[完全访问](safety.md#full-access)） |
| 同意 | — | 选择 Safer 提示时，模型的文件工具写入 `AGENTS.md`、skill 与预设之前会先询问，计划任务会连同其时间安排与目标一起询问，运行命令的新 MCP 服务器会被拒绝（[同意](safety.md#consents)） |
| Web 抓取 | 在每种模式下都能访问回环与私有网络主机 | `web_fetch` 拒绝回环、链路本地与私有网络目标（包括云元数据地址）；命令不在该防护范围之内 |
| 从其他设备访问 | 你在局域网地址上的自有证书，或实验性的 Liveshare | 通过你自己 tailnet 上的 Tailscale，每台设备都在你的电脑上凭其显示的代码批准（[从手机访问 studio](reach.md)） |
| 验证 | — | `delorun verify` 检查已安装发布版本的签名、其发布日志条目及其文件 |
| 日志 | 终端中的进程输出 | 按进程划分的运行日志，经过轮转并隐去机密，`delorun logs` 用于查找它们（[Delorun 把日志放在哪里](logs.zh.md)） |
| 数据共享 | 桌面分析与 DeepSeek 会话日志上传默认开启 | Delorun 没有自己的遥测；DeepSeek 会话日志上传在你于 Settings → Privacy 中开启之前保持关闭，`delorun` 运行的 profile 中没有桌面分析 |
| 工作区 | 本地文件夹 | 本地文件夹，带有存放已删除 chat 与工作区的回收站，以及在 home 之间移动它们的已签名导出文件 |
| 文档 | DSH 的文档 | 本指南，位于 [docs.delorun.com](https://docs.delorun.com) |
| 贡献 | 不接受 | 欢迎参与各个部分，采用 MIT 许可并附 DCO 签名；使用化名也可以 |

<a id="defaults-that-differ"></a>

## 不同的默认值

[对等清单](../reference/parity.zh.md)逐项列出每个更改的默认值及其依据：

- Delorun 的 studio 附加功能默认开启；在 Settings → General → Look 中切换一下即可使用 stock 外观。
- 无论部署的默认值是什么，新工作区都从 Workspace Write 开始；选择 Safer 提示时，切换为完全访问会被拒绝。
- DeepSeek 的会话日志上传在你开启之前保持关闭。
- `web_fetch` 拒绝回环、链路本地与私有网络目标。
- 在你的系统能够强制执行时，模型运行的命令无法写入或读取 Delorun 的 home，也无法连接其控制套接字。
- 选择 Safer 提示时，指令文件、MCP 服务器与计划任务的同意适用。设置中的 **Same as stock** 回答会关闭它们以及完全访问的拒绝（[Same as stock](switching.md#same-as-stock)）。
- 默认工作区是你的 Documents 文件夹中的 `Delo/default-workspace`；系统未指定 Documents 文件夹时，位于你的 home 文件夹中。

对等注册表声明的其他差异，例如 `preset_inspect`、供模型使用的 profile 历史操作与容器拒绝标记，在 `delorun` 运行的 profile 中都是关闭的，因此每一项都保持 DSH 的行为。

<a id="what-delorun-removes"></a>

## Delorun 移除了什么

- DeepSeek 的账户与 Platform 集成：没有 Platform 登录、Usage 或 Top-up 页面。Delorun 可与 DSH 支持的任何模型提供方配合使用，包括使用你自己密钥的 DeepSeek API。

<a id="not-available-yet"></a>

## 尚不可用

以下内容属于 Delorun 的计划，代码中尚未提供：

- Delorun 桌面应用，以及 macOS 发布版本；
- Docker 工作区，即工作区的命令在容器中运行；
- 为单个工作区授予完全访问的同意界面，以及接受新 MCP 服务器的方式；
- 通过 Tailscale Funnel 或你自己域名上的自有中继访问，以及使用通行密钥或你自己的登录提供方登录；
- `delorun verify` 对隔离、暴露、登录、插件与数据共享的检查，报告将其列为 `not run`；
- 带有「tested with Delorun X」徽章的社区插件目录，以及已知有问题插件版本的撤销列表；
- eject 一个插件，同时在你的 profile 中保留其设置；
- 主 chat、用 `git clone` 导入工作区以及从 studio 编辑其 `AGENTS.md`：它们以插件形式存在，但没有 profile 加载它们；
- 在新手引导中把 PTC 作为默认模式。

<a id="moving-between-dsh-and-delorun"></a>

## 在 DSH 与 Delorun 之间迁移

- **从 DSH 迁入：**设置会提议从 `~/.dsh` 复制你的 chat 与工作区，`delorun import-home` 随时可以执行这一操作，并逐项询问你的 profile、设置、指令、skill 与密钥；`~/.dsh` 永不被修改（[从 DeepSeek Harness 切换](switching.md)）。
- **回到 DSH：**你的 DSH home 保持不变，因此 stock DSH 可以与 Delorun 并存运行。`delorun export` 把 chat 与工作区写成另一个 home 可以导入的文件。
- **在 Delorun 中使用 stock 行为：**关闭 Delorun 的 studio 附加功能即可使用 stock 外观，在 `delorun setup prompts` 中回答 **Same as stock** 即可使用 DSH 的提示。

<a id="roadmap"></a>

## 路线图

路线图按顺序排列，而不标注日期：每个阶段都在前一阶段就绪后开始。

1. **首次发布。**[有何不同](#what-is-different)中列出的内容：studio、安全更新、定制、带有 Delorun 防护的原生工作区、通过你的 tailnet 远程访问、发布版本的验证、运行日志与本指南。
2. **Delo 中继。**`your-name.delo.run` 上的 studio 地址、Delo Run 账户，以及经由 Delo 的设备批准，首先以 beta 版本发布。Delo Run 传递它无法读取的加密流量，宣布该功能的页面会准确说明 Delo 能看到什么。
3. **studio 后续功能。**Delorun 自己的手机侧边栏。
4. **额外机器。**从一个 studio 在笔记本电脑、服务器或 homelab 机器上运行 chat：每台机器一个小型 agent、配对、工作区副本，以及在另一台机器上继续一个 chat。
5. **第 5 阶段，无固定顺序。**
   - [尚不可用](#not-available-yet)中的各项。
   - 可选的遥测，除非你同意否则保持关闭，并显示其确切负载。
   - 一项可选的插件安全审查：一个 agent 预设，你可以在安装插件之前对其运行；它可以与社区共享其发现。
   - 覆盖你的 chat 的活动历史，以及实时系统状态面板。
   - 桌面应用管理 WSL2、Linux AppImage，以及桌面应用与命令行共享的一个 profile。
   - 面向托管 home 的 harness 与工作区 Docker 模式。
   - 工作区检查点、定期的本地与异地加密备份，以及 Delo Run Backup。
   - agent team、通过 SSH 在其他机器上的工作区、托管 home 与机器，以及团队功能。

不计划提供：将其他 harness 作为产品管理、把一个 chat 拆分到多台机器上，以及 Delorun 售卖模型访问权限。

<a id="for-the-technically-curious"></a>

## 面向技术读者

[对等清单](../reference/parity.zh.md)列出与 stock 的每一项差异及其依据，[对等组合约定](../contracts/c16-parity-composition.zh.md)定义 Delorun 如何证明在关闭其改动时仍与 stock 行为一致。
