---
description: "对 Delorun 那些难回答的问题的直接回答：为什么它构建在 DeepSeek Harness 之上，为什么它不是装在原版上的插件，大部分代码由 agent 编写意味着什么，它有多安全，以及代价是什么。"
---

# 问答

[English](questions.md) | 中文

> 本页是英文页面的模型翻译。如有出入，以英文页面为准。

## 摘要

本页回答一个谨慎的人在运行一个会在自己电脑上工作的工具之前会问的问题。回答以维护者的第一人称写成，指出 Delorun 的不足时与说明它的长处同样直白。你不需要任何前置知识。如果想了解某个回答背后的细节，每个回答都链接到负责该内容的页面。

## 目录

- [为什么 Delorun 构建在 DeepSeek Harness 之上？](#why-is-delorun-built-on-deepseek-harness)
- [为什么不直接在原版上装插件？](#why-not-just-plugins-on-stock)
- [大部分是 agent 写的。我为什么该信任它？](#agents-wrote-most-of-it-why-should-i-trust-that)
- [它有多安全？](#how-safe-is-it)
- [“撤销一切”涵盖什么？](#what-does-undo-everything-cover)
- [代价是什么？](#what-is-the-catch)
- [接下来去哪里？](#where-do-i-go-next)

<a id="why-is-delorun-built-on-deepseek-harness"></a>
## 为什么 Delorun 构建在 DeepSeek Harness 之上？

我想要一个可以按自己的工作方式塑造、并且改起来不用担心的 harness（智能体框架）。DeepSeek Harness 是我找到的最适合做这件事的基础：它里面的一切都是插件，所以几乎任何东西都可以改。它的作者解决技术问题，也就是 agent 循环、模型提供方和插件系统。我做的是另一半：围绕它的产品，包括 studio、默认设置、首次运行、更新和安全。

所以 Delorun 是它自己的产品，DeepSeek Harness 是它底下的技术，就像 Unix 之于 macOS。你的 DeepSeek Harness 插件能在 Delorun 上运行，它也能导入你的聊天，所以你可以向任何一个方向离开。Delorun 是独立的：它不是 DeepSeek 的产品，DeepSeek 也没有为它背书。

在别人的代码上构建是有代价的。上游每周都在变化，并且不接受外部 pull request，所以我要长期保留对它文件的改动，并亲自合并它的每个版本。我尽量用插件和 Delorun 自己的包来实现，以压低这个代价，并把每一处对上游文件的改动连同它所服务的功能一起记录下来（[差异索引](../../reference/parity-with-deepseek-harness/divergence/README.zh.md)）。

<a id="why-not-just-plugins-on-stock"></a>
## 为什么不直接在原版上装插件？

原版上的插件可以增加远程访问、侧边栏或主题，很多优秀的插件正是这样做的。插件做不到的，是改变整个 harness 的交付与保护方式。会展示自己将改动什么的签名更新、每次更新前保存的配置副本、一条让你回去的命令、安全模式，以及作用于整个 harness 的保护，需要的是一个发行版，而不是再多一个插件。

这就是 Delorun。你看到的东西只是其中较小的部分。如果你在原版上配合自己的插件用得很满意，你可能不需要 Delorun。如果你想要值得信任的更新和可以撤销的改动，[从 DeepSeek Harness 切换](../get-started/switching.zh.md)说明了哪些不同。

<a id="agents-wrote-most-of-it-why-should-i-trust-that"></a>
## 大部分是 agent 写的。我为什么该信任它？

因为每一项变更都要经历什么，而不是谁敲的键盘。我在这个项目上投入了很长时间，大部分实现由 agent 完成。每一项变更都要通过评审、移除保护就会失败的拒绝测试，以及回放真实会话的录制检查。只有测试证明了的保护才称为已强制执行。[安全基本原则](../../security/fundamentals.zh.md)列出每条规则，以及强制执行它的代码和证明它的测试。

同样属实的是，我自己没有读过每一行代码，项目之外也没有人评审过这些代码。这两点都是真实的局限。外部安全评审随 `1.0.0` 到来，在那之前 Delorun 是预览版（[使用 Delorun 时你要信任什么](../safety-and-updates/trust.zh.md)）。人写的代码并不自动更安全，我宁愿让你能核实我的说法，而不是只听我说：`delorun verify` 和拒绝测试就是为此而存在的。

<a id="how-safe-is-it"></a>
## 它有多安全？

比什么保护都没有就运行 agent 更安全，但还不足以让你运行一个你本来就不信任的 agent。默认情况下，聊天在做任何有风险的事之前会先询问。命令在沙箱中运行，沙箱限制文件写入，并且在你的系统支持的情况下，阻止命令读取 Delorun 的密钥。发布版本在运行之前会经过签名并被检查。

局限同样重要。命令以你自己的访问权限运行，沙箱不限制网络，除非你把它设为限制，而发布密钥是位于 agent 运行机器上的预览密钥。[Delorun 保护什么](../safety-and-updates/safety.zh.md)和[使用 Delorun 时你要信任什么](../safety-and-updates/trust.zh.md)对每一点都有准确说明。运行之前，请先阅读[安全说明](../../../../SAFETY.zh.md)。

<a id="what-does-undo-everything-cover"></a>
## “撤销一切”涵盖什么？

涵盖 harness 和你的聊天：你的配置、插件和设置都会恢复原样，失败的更新会自动回退。它不涵盖 agent 对工作区文件所做的事，因为工作区检查点尚未构建。请用 git 管理那些文件。

<a id="what-is-the-catch"></a>
## 代价是什么？

没有隐藏的代价，真实的代价是这些：

- **它是预览版。** 它在 Linux 上运行，也可通过 WSL2 在 Windows 上运行，还不是 macOS 或原生 Windows 的桌面应用。[已知问题](known-issues.zh.md)列出了毛边。
- **只有一个人在维护它。** 我会在能回复时回复，并且不承诺响应时间。如果我无法行动，发布版本会怎样，[治理](../../../../GOVERNANCE.md)里有说明。
- **它跟随一个变化很快的上游。** Delorun 可能随着时间推移与 DeepSeek Harness 产生差异。DeepSeek Harness 的插件和聊天数据保持兼容，而你在 studio 里看到的一切都是 Delorun 自己的。
- **它如何盈利。** Delorun 是 MIT 许可并且免费的，其中没有任何东西为付费而保留；从 `1.0.0` 起，团队可以为定制插件和集成付费，是否还会出售其他东西尚未决定，但如果出售，那也是一项服务，绝不会是被锁住的功能。（[路线图](../roadmap.zh.md#how-delorun-earns)）。

<a id="where-do-i-go-next"></a>
## 接下来去哪里？

想试用 Delorun，请阅读[安装与首次运行](../get-started/install.zh.md)。关于信任的细节，请阅读[使用 Delorun 时你要信任什么](../safety-and-updates/trust.zh.md)。想指出本页有什么问题，请在项目的 GitHub Discussions 中开一个帖子，或写信到 support@delorun.com。
