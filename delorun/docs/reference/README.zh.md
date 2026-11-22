---
description: "Delorun 开发者参考资料索引：面向所有人的、用平实英语写成的术语表，以及面向开发者和维护者的差异台账、对等清单、对等基线和 harness 反馈日志页面。"
---

# Delorun 开发者参考资料

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

开发者参考资料用于查阅 Delorun 是如何构建和检查的。其中的术语表面向所有人；其他页面面向开发者和维护者。如果你想学习如何使用 Delorun，请改读[用户指南](../guide/README.zh.md)。

## 面向所有人

[术语表](glossary.zh.md)定义 Delorun 的指南、界面和拉取请求所用的词。每个条目以一句平实的英语开头，再在有帮助之处补充技术细节。当指南用到某个你不认识的词时，请在这里查阅。术语表扩展了上游的[术语表](../../../docs/glossary.zh.md)，后者定义 DeepSeek Harness（Delorun 所派生的项目）的术语。

## 面向开发者和维护者

这些页面假定你在做 Delorun 的代码，或在做上游发布的合并。

- [差异索引](parity-with-deepseek-harness/divergence/README.zh.md)回答 Delorun 更改了哪些上游文件以及为什么。它定义这些更改的台账、它们的类别和差异预算。
- [对等清单](parity-with-deepseek-harness/parity.zh.md)回答 Delorun 在某个领域是否与 stock DeepSeek Harness（DSH）行为一致，以及有什么证据。它在上游标签 `dsh-v0.2.2-rc.1` 上，记录 Delorun 刻意差异的状态以及与之对照的 stock 领域的状态。
- [对等基线](parity-with-deepseek-harness/parity-baseline.zh.md)回答上游自身的哪些测试在 Delorun 的参考主机上于该标签通过。它记录两轮运行、一次 Node 24 核对、每项失败的分类，以及这些结果所依赖的环境和主机状态。
- [harness 反馈日志](harness-feedback.zh.md)回答维护者在这个仓库中工作时遇到了哪些问题，以及应当改做什么。每个条目都有状态。
