---
description: "Delorun 运行时发行包的根包：上游的运行时发行包、delorun 命令与 Delorun 的包，由发布配方部署。"
---

# @delorun/runtime-closure

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

此包不含代码。它的依赖就是一个 Delorun 运行时发行包所安装的内容：上游的 `dsh-python-runtime-closure`（其依赖为 `dsh` 命令及其所发布 profile 加载的每个插件），以及 [`@delorun/cli`](../cli/README.zh.md)，即 `delorun` 命令及 Delorun 的包。[`@delorun/release`](../release/README.zh.md#runtime-closures) 中的发布配方为每个平台部署它。
