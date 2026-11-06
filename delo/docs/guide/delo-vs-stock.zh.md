---
description: "Delo 与 stock DeepSeek Harness 的区别：Delo 为何存在、哪些内容保持不变、每项产品差异与变更的默认值、如何在两者之间迁移，以及路线图。"
---

# Delo 与 stock DeepSeek Harness

[English](delo-vs-stock.md) | 中文

## 摘要

Delo 是 DeepSeek Harness（DSH）的社区分支。它的安装与运行方式与 stock DSH 相同，并保持 DSH 插件的兼容性；此外，它还提供更好的 studio、从不夺走你工作的更新、深度定制，以及可选的隔离与远程访问，每一项都可以关闭。本页说明 Delo 为何存在、哪些内容完全不变、你会注意到的每一项差异，以及接下来的计划。

## 目录

- [Delo 为何存在](#why-delo-exists)
- [哪些保持不变](#what-stays-the-same)
- [有何不同](#what-is-different)
- [不同的默认值](#defaults-that-differ)
- [Delo 移除了什么](#what-delo-removes)
- [在 DSH 与 Delo 之间迁移](#moving-between-dsh-and-delo)
- [路线图](#roadmap)

<a id="why-delo-exists"></a>

## Delo 为何存在

DSH 是一个出色的 harness，而它的维护者不接受外部贡献。Delo 则是社区可以改动其任何部分的地方：studio、harness、它的插件与它的默认值。Delo 的目标是，让每位使用者都能感到有「一个天才之国」在与自己协作：许多有能力的 agent，在自己的工作与自己的机器上运行，并受自己控制。

Delo 始终遵循以下几条规则：

- **Stock 优先。**全新安装遵循 stock DSH 的工作流：本地运行、无需账户，并有一条打开 studio 的命令。Delo 自身的完整性检查默认运行：启动时的发布日志检查与插件撤销列表。它们不发送任何个人数据，`integrity.mode: off` 会同时关闭这两项网络检查。其他所有网络功能都需要选择开启，并在生效前予以说明。
- **由你掌控修改。**配置、插件、预设、skill、主题与 studio 都归你所有，并由你修改。Delo 绝不隐藏覆盖它们的任何一层。
- **更新绝不会夺走你的工作。**更新之前，你会看到它会破坏什么；你的 profile 会先被创建快照；一次操作即可回退。
- **Delo 无法擅自进入。**你的 studio 运行在你的电脑上，每台新设备都需要你已信任的设备批准。发布版本与插件撤销列表都经过签名；撤销会在插件下一次加载时将其停用，你可以覆盖这一结果。
- **诚实的声明。**只有真正被强制执行的限制才会被称为已强制执行，`delorun verify` 会显示哪些限制确已强制执行。

<a id="what-stays-the-same"></a>

## 哪些保持不变

- harness：Delo 运行 DSH 自身的代码，固定在一个命名的 DSH 发布版本上，每份 Delo 发布说明都会在「From upstream」一节中注明该版本。
- 插件、预设、skill、profile、组合包、客户端 slot 与会话的工作方式与 DSH 相同，使用相同的 id 与 wire format。一套已录制的测试套件会在关闭 Delo 附加功能的情况下，通过 Delo 重放 DSH 自身的场景，结果必须一致。
- 上游的四种模式（Standard、PTC、Minimal 与 Creator）在每个新 chat 中都可用。
- DSH 支持的模型提供方，配置方式相同。
- MIT 许可证。

<a id="what-is-different"></a>

## 有何不同

| 方面 | stock DSH | Delo |
| --- | --- | --- |
| 安装 | npm 包与桌面应用 | `npx delorun`（或 `pnpx`、`bunx`、全局安装）、已签名的安装脚本，以及面向 macOS 与 Windows 的已签名桌面应用；在 Linux 与 WSL2 内，使用 npm 或安装脚本 |
| home | `~/.dsh` | `~/.delo`，可按需导入一份 DSH 设置的副本；`~/.dsh` 永不被修改 |
| 设置 | 首次运行对话框 | 设置界面，用于配置模型提供方及其密钥、原生或 Docker 工作区、Delo 的 studio 附加功能与远程访问；脚本使用 `delorun setup --yes` |
| studio | DSH studio | Delo 的主题、chat 列表（含 chat 状态：snooze 与 settle）、主 chat 区域、设置布局与思考视图，或一个开关切换为 stock 外观 |
| 更新 | 启动时可能停用不兼容的插件 | 更新前显示会破坏什么的报告，应用前创建快照，更新后进行健康检查，并且每个通道都可以回滚 |
| 你自己的修改 | Profile 层 | Profile 层，加上带撤销、安全模式、插件 eject 的 profile 历史，以及在更新后仍保留的预设、skill、主题与 Creator 修改 |
| 隔离 | 原生，由操作系统沙箱限制文件写入 | 原生模式，同一沙箱还会在你的系统能够强制执行时，阻止命令读取 Delo 的密钥与令牌，或连接其控制套接字与 Docker socket，`delorun verify` 会报告这一点；或 Docker 模式：在 Linux 上每个工作区位于自己的容器中，或使用一个共享容器，它隔离你的计算机但不隔离各项目之间，该机器强制执行的限制会在 setup 中列出 |
| 权限 | 所有工作区使用同一个默认值 | 新工作区从 stock 的 `workspace-write` 开始；完全访问权限每个工作区询问一次；计划任务在你批准之前，会写明它将以哪个会话与预设运行 |
| Web 抓取 | 在每种模式下都无需询问即可访问回环与私有网络主机 | 拒绝回环、链路本地与私有网络目标（包括云元数据地址），除非你关闭该防护。该防护只覆盖 `web_fetch` 工具；命令，以及你配置的代理或远程抓取提供方，不在其范围之内。 |
| 从其他设备远程访问 | 你在局域网地址上的自有证书，或实验性的 Liveshare | 你的 tailnet（Tailscale 私有或 Funnel），或你自己域名上的自有中继，配合通行密钥或你自己的登录提供方，并由已信任的设备批准每台新设备 |
| 验证 | 无 | `delorun verify` 检查发布版本、文件、隔离、暴露、登录、插件与数据共享，并说明你的系统无法强制执行哪些项目 |
| 日志 | 终端或桌面控制台中的进程输出 | 按 Delo 各部分划分的运行日志，经过轮转并隐去机密；`delorun logs` 用于查找它们 |
| 数据共享 | 桌面分析已开启 | Delo 没有自己的遥测；DSH 的桌面分析与 DeepSeek 会话日志上传仍可用，但除非你开启，否则保持关闭 |
| 插件 | 自带索引 | 一个社区插件索引，带有「tested with Delo X」徽章，并撤销已知有问题的版本；作者或评审者列出的发现会显示为其主张 |
| 诊断 | — | `delorun doctor` 检查你的设置；`preset_inspect` 显示某个预设组合了什么 |
| 工作区 | 本地文件夹 | 本地文件夹、通过 `git clone` 导入、`AGENTS.md` 编辑、回收站与导出文件 |
| 发布 | DSH 的签名 | 已签名的发布，附带 SBOM 与公开日志条目，并与基于已标记源码的重建结果一致；npm 发布附带构建证明 |
| 文档 | DSH 的文档 | [docs.delorun.com](https://docs.delorun.com)，提供英文与中文版本；每个页面也有 Markdown 版本，并附带 `llms.txt` 索引供编码 agent 使用 |
| 贡献 | 不接受 | 欢迎参与各个部分，采用 MIT 许可并附 DCO 签名；使用化名也可以 |

<a id="defaults-that-differ"></a>

## 不同的默认值

Delo 有意更改了 DSH 的一些默认值，对等清单（`delo/docs/reference/parity.md`）会逐项列出，本树不包含该清单：

- Delo 的 studio 附加功能默认开启；切换一下即可使用 stock 外观。
- 在新手引导中选择模式时，PTC 已预先选中。
- 新工作区从 stock 的 `workspace-write` 开始；区别在于完全访问权限每个工作区询问一次。
- DSH 的桌面分析与 DeepSeek 会话日志上传在你开启之前保持关闭。
- `web_fetch` 拒绝回环、链路本地与私有网络目标。
- 在系统能够强制执行时，命令无法读取 Delo 的密钥或连接其控制套接字；`delorun verify` 会报告具体情况。
- 计划任务的创建或编辑、模型对指令层文件的写入，以及添加 MCP 服务器时（该同意会写明其将运行的命令），Delo 都会先征得你的同意。
- 容器内对文件访问的拒绝会带有环境标记，且不会为其提供提权选项。
- 主 chat 的写入类工具运行前总会询问。
- `plugin_manager` 的读取操作无需完全访问提权即可运行，一个开关可将此豁免关闭。
- Delo 新增了一个模型可见的工具 `preset_inspect`，可在配置中切换。doctor 是你运行的命令，没有模型能看到它。

<a id="what-delo-removes"></a>

## Delo 移除了什么

- DeepSeek 的账户与 Platform 集成。Delo 可与 DSH 支持的任何模型提供方配合使用，包括使用你自己密钥的 DeepSeek API。

<a id="moving-between-dsh-and-delo"></a>

## 在 DSH 与 Delo 之间迁移

- **从 DSH 迁入：**设置会提议从 `~/.dsh` 导入一份插件、设置与 chat 的副本，它永不修改 `~/.dsh`。
- **回到 DSH：**你的 DSH home 保持不变，因此 stock DSH 可以与 Delo 并存运行。Delo 的导出文件可以在各个 home 之间携带工作区与 chat。
- **不离开 Delo 也能使用 Delo 的外观：**关闭 Delo 的 studio 附加功能即可使用 stock 外观，或单独关闭其中任意一项。

<a id="roadmap"></a>

## 路线图

路线图按顺序排列，而不标注日期：每个阶段都在前一阶段就绪后开始。

1. **首次发布。**[有何不同](#what-is-different)中的全部内容：studio、安全更新、定制、原生与 Docker 工作区、通过你的 tailnet 或自有中继实现的远程访问、验证、运行日志、插件索引与文档网站。
2. **Delo 中继。**`your-name.delo.run` 上的 studio 地址、Delo Run 账户，以及经由 Delo 的设备批准，首先以 beta 版本发布。Delo Run 传递它无法读取的加密流量，宣布该功能的页面会准确说明 Delo 能看到什么。
3. **studio 后续功能。**Delo 自己的手机侧边栏。
4. **额外机器。**从一个 studio 在笔记本电脑、服务器或 homelab 机器上运行 chat：每台机器一个小型 agent、配对、工作区副本，以及在另一台机器上继续一个 chat。
5. **第 5 阶段，无固定顺序。**
   - 可选的遥测，默认关闭，除非你同意，并显示其确切负载。
   - 一项可选的插件安全审查：一个 agent 预设，你可以在安装插件之前对其运行；它可以与社区共享其发现。
   - 覆盖你的 chat 的活动历史，以及实时系统状态面板。
   - 编辑 harness 自身的源码，且更新会保留你的修改。
   - 桌面应用管理 WSL2、Linux AppImage，以及桌面应用与命令行共享的一个 profile。
   - 面向托管 home 的 harness 与工作区 Docker 模式。
   - 工作区检查点、定期的本地与异地加密备份，以及 Delo Run Backup。
   - agent team、通过 SSH 在其他机器上的工作区、托管 home 与机器，以及团队功能。

不计划提供：将其他 harness 作为产品管理、把一个 chat 拆分到多台机器上，以及 Delo 售卖模型访问权限。
