---
description: "让智能体把任务交给你已安装的 Codex 或 Claude Code 程序，并在工具程序中运行 Python 代码。"
---

# @delorun/bundle-external-agents

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **外部智能体**，即可让智能体通过 `subagent_oar` 工具，把一项独立的任务交给这台电脑上已安装的 Codex 或 Claude Code 程序。它们各自使用你自己的登录状态（`~/.codex`、`~/.claude`），而不是 Delorun 的，权限设置则固定在此 bundle 的行中。

每一行起初都是关闭的。当某一行的程序不在你的 PATH 上时，“插件”会显示“需要设置”及原因，例如“Needs codex installed”；你开启的一行只会列出 studio 启动时已存在的程序。此 bundle 还为工具程序增加了一个 Python 运行时，它需要你的 PATH 上有 `python3`（CPython 3.10 或更新），并且在 Windows 上不可用。它是实验性的。

## 需要设置

- 每一行都需要它自己的程序位于你的 PATH 上：Codex 需要 `codex`，Claude Code 需要 `claude`，委派工具需要其中任意一个，Python 运行时需要 `python3`（Windows 上没有）。“插件”会显示缺少什么以及如何安装；你还需要已登录该程序。等某一行的“需要设置”提示消失后，再开启它。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
