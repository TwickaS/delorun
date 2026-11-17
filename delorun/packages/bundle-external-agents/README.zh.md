---
description: "让智能体把任务交给你已安装的 Codex 或 Claude Code 程序，并在工具程序中运行 Python 代码。"
---

# @delorun/bundle-external-agents

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **External agents**，即可让智能体通过 `subagent_oar` 工具，把一项独立的任务交给这台电脑上已安装的 Codex 或 Claude Code 程序。它们各自使用你自己的登录状态（`~/.codex`、`~/.claude`），而不是 Delorun 的，权限设置则固定在此 bundle 的行中。

不在你 PATH 上的程序会被略去；两者都没有时，该工具不会挂载，因此开启此 bundle 永远不会失败。此 bundle 还为工具程序增加了一个 Python 运行时，它需要你的 PATH 上有 `python3`（CPython 3.10 或更新），并且在 Windows 上不可用。它是实验性的。

## 需要设置

- 需要已安装并已登录的 Codex 或 Claude Code 程序；Python 运行时需要 python3。缺少的一项会被略去。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
