---
description: "Delo 运行时发行包的根包：上游的运行时发行包、delorun 命令与 Delo 的包，由发布配方部署。"
---

# @delo/runtime-closure

[English](README.md) | 中文

## 摘要

此包不含代码。它的依赖就是一个 Delo 运行时发行包所安装的内容：上游的 `dsh-python-runtime-closure`（其依赖为 `dsh` 命令及其所发布 profile 加载的每个插件），以及 [`@delo/cli`](../cli/README.zh.md)，即 `delorun` 命令及 Delo 的包。[`@delo/release`](../release/README.zh.md#runtime-closures) 中的发布配方为每个平台部署它。
