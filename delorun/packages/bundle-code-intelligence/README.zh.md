---
description: "让智能体向语言服务器查询定义、引用和悬停信息。需要在你的 PATH 上有 typescript-language-server。"
---

# @delorun/bundle-code-intelligence

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **代码智能**，即可给智能体一个只读的 `lsp` 工具：跳转到定义、查找引用、查找实现和悬停信息。

此 bundle 使用的是你自己的语言服务器，而不是它自带的。它为 JavaScript 和 TypeScript 文件启动服务器 `typescript-language-server --stdio`，这些行起初是关闭的；在 `typescript-language-server` 位于你的 PATH 上之前，“插件”会显示“需要设置”。要添加其他语言或服务器，请在你 profile 的 `cordis.patch.yml` 中替换 `lsp-stdio` 行的 `config`，并重新写出你要保留的服务器。

## 需要设置

- 需要你的 PATH 上有 typescript-language-server（或你配置的其他语言服务器）；没有它时工具保持关闭。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
