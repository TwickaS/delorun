---
description: "Delorun 用户指南，按你想做的事组织成一张地图：安装与首次运行、从 stock DeepSeek Harness 切换、日常使用、模型提供方、成本计量器、更新、用手机访问 studio、定制 Delorun 及其改动、安全与信任，以及故障排查。"
---

# Delorun 用户指南

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

用户指南面向安装并使用 Delorun 的人。Delorun 是一个可以按你自己的工作来塑造的 agent harness，构建在 DeepSeek Harness 之上；无论你对两者都是新手，还是从 stock DeepSeek Harness 切换而来，都适用。Delorun 运行在你自己的电脑上。本页是一张地图：找到你想做的事，再沿链接进入对应的页面与章节。技术术语会链接到[术语表](../reference/glossary.zh.md)。

If you are new, these three pages are the whole path to a working Delorun:

1. [Install and first run](get-started/install.zh.md): one command, a few questions and your first chat.
2. [Model providers](get-started/providers.zh.md): the key for the model you want to use.
3. [Daily use](everyday-use/daily-use.zh.md): start, open and stop Delorun, and choose what the model may change.

The rest of this page is for when you need it.

## 目录

- [我想开始使用](#i-want-to-get-started)
- [我想每天使用它](#i-want-to-use-it-every-day)
- [我想选择或更换模型](#i-want-to-choose-or-change-the-model)
- [我想用手机访问它](#i-want-to-reach-it-from-my-phone)
- [我想把它变成我自己的](#i-want-to-make-it-mine)
- [我想知道什么是安全的](#i-want-to-know-what-is-safe)
- [出了问题](#something-went-wrong)
- [给想深入了解的人](#for-the-technically-curious)

<a id="i-want-to-get-started"></a>

## 我想开始使用

- **Decide whether Delorun suits me, and how it compares with other tools:** [Why Delorun](why-delorun.zh.md). It covers what you get, what Delorun changes from DeepSeek Harness and when another tool fits better.
- **安装 Delorun 并进行第一次 chat：**[安装与首次运行](get-started/install.zh.md)。它涵盖你需要先准备什么、[按使用方式进行 setup](get-started/install.zh.md#setup-a-few-questions)、[studio 与你的第一次 chat](get-started/install.zh.md#the-studio-and-your-first-chat)，以及[没有浏览器的电脑](get-started/install.zh.md#a-computer-without-a-browser)。
- **带上我的 DeepSeek Harness chat：**[从 DeepSeek Harness 切换](get-started/switching.zh.md)。它说明哪些保持不变、哪些不同，哪些内容会被复制、哪些会留在原处，以及[如何切换回去](get-started/switching.zh.md#going-back)。
- **Find out whether it is safe and what the catch is:** [Questions and answers](help/questions.zh.md).

<a id="i-want-to-use-it-every-day"></a>

## 我想每天使用它

- **启动、打开、停止或检查 Delorun：**[启动、打开与停止](everyday-use/daily-use.zh.md#start-open-and-stop)和[检查发布版本与你的设置](everyday-use/daily-use.zh.md#check-the-release-and-your-setup)。
- **决定模型在某个文件夹里可以改动什么：**[工作区与模型可以改动的内容](everyday-use/daily-use.zh.md#workspaces-and-what-the-model-may-change)。
- **从阻止 Delorun 启动的插件中恢复：**[安全模式与恢复](everyday-use/daily-use.zh.md#safe-mode-and-recovery)。
- **恢复已删除的 chat，或在不同 home 之间移动 chat：**[回收站、导出与导入](everyday-use/daily-use.zh.md#trash-export-and-import)。
- **升级到新的发布版本，或回退：**[更新](safety-and-updates/updates.zh.md)和[回退](safety-and-updates/updates.zh.md#going-back)。
- **我运行了很多第三方插件时如何更新：**[在有大量插件时更新 Delorun](plugin-guides/updating-with-plugins.zh.md)。它涵盖先保存了什么、如何阅读报告中的 `disabled` 行、如何用版本豁免强行尝试某个插件，以及如何回退。
- **把我的插件、模型选择与设置迁移到另一台电脑：**[迁移你的 setup](customising/move-your-setup.zh.md)说明文件包含与绝不包含什么、导入会替换什么，以及如何撤销。
- **找到我的数据在哪里、移动它，或使用两个 profile：**[你的 Delorun home](customising/home.zh.md)。
- **找出某件事为何失败：**[Delorun 的日志存放在哪里](help/logs.zh.md)。
- **带上我在 DeepSeek 网站上的 chat：**[导入你的 DeepSeek 网站 chat](get-started/import-deepseek-chats.zh.md)。
- **查看一次 chat 花了多少钱：**[查看一次 chat 的花费](everyday-use/cost-meter.zh.md)。
- **让智能体以我的登录状态在我自己的 Chrome 中操作：**[使用你自己的浏览器](everyday-use/use-your-own-browser.zh.md)。
- **逐字阅读模型的思考过程：**[逐字阅读模型的思考过程](everyday-use/thinking-tab.zh.md)。
- **Hand a task to Claude Code or Codex from a chat:** [Hand work to Claude Code or Codex](everyday-use/agents.zh.md).

<a id="i-want-to-choose-or-change-the-model"></a>

## 我想选择或更换模型

- **选择提供方和密钥，或在我自己的电脑上运行模型：**[模型提供方](get-started/providers.zh.md)。它列出 setup 支持的每家提供方，以及如何[之后更换提供方](get-started/providers.zh.md#change-the-provider-later)。

<a id="i-want-to-reach-it-from-my-phone"></a>

## 我想用手机访问它

- **开启远程访问、批准设备或移除设备：**[用手机访问 studio](everyday-use/reach.zh.md)。

<a id="i-want-to-make-it-mine"></a>

## 我想把它变成我自己的

- **选择修改 Delorun 的合适方式：**[什么该在哪里定制](customising/customise.zh.md)比较了设置、profile 补丁、agent 预设、你自己的插件、已发布插件的改名 fork，以及直接编辑 Delorun 本身，并说明每种方式在每次更新时会让你付出什么。
- **做出第一个插件并在 studio 中看到它：**[你的第一个插件](plugin-guides/first-plugin.zh.md)构建一个插件，在 Plugins 下展示它，然后再移除它。
- **编写插件：**[为 Delorun 编写插件](plugin-guides/plugins.zh.md)从 `delorun plugin new` 讲到一个能在你的 studio 中加载的插件。
- **查看、保护或撤销改动：**[修改你的 harness](customising/changing-your-harness.zh.md)说明 `delorun changes` 记录什么、如何保护，以及如何撤销。

<a id="i-want-to-know-what-is-safe"></a>

## 我想知道什么是安全的

- **了解沙箱、完全访问与各项同意：**[Delorun 保护什么](safety-and-updates/safety.zh.md)。
- **了解提示词注入以及什么会离开我的电脑：**[提示词注入与数据外泄](safety-and-updates/prompt-injection.zh.md)。
- **了解我使用 Delorun 时信任什么：**[你使用 Delorun 时信任什么](safety-and-updates/trust.zh.md)。

<a id="something-went-wrong"></a>

## 出了问题

- **看不懂的消息或代码：**[故障排查](help/troubleshooting.zh.md)。它解释[如何读懂一次拒绝](help/troubleshooting.zh.md#reading-a-refusal)，并按代码列出常见情况及修复办法。
- **Delorun 无法启动：**[启动与停止](help/troubleshooting.zh.md#starting-and-stopping)，然后运行 `delorun doctor`（见[日常使用](everyday-use/daily-use.zh.md#check-the-release-and-your-setup)）。
- **更新失败：**[更新与回退](help/troubleshooting.zh.md#updates-and-rollback)。
- **Check whether it is a known problem:** [Known issues](help/known-issues.zh.md) lists the rough edges of this preview, each with what to do.

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

这些页面描述的是你看到的和你要做的。[Delorun 文档索引](../README.zh.md)通向定义确切规则的约定、设计和威胁模型；每个指南页面的末尾都链接到它所依赖的那些文档。

The [Roadmap](roadmap.zh.md) says what is being built now, what comes next and what comes later, and the [changelog](https://docs.delorun.com/changelog) lists what changed in each version.
