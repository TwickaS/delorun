---
description: "Delorun 为了什么、要去往哪里：以贴合为目标、现在正在构建什么、接下来是什么、再往后的方向、Delorun 如何盈利，以及不计划做什么。"
---

# 路线图

[English](roadmap.md) | 中文

> 本页是英文页面的模型翻译。如有出入，以英文页面为准。

## 摘要

本页是指南中唯一描述 Delorun 目前尚未做到之事的地方。它帮助你判断自己需要的东西是否在路上。你不需要任何前置知识。指南的其他页面都按 Delorun 现在的样子来描述。路线图分为三部分：“现在”是正在构建的内容，“接下来”是随后内容的计划顺序，“以后”是一份没有顺序的方向清单。它不含日期，也不含版本号，只有 `0.1.0` 和 `1.0.0` 这两个里程碑；计划会变，所以请把每一项当作意向，而不是承诺。

## 目录

- [Delorun 为了什么](#what-delorun-is-for)
- [现在](#now)
- [接下来](#next)
- [以后](#later)
- [Delorun 如何盈利](#how-delorun-earns)
- [不计划做什么](#not-planned)
- [关注进展](#follow-along)
- [接下来读什么](#what-to-read-next)

<a id="what-delorun-is-for"></a>
## Delorun 为了什么

Delorun 是一个按你自己的工作方式来塑造的 harness（智能体框架）。它的价值在于贴合：通过插件、模式和 studio，让 harness 适合你的工作方式，并且因为每一处改动都能撤销，你可以毫无顾虑地去改。它构建于 [DeepSeek Harness](../reference/glossary.zh.md#stock) 之上，能运行它的插件，也能导入你的聊天。

四个理念指引着构建的方向：

- **由你来改。** Delorun 在你的电脑上运行，不需要账号。它的设置、插件、预设、skill 和外观都由你来改，你所做的改动在更新后依然保留。
- **放心地改。** 更新前会先保存你的配置，失败的更新会自动回退，一条命令就能让你回到上一个版本（[更新](safety-and-updates/updates.zh.md#going-back)）。
- **对安全保持坦诚。** 只有测试证明了的保护才称为已强制执行，Delorun 缺少的功能会明确说明缺少。
- **可以访问，又不交出控制权。** 你可以用手机打开你的 studio，每台新设备都需要你在电脑上批准。

DeepSeek Harness 的插件和聊天保持兼容。一个人看到的一切，也就是 studio、默认设置和首次运行，都是 Delorun 自己的（[从 DeepSeek Harness 切换](get-started/switching.zh.md)）。

<a id="now"></a>
## 现在

正在构建的是 `0.1.0`，面向个人的首个非预览版本：从原版转来的人，以及初次接触的人。

- **预览版。** 预览版本通向 `0.1.0`：在 Linux 上、以及通过 WSL2 在 Windows 上运行的 Delorun，带有 Web studio，并可通过 Tailscale 用手机访问。
- **文字。** README、信任页、已知问题，以及对难回答问题的解答，让初次阅读的人不会迷路。
- **安全的发布流程。** 签名的发布版本、针对坏版本的书面预案，以及维护者对远程访问和更新链的安全评审。
- **可选遥测。** 随 `0.1.0` 到来：Delorun 自己的遥测，除非你说“是”否则关闭，在设置时询问并展示其确切内容，在公开环境中构建。预览版发布时上游的分析已关闭，也不含 Delorun 自己的遥测。

<a id="next"></a>
## 接下来

这是随后内容的计划顺序，而不是一组承诺。前一阶段就绪后，下一阶段才开始。

- **桌面应用。** macOS 和 Windows 覆盖了大多数开发者。它在 Windows 上管理 WSL2，与命令行共用一个 profile，并增加 macOS 的发布版本。
- **然后是带账号的免费中继。** 无需 Tailscale 即可访问：`your-name.delo.run` 形式的 studio 地址、一个 Delorun 账号，以及通过 Delorun 进行的设备批准。[Delorun 中继](../reference/glossary.zh.md#delorun-relay)转交它无法读取的加密流量，公布它的页面会准确说明 Delorun 能看到什么。它是免费的，每个账号在设备和流量上有合理使用上限。在此之前，[远程访问](../reference/glossary.zh.md#reach)是你自己的 tailnet 上的 Tailscale（[用手机访问 studio](everyday-use/reach.zh.md)）。
- **然后是额外的机器。** 在一个 studio 中，让聊天运行在笔记本、服务器或家用实验室的机器上。如果已有的 DeepSeek Harness 插件能胜任，Delorun 就采用它。
- **然后是 `1.0.0`，可供企业使用。** 桌面应用、中继和额外的机器都能工作，签名密钥在离线机器上的密钥仪式中生成，外部安全评审已经完成并公布了报告。

<a id="later"></a>
## 以后

方向，没有固定顺序。其中没有一项是承诺。

- **团队。** `1.0.0` 之后，维护者与第一家公司合作，按其工作来塑造 Delorun（[Delorun 如何盈利](#how-delorun-earns)）。
- **隔离。** Docker 工作区，也就是工作区的命令在容器中运行。
- **远程访问与登录。** 通过 Tailscale Funnel 或你自己域名上的中继访问，以及使用通行密钥或你自己的登录提供方登录（[每个远程访问选项向其提供方展示什么](safety-and-updates/trust.zh.md#what-each-reach-option-shows-its-provider)对它们做了比较）。
- **验证与插件。** 对隔离、暴露、登录、插件和数据共享的 `delorun verify` 检查；带有“已在 Delorun X 上测试”徽章的社区插件[索引](../reference/glossary.zh.md#catalogue)；可在安装插件前运行的可选插件安全评审；以及弹出插件同时在你的 profile 中保留其设置。
- **Studio。** Delorun 自己的手机侧边栏、覆盖你所有聊天的[活动历史](../reference/glossary.zh.md#activity-history)，以及实时系统状态面板。
- **你的数据。** 工作区检查点（它能让撤销覆盖 agent 改动过的文件），以及定时的本地和异地加密备份。
- **可分享的配置。** 一份配置就是普通文件；通过链接或图库分享它是一个方向。

<a id="how-delorun-earns"></a>
## Delorun 如何盈利

Delorun 是 MIT 许可并且免费的，其中没有任何东西为付费而保留；从 `1.0.0` 起，团队可以为定制插件和集成付费，是否还会出售其他东西尚未决定，但如果出售，那也是一项服务，绝不会是被锁住的功能。

你可以自己部署，任何人也可以为他人托管。所有人用的代码都是同一份。赞助者可以在 GitHub 上支持这个项目。Delorun 没有托管候补名单，因为托管尚未决定。

<a id="not-planned"></a>
## 不计划做什么

Delorun 不计划把其他 harness 当作产品来管理，不计划把一个聊天拆分到多台机器上，也不计划出售模型访问。

<a id="follow-along"></a>
## 关注进展

每个版本的说明都会写明改动了什么。delorun.com 上的订阅列表会为每篇重要文章和每个版本发送一条通知，不会更频繁。要建议或讨论某个方向，请使用项目 GitHub Discussions 中的 Ideas 分类，或写信到 support@delorun.com（[CONTRIBUTING.zh.md](../../../CONTRIBUTING.zh.md) 说明如何提出功能建议）。

<details>
<summary>进一步了解</summary>

- 阅读 [从 DeepSeek Harness 切换](get-started/switching.zh.md#what-stays-the-same-and-what-is-different)，了解每项缺失在今天的情况。
- 阅读[问答](help/questions.zh.md)，了解 Delorun 为什么是现在这样。

</details>

<a id="what-to-read-next"></a>
## 接下来读什么

要了解 Delorun 今天能做什么，请阅读 [从 DeepSeek Harness 切换](get-started/switching.zh.md)。要安装它，请阅读[安装与首次运行](get-started/install.zh.md)。
