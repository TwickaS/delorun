---
description: "为什么选择 Delorun：这个构建在 DeepSeek Harness 之上的开源编程智能体 studio 给你什么、它相对 DeepSeek Harness 改变了什么、它与 T3 Code、Claude Code、Codex、Command Code 和 herdr 相比如何，以及什么时候另一个工具更合适。"
---

# 为什么选择 Delorun

[English](why-delorun.md) | 中文

<a id="summary"></a>

## 摘要

Delorun 是一个构建在 DeepSeek Harness 之上的开源编程智能体 studio，面向开放模型，在你的浏览器和手机上运行。Windows 桌面应用处于预览阶段，尚未发布。

本页面向正在把 Delorun 与其他编程智能体作比较的人：你能得到什么、Delorun 相对 DeepSeek Harness 改变了什么、它与另外六个工具相比如何，以及什么时候其中之一更合适。每项主张都链接到持有其细节与限制的页面。Delorun 是一个预览版，在 Linux 上运行，并通过 WSL2 在 Windows 上运行（见[已知问题](help/known-issues.zh.md#where-delorun-runs)）。

<a id="contents"></a>

## 目录

- [你能得到什么](#what-you-get)
- [Delorun 相对 DeepSeek Harness 改变了什么](#what-delorun-changes-from-deepseek-harness)
- [它如何比较](#how-it-compares)
- [什么时候另一个工具更合适](#when-another-tool-fits-better)
- [试一试](#try-it)
- [下一步](#next)
- [来源](#sources)

<a id="what-you-get"></a>

## 你能得到什么

<a id="web-first-phone-included"></a>

### 以 Web 为先，手机也能用

整个 studio 就是一个网页，因此凡是有浏览器的地方它都能用。[studio](../reference/glossary.zh.md#studio) 运行在你自己的电脑上，并在任何浏览器中打开。Windows 桌面应用（同一个 studio 放在它自己的窗口里）处于预览阶段，尚未发布（见[路线图](roadmap.zh.md#next)）。在手机上不需要下载任何应用：在手机的浏览器中打开 studio 的地址，或选择 **Add to Home screen** 把它安装下来。手机通过你自己的 Tailscale 网络访问你的电脑，中间没有 Delorun 的服务，前提是你在电脑上批准它（见[从手机访问 studio](everyday-use/reach.zh.md)）。那里的 studio 是同一个，不过有少数步骤（例如批准一台新设备）仍然只能在你的电脑上完成（见[手机能做什么、不能做什么](everyday-use/reach.zh.md#what-an-approved-phone-can-and-cannot-do)）。

![一条长凳上的三条轨道，每条都把一个密封舱从手机运到电脑：一条径直穿过一个柜台，一条停在读头下方的站点里，一条穿过一条封闭的隧道。](pictures/reach-paths.svg)

这张图说明谁站在你的手机与你的电脑之间。

1. **今天的 Delorun。** 密封舱经由你自己的 Tailscale 网络径直抵达你的电脑，轨道上没有 Delorun 的服务。Tailscale 是轨道旁的柜台：它能看到设备名称、地址和连接时间（见[Tailscale 能看到什么](everyday-use/reach.zh.md#what-tailscale-sees)）。
2. **中间有一个托管服务。** 有些工具让手机经过其厂商运营的服务。该服务能看到什么取决于该服务，所以请阅读它自己的页面。
3. **计划中的 Delorun 中继。** 为了在没有 Tailscale 的情况下实现远程访问，中继被设计成一条封闭的隧道，转发它无法读取的加密流量。它尚未构建；[路线图](roadmap.zh.md#next)说明了它的进展。

<a id="asks-first-keeps-a-way-back"></a>

### 先询问，并留一条退路

Delorun 让你看到即将发生什么，并留一条退路。

- **发布在运行之前先被检查。** `npx delorun` 会对照已签名的发布和一份公开的发布日志验证下载内容（见[启动器验证什么](get-started/install.zh.md#what-the-launcher-verifies)）。
- **有风险的步骤会先询问。** 默认情况下，Delorun 会在工作区获得完全访问之前、在模型写入指令文件或安排工作之前，以及在来自插件或你的编辑器的 MCP 服务器运行命令之前询问（见[同意](safety-and-updates/safety.zh.md#consents)）。
- **命令在沙箱中运行**，沙箱限制文件写入，并让 Delorun 自己的文件夹和密钥无法触及（见[沙箱](safety-and-updates/safety.zh.md#the-sandbox)）。
- **对 Delorun 的更改会被列出，并且可以撤销。** 打开[更改保护](../reference/glossary.zh.md#changes-protection)后，每一项都会等待你的审查（见[保护设置](customising/changing-your-harness.zh.md#the-protection-setting)）。
- **手机用通行密钥确认敏感操作。** 通行密钥留在手机上，只应答手机自己的锁（例如 Face ID 或指纹），因此每个敏感操作都由你、在那部手机上、在那一刻确认。没有它的手机使用 PIN（见[用 Face ID 确认](everyday-use/reach.zh.md#confirm-with-face-id)）。
- **更新在健康检查失败时会自行回退**（见[更新](safety-and-updates/updates.zh.md)）。
- **没有遥测。** Delorun 不发送任何关于你的信息（见[离开你机器的内容](safety-and-updates/trust.zh.md#what-leaves-your-machine)）。

限制同样直白：发布用预览密钥签名，项目之外没有人审查过代码，而命令以你自己的访问权限运行（见[你信任什么](safety-and-updates/trust.zh.md)）。

<a id="bring-your-own-inference"></a>

### 自带推理

Delorun 运行在你已经付费或自行托管的模型上，不销售自己的模型。带上来自 DeepSeek、Anthropic、Google Gemini、OpenAI、OpenRouter、Groq、Together AI 或其他提供方的密钥，把 Delorun 指向任何兼容 OpenAI 的端点，或用 Ollama、LM Studio 或 vLLM 自己提供模型（见[模型提供方](get-started/providers.zh.md)）。Delorun 不需要自己的账户，你的密钥留在你的 [home](../reference/glossary.zh.md#home) 中，而模型选择器可以更改任何 chat 的模型。如果你有 Claude Code 或 Codex 的套餐，chat 可以在你自己的账户下把任务交给它们，在 Delorun 的沙箱之外（见[把工作交给 Claude Code 或 Codex](everyday-use/agents.zh.md)）。

开放权重模型很适合这种方式。DeepSeek 的 API 所提供的两个模型 DeepSeek-V4.1-Flash 与 DeepSeek-V4-Pro，其权重以 MIT 许可证发布；Qwen 以 Apache-2.0 发布权重，Kimi 则以其自己的许可证发布。由于权重是公开的，多家公司托管同一个模型：OpenRouter 与 Together AI 在 DeepSeek 自己的 API 之外也列出 DeepSeek-V4.1-Flash。更换托管方意味着换一把新密钥，而不需要换工具。

新的 chat 从 DeepSeek 开始，在那里一段长 chat 可以从提供方的缓存中读取其大部分输入。DeepSeek 会自动缓存每个请求的开头，而 DeepSeek Harness 被设计为保持该开头不变，功劳归于其作者：一段 chat 的历史只在末尾增长。按 DeepSeek 公布的价格，在 Flash 上缓存输入的成本约为未缓存输入的五十分之一，在 Pro 上约为三十分之一。DeepSeek 称其缓存是尽力而为，因此本页不承诺任何命中率；[开销计量器](everyday-use/cost-meter.zh.md)显示每个 chat 的缓存读取与写入。

<a id="open-by-design"></a>

### 设计上开放

harness 没有需要绕开的固定内核：Delorun 中的一切都是[插件](../reference/glossary.zh.md#plugin)，你甚至可以编辑 harness 本身，因此没有任何东西限制你可以更改什么。这留下两条让它成为你自己的途径，你可以把它们混用。

**使用别人做好的东西。** 为 DeepSeek Harness 编写的插件可以用一条命令安装到 Delorun 上，来自 npm、git 仓库或一个文件夹（见[安装它](plugin-guides/plugins.zh.md#install-it)）。人们已经在编程工具之外做了很多：[dsh-layerfs](https://github.com/Ephemeral-AI-Lab/dsh-layerfs) 是 LayerFS 的插件包，[dsh-context](https://github.com/bowenliang123/dsh-context) 让你洞察 chat 的上下文，[billion-context](https://github.com/ranxianglei/billion-context) 为运行一个月的会话压缩上下文，[dsh-im](https://github.com/xmanrui/dsh-im) 在九个通道上连接消息机器人，而 [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) 在 studio 背后放上动态壁纸。它们的作者是为 DeepSeek Harness 做的这些，Delorun 没有测试过它们。插件市场（一个带有 “tested with Delorun X” 徽章的社区插件索引）是[路线图](roadmap.zh.md#later)上的一个计划方向，尚未构建。

**做你自己的。** 向 chat 要一个插件，或用 `delorun plugin new` 开始一个（见[你的第一个插件](plugin-guides/first-plugin.zh.md)）。下面每个想法都是你写的插件，建立在今天已经存在的扩展点上：

- **添加一个推理服务。** 大多数服务不需要插件：在 studio 的设置中添加该端点及其模型，并在开销计量器的设置中添加其价格（见[价格](everyday-use/cost-meter.zh.md#prices)）。对于使用自己协议的服务，你的插件可以注册一个模型适配器，而每个安装它的人都能得到该服务，无需改动他们的其他提供方。
- **按你的方式选择模型。** 你的插件可以在消息框的模型槽位中添加自己的控件。要用一个按角色（例如规划者、构建者和审查者）选择的版本替换随附的选择器，请 fork 它（见[Fork 一个随附插件](customising/customise.zh.md#fork-a-shipped-plugin)）。
- **给每个仓库它自己的智能体。** `delorun plugin new --kind preset` 会开始一个注册智能体 preset 的插件：智能体起步时所用的工具、指令、skill 和模型（见[做一个智能体 preset](customising/customise.zh.md#make-an-agent-preset)）。
- **构建你一直想要的面板。** 你的插件可以添加侧栏面板、右侧栏中的一个标签页或一个设置页面：一份发布检查清单、你的部署状态、这个分支的工单。`--kind ui` 会以一个设置页面开始（见[为 Delorun 写一个插件](plugin-guides/plugins.zh.md)）。
- **让事件启动工作。** 你的插件可以注册一条规则：当收到一个已签名的 GitHub webhook 时，打开一个 chat 并发送它的第一条消息。它建立在 Delorun 可选的 Webhooks 插件之上，该插件是实验性的，其端点在你打开之前保持关闭（见[可选插件](customising/customise.zh.md#optional-plugins)）。
- **观察智能体做了什么。** 你的插件可以在一轮中的固定点监听，例如每一步之前，以及每次工具调用之前和之后，以便记录、检查或拒绝。

chat 也可以替你完成这些更改。它的插件工具在更改你的设置时会请求完全访问，而每一项更改都会被列出并且可以撤销（见[更改你的 harness](customising/changing-your-harness.zh.md)）。你也可以把一套设置保存为一个版本、回到较早的版本，或把它带到另一台电脑（见[把你的设置移到另一台电脑](customising/move-your-setup.zh.md)）。

许可证是 MIT。插件以 harness 自己的访问权限运行，而 Delorun 不对插件做沙箱隔离或审计，所以在安装之前请先读一读它（见[Delorun 不防范什么](safety-and-updates/safety.zh.md#what-delorun-does-not-protect-against)）。撤销涵盖 Delorun 和你的 chat，而不涵盖智能体在工作区中改动的文件，所以请把那些文件放在 git 中。随附插件的 fork 由你负责保持更新，而 Webhooks 插件是实验性的。

<a id="what-delorun-changes-from-deepseek-harness"></a>

## Delorun 相对 DeepSeek Harness 改变了什么

Delorun 构建在 DeepSeek Harness 之上，那是 DeepSeek AI 制作的开源智能体 harness。其作者构建智能体循环、模型提供方和插件系统，而 Delorun 在它们周围构建产品。Delorun 是独立的：它不是 DeepSeek 的产品，DeepSeek 也不为它背书（见[为什么 Delorun 构建在 DeepSeek Harness 之上？](help/questions.zh.md#why-is-delorun-built-on-deepseek-harness)）。

- **先被检查的安装：** 已签名的发布，在任何东西运行之前验证（见[安装与首次运行](get-started/install.zh.md#what-the-launcher-verifies)）。
- **更安全的默认值：** 设置时就开启同意，以及无法写入 Delorun 自己文件夹的命令（见[Delorun 保护什么](safety-and-updates/safety.zh.md)）。
- **你的手机：** 通过 Tailscale 使用 studio，每台设备都在你的电脑上批准（见[从手机访问 studio](everyday-use/reach.zh.md)）。
- **可以回退的更新：** 确认之前先给一份报告，然后自动回滚（见[回退](safety-and-updates/updates.zh.md#going-back)）。
- **可以撤销的更改：** `delorun changes` 与已保存的设置版本（见[更改你的 harness](customising/changing-your-harness.zh.md)）。
- **它自己的 studio：** 主题、侧栏、chat 状态和可搜索的设置，并有一个开关回到 stock 外观。
- **同时关注多个智能体：** 为 chat 交办过工作的智能体提供窗格（见[同时关注多个智能体](everyday-use/agents.zh.md#watch-several-agents-at-once)）。
- **可选附加功能：** [开销计量器](everyday-use/cost-meter.zh.md)与[思考标签页](everyday-use/thinking-tab.zh.md)。
- **隐私默认值：** DeepSeek Harness 的分析与会话日志上传在你打开之前保持关闭。
- **你的 chat 随你而来：** `delorun import-home` 从 DeepSeek Harness 复制它们（见[从 DeepSeek Harness 切换](get-started/switching.zh.md)）。

Delorun 还移除了 DeepSeek 的账户与 Platform 页面。[从 DeepSeek Harness 切换](get-started/switching.zh.md#what-stays-the-same-and-what-is-different)持有完整列表。

<a id="how-it-compares"></a>

## 它如何比较

于 2026-11-22 对照各厂商自己的页面核对。“未验证”表示那些页面没有说明。

| 工具 | 运行于 | 在手机上 | 模型 | 开源 | 安全控制 |
| --- | --- | --- | --- | --- | --- |
| Delorun | 任何浏览器中的 Web studio；Windows 桌面应用：预览中，尚未发布；其 home 在 Linux 与 WSL2 上 | 手机的浏览器，经由你自己的 Tailscale；从浏览器安装 | 首先 DeepSeek；其他提供方；任何兼容 OpenAI 的端点 | 是，MIT | 默认开启同意、沙箱、已签名发布、可回滚的更新 |
| DeepSeek Harness | 桌面应用（macOS、Windows）、终端、本地 Web UI | 未验证 | DeepSeek，以及其他提供方 | 是，MIT | 权限策略下的批准；默认值未验证 |
| T3 Code | 桌面应用、Web 应用、你自己的服务器 | iOS 与 Android 应用、托管 Web 应用 | 它所运行的那些智能体的模型 | 是，MIT | 四种权限模式，从完全访问开始；可选的每线程 git worktree |
| Claude Code | 终端、IDE 扩展、桌面应用、Web | Claude 手机应用，用于云会话与 Remote Control | Claude 模型 | 否 | 权限模式；系统沙箱可用，默认关闭；云会话在受管 VM 中 |
| Codex | 终端、IDE 扩展、桌面应用、Web | iOS；Android 未验证 | 默认 OpenAI 模型；其他提供方通过配置 | CLI 为 Apache-2.0；其余未说明 | 沙箱模式与批准策略；网络访问默认关闭 |
| Command Code | 终端、桌面应用 | 未验证 | 多家厂商，其中包括 DeepSeek、Qwen、Kimi 与 GLM | 未声明许可证 | 权限模式，由 Command Code 强制执行 |
| herdr | 终端、桌面应用 | iPhone、iPad 与 Android 应用 | 它所运行的那些智能体的模型 | 是，Apache-2.0 | 未验证 |

**DeepSeek Harness** 是 Delorun 所运行的 harness，其中一切都是插件。如果你想要其作者发布的那个 harness，或在 macOS 或原生 Windows 上工作，它适合你。Delorun 在它周围增加了产品。

**T3 Code** 是一个面向编程智能体的开源控制面：在桌面、Web 和手机上，从一个服务器为 Claude Code、Codex、Cursor、OpenCode 等提供一个界面。它适合运行多家厂商智能体的人，而且它有原生手机应用，Delorun 没有。两者都在你自己的机器上运行智能体。Delorun 是一个带有自己智能体和插件的 harness，手机通过其浏览器经由你自己的 Tailscale 网络访问它；而 T3 Code 提供它的应用或托管 Web 应用，通过 T3 Connect、局域网或 Tailscale 配对，或 SSH 连接。

**Claude Code** 是 Anthropic 面向 Claude 模型的智能体编程工具。它运行的地方比 Delorun 多：终端、IDE、桌面应用、Web，以及 Anthropic 机器上的云会话。Delorun 是开源的，可与任何提供方配合，而 Delorun 的 chat 可以把任务交给 Claude Code。

**Codex** 是 OpenAI 的编程智能体：一个本地运行的 CLI、一个 IDE 扩展、一个桌面应用和 Codex Web。它的沙箱以网络访问关闭开始，这比 Delorun 的默认值更严格，后者的网络设置以开放开始。Delorun 是一个你用插件重塑的 studio，而 Delorun 的 chat 也可以把任务交给 Codex。

**Command Code** 是一个学习你编程品味的编程智能体，带有 CLI 和桌面应用，并随附来自多家厂商的模型。它适合想要在终端智能体中获得这种学习的人。Delorun 的不同之处在于它的 MIT 许可证、它的插件，以及它在手机上的 studio。

**herdr** 是你已经在运行的那些编程智能体的运行时：它接管它们的终端而不是取代它们，提供终端界面、桌面应用和手机应用。它适合并排运行多个终端智能体的人。Delorun 是一个带有自己智能体、同意和沙箱的浏览器 studio。

<a id="when-another-tool-fits-better"></a>

## 什么时候另一个工具更合适

- **你只在一家厂商的模型中工作。** Claude Code 和 Codex 由制作那些模型的人制作。
- **你想要一个仅终端的工具或一个 IDE 扩展。** Delorun 两者都没有；Claude Code、Codex 和 Command Code 有。
- **你在 macOS 或原生 Windows 上工作。** Delorun 在 Linux 和 WSL2 上运行。
- **你想要一个原生手机应用。** T3 Code 和 herdr 有。
- **你需要外部安全审查或工具背后的团队。** Delorun 是一个只有一位维护者的预览版（见[有什么问题？](help/questions.zh.md#what-is-the-catch)）。
- **你对 stock DeepSeek Harness 加上你自己的插件很满意。** 你可能不需要 Delorun（见[为什么不在 stock 上只用插件？](help/questions.zh.md#why-not-just-plugins-on-stock)）。

<a id="try-it"></a>

## 试一试

```sh
npx delorun
```

该命令会下载 Delorun、检查它并提出几个设置问题；[安装与首次运行](get-started/install.zh.md)会带你走一遍。源码在 [github.com/twickas/delorun](https://github.com/twickas/delorun)。

<a id="next"></a>

## 下一步

- 来自 DeepSeek Harness：[从 DeepSeek Harness 切换](get-started/switching.zh.md)。
- 那些难回答的问题：[问题与答案](help/questions.zh.md)。
- 如果出了问题：[故障排查](help/troubleshooting.zh.md)与[已知问题](help/known-issues.zh.md)。

<a id="sources"></a>

## 来源

关于其他产品的每一项陈述都来自其厂商自己的页面，于 2026-11-22 阅读。产品会变化，所以在依赖某个单元格之前请核对链接。要更正本页，请写信至 support@delorun.com。

<details>
<summary>来源</summary>

- **DeepSeek Harness：** [仓库](https://github.com/deepseek-ai/deepseek-harness)与 [deepseek.com/harness](https://deepseek.com/harness)。
- **DeepSeek 的缓存与价格：** [上下文缓存](https://api-docs.deepseek.com/guides/kv_cache)与[模型与定价](https://api-docs.deepseek.com/quick_start/pricing)。非高峰时段，每百万输入 token：Flash 缓存 $0.003、未缓存 $0.15，Pro 缓存 $0.022、未缓存 $0.66。高峰价格翻倍，因此这些比例仍然成立。这些比例是本页基于那些价格所做的算术。
- **开放权重模型及其托管方：** [DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) 与 [DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813)（MIT）、[Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)（Apache-2.0）与 [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3)（Kimi K3 License）的模型卡。DeepSeek-V4.1-Flash 的托管方：[Together AI](https://www.together.ai/models/deepseek-v4-1-flash) 与 [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017)。
- **社区插件：** 每个项目自己的仓库，在指名它的地方链接；描述遵循各自的 README。
- **T3 Code：** [仓库](https://github.com/pingdotgg/t3code)、[t3.codes](https://t3.codes/)、[远程访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)与[权限模式](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)。
- **Claude Code：** [概览](https://code.claude.com/docs/en/overview)、[桌面](https://code.claude.com/docs/en/desktop)、[Web](https://code.claude.com/docs/en/claude-code-on-the-web)、[手机](https://code.claude.com/docs/en/mobile)、[模型路由](https://code.claude.com/docs/en/third-party-integrations)、[安全](https://code.claude.com/docs/en/security)、[沙箱](https://code.claude.com/docs/en/sandboxing)与[仓库](https://github.com/anthropics/claude-code)。
- **Codex：** [仓库](https://github.com/openai/codex)、[CLI](https://learn.chatgpt.com/docs/cli)、[IDE](https://learn.chatgpt.com/docs/ide)、[应用](https://learn.chatgpt.com/docs/app)、[云](https://learn.chatgpt.com/docs/cloud)、[配置](https://learn.chatgpt.com/docs/config-file/config-advanced)、[批准与安全](https://learn.chatgpt.com/docs/agent-approvals-security)与[沙箱](https://learn.chatgpt.com/docs/sandboxing)。
- **Command Code：** [commandcode.ai](https://commandcode.ai/)、[文档](https://commandcode.ai/docs)、[权限](https://commandcode.ai/docs/permissions)与[仓库](https://github.com/CommandCodeAI/command-code)，后者不含许可证文件。
- **herdr：** [herdr.dev](https://herdr.dev/)、[仓库](https://github.com/herdrdev/herdr)与[隐私](https://herdr.dev/privacy/)。

</details>
