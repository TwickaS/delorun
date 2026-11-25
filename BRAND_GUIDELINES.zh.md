# Delorun 品牌指南

[English](BRAND_GUIDELINES.md) | 中文

本指南说明如何书写 Delorun 的名称、如何使用它的标志与颜色、一个 fork 或插件可以如何称呼自己，以及 Delorun 如何称呼它的上游。颜色值来自 [`@delorun/brand`](delorun/packages/brand/README.zh.md)，那是它们的唯一来源。

## 名称

- 名称是 “Delorun”：一个词，大写 D，其余小写。
- 命令是 `delorun`，使用代码字体。
- 绝不写作下列形式：Never write "Delo", "Delo Run", "Delo-Run" or "DeloRun".
- “Delorun” 同时指产品、项目以及 delorun.com 上的托管服务。

## 标志与颜色

- 标志是六边形标志：一个取文本颜色的螺母和一个取品牌颜色的插头。请使用 `@delorun/brand` 中的文件与 `Mark` 组件；不要重绘它。
- 品牌颜色是桃色 `#E5734A`：填充、聚焦环和标志的插头。桃色填充上的文字是 `#111110`，因为白色在桃色上只能达到 3.05:1。
- 浅色页面上的链接和强调文字使用文本安全的桃色 `#B84A1B`，它在白色上达到 5.21:1。在深色页面上，桃色本身在 `#111110` 上达到 6.19:1。
- 正文使用 Schibsted Grotesk，代码使用 JetBrains Mono。

应当：

- 显示标志时，螺母用文本颜色，插头用桃色。
- 保持上述对比度比例。

不应：

- 拉伸、旋转、描边、改色或给标志添加效果。
- 在浅色页面上用桃色 `#E5734A` 排正文。
- 在自称是 Delorun 的材料中用相似字体替换这些字体。

## Fork 与插件

- 在插件或项目的描述中，“For Delorun” 和 “works with Delorun” 是可以的。
- fork 不得在其名称、命令、包作用域或图标中使用 “Delorun”，也不得看起来像官方的、经 Delorun 背书或授权的。
- 插件自己的名称和图标属于它自己；它们不使用 Delorun 的标志。

## 称呼上游

Delorun 是 DeepSeek Harness 的社区分支。Delorun 用真实的措辞说明这一点：“Built on DeepSeek Harness”、“Import from DSH”、“compared with DeepSeek Harness”。它绝不把 “DeepSeek Harness”、“DSH” 或 DeepSeek 自己的品牌材料用作 Delorun 名称的一部分或放在其中，它发布的任何内容也不暗示 DeepSeek 为 Delorun 背书、与它合作或授权它。

描述自己与 DeepSeek Harness 关系的项目，在该名称上遵循 [DeepSeek 自己的指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md)。
