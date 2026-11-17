---
description: "在 Delorun 一轮对话中的相同时间点，运行你 Claude Code 设置和 Codex hooks 文件里的 hooks，并加载 Claude Code mod。"
---

# @delorun/bundle-agent-hooks

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **Claude Code and Codex hooks**，即可运行你已为这两个工具写好的 hooks。Claude Code 桥接读取 `~/.claude/settings.json`，Codex 桥接读取 `~/.codex/hooks.json`，而带有提示框上方横条的 mod 桥接会加载 Claude Code mod。

你的 hook 文件由你自己负责：文件缺失时，对应的桥接不注册任何 hook，并记录一条警告。在你把 mod 加入你的 profile 之前，mod 桥接不会加载任何 mod。Hooks 会运行你的命令，所以开启之前请先阅读这些文件。它是实验性的。

## 需要设置

- 需要你自己的 ~/.claude/settings.json 或 ~/.codex/hooks.json；文件缺失时不注册任何 hook。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
