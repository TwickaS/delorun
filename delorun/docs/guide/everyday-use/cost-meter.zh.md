---
description: "查看一次 chat 花了多少钱：如何开启成本计量器，如何阅读输入框下方的数字及其明细，价格如何设定与覆盖，以及这个估算没有计入什么。"
---

# 查看一次 chat 的花费

[English](cost-meter.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页介绍如何在输入框下方查看一次 [chat](../../reference/glossary.zh.md#chat) 已花费金额的估算。如果你按用量向提供方付费，并想知道哪些 chat 花钱多，它会有帮助。你需要先让 Delorun 带着一家模型提供方运行起来（见[模型提供方](../get-started/providers.zh.md)）。术语表介绍了[成本计量器](../../reference/glossary.zh.md#cost-meter)。计量器在你开启之前是关闭的，并且它自己不发出任何请求：它只是把提供方已经报告的用量加起来。

## 目录

- [开启它](#turn-it-on)
- [它显示什么](#what-it-shows)
- [价格](#prices)
- [它没有计入什么](#what-it-does-not-count)
- [接下来](#next)

<a id="turn-it-on"></a>

## 开启它

在侧边栏打开“插件”，然后打开 **Delorun studio**。在 Components 下找到 **Cost meter** 并开启；它会立即启动，无需重启。你应该会在每个 chat 的输入框下方、token 数之后看到一个数字。

新手引导的“推荐插件”步骤提供同样的开关。

<a id="what-it-shows"></a>

## 它显示什么

这个框显示本次 chat 的花费，例如 `$0.42`。当一个 chat 启动了 subagent 或队友时，它会显示两个数字，`$0.42 · $0.61 with agents`：先是仅这个 chat，然后是这个 chat 连同它所启动的 chat。

选中它可以查看明细：每个模型一行，列出其请求数、token 数和费用。每一行可以展开为输入、缓存写入、缓存读取和输出 token。有 agent 参与时，最先是本 chat 的一行，然后是它所启动的每个 agent 各一行，按费用从高到低排列。

这个数字是估算值。价格表中没有价格的请求会被如实列为无价格，而不是猜一个价格。

<a id="prices"></a>

## 价格

价格随 Delorun 一起提供，并在准备发布版本时对照各家提供方公布的价格进行核对。长提示词和 DeepSeek 的高峰时段，按各提供方的方式计价。计算过程中没有任何东西离开你的电脑。

<details>
<summary>边界情况</summary>

- 如果某个 chat 运行了价格表中没有的模型，那么明细会把它的请求列为无价格，并说明这一点。
- 如果这个数字与你的账单不同，请查看[它没有计入什么](#what-it-does-not-count)。以账单为准。
- 如果某个价格在你的发布版本之后发生了变化，请按“进一步了解”中的说明覆盖它。
- 如果你重新加载、恢复或 fork 一个 chat，那么总额不变，因为它是根据 chat 已保存的历史记录算出的。
- 如果你关闭计量器，那么这个数字会消失。你的 chat 保留其历史记录。
- 如果你提供给插件的设置格式有误，那么插件会在加载时停止。请修正或删除这些设置。

</details>

<details>
<summary>进一步了解</summary>

插件设置中 `prices` 下的一个条目，会替换价格表中该模型的条目，或添加一个模型。每个条目指定一个 `model`（模型 id 的前缀；匹配最长的前缀优先）和四个费率，单位为每百万 token 的美元数：`input`、`output`、`cacheRead` 和 `cacheWrite`。添加 `provider` 可将该条目限制于一家提供方，添加 `longContext` 可为超过某个提示词大小的情况设置更高的费率，添加 `peak` 可为提供方的繁忙时段设置费率。[修改你的 harness](../customising/changing-your-harness.zh.md)说明了插件设置存放在哪里，以及如何撤销更改。

</details>

<a id="what-it-does-not-count"></a>

## 它没有计入什么

计量器只累计它在这个 studio 中能看到的 chat。它不计入：

- **外部 agent。**Claude Code、Codex 和其他外部 agent 作为它们自己的程序在 studio 之外运行，所以它们的用量不计入。使用它们的 chat 会显示一条提示，例如 “2 external agents run outside this studio and are not counted.”
- **批量价格。**有些提供方对以较慢的批量方式发送的请求收费较低。
- **快速模式。**有些提供方对模型的更快模式收费较高。
- **一小时缓存写入。**有些提供方对把缓存的提示词保留一小时（而不是默认的较短时间）收费较高。
- 提供方给你的账户的**折扣**。
- **中国公共假日。**DeepSeek 的繁忙时段价格按以 UTC 表示的工作日时间表计算，计量器不会针对中国公共假日调整这份时间表。

<a id="next"></a>

## 接下来

- 开始 chat：[日常使用](daily-use.zh.md)。
- 选择更便宜的或其他的模型：[模型提供方](../get-started/providers.zh.md)。
