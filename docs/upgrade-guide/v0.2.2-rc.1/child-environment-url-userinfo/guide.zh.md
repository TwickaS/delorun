---
kind: upgrade-guide
description: "子进程不再继承值中含有任何用户信息（包括仅有用户名）的 URL 的变量，也不再继承新拒绝的凭据名。"
---

# 子进程不再继承带用户信息的 URL

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subprocess` 中的 `scrubbedParentEnv()` 决定子进程继承 harness 自身的哪些环境变量：shell 命令、MCP stdio 服务器、语言服务器与子智能体 CLI。以前，只有 `scheme://user:secret@` 形式的 URL 用户信息才会让变量被丢弃。现在 `scheme://` 之后的任何用户信息都会让变量被丢弃，包括仅有用户名的情况，因为该位置上的 token 无法与登录名区分：`https://<token>@host`、`redis://:<password>@host`、Sentry DSN、`ssh://git@host/repo` 与 `postgres://user@db/app` 都不再被继承。scp 风格的 `git@host:org/repo` 没有 scheme，仍会被继承；`@` 位于查询或片段中的 URL 也仍会被继承。

名称 `KUBECONFIG`、`KRB5CCNAME`、`*_CREDENTIALS`、`*PASSPHRASE*` 与 `MYSQL_PWD` 也不再被继承。`*PATH` 搜索列表（例如 `PATH` 或 `PYTHONPATH`）现在只去掉指向凭据文件或代理套接字的元素，而以前这样的元素会让整个变量被丢弃。

受影响的是命令、MCP 服务器或其他子进程依赖于从启动 harness 的环境中继承这些变量的工作流。

## 迁移

1. 在配置子进程的位置显式传入该值：MCP 服务器行的 `env`、子智能体或语言服务器行的 `env`，或命令本身，例如 `DATABASE_URL=postgres://user@db/app psql`。显式的 `env` 条目在清理之后合并，原样到达子进程。
2. 在工具支持的情况下，优先使用不含用户信息的 URL，另以子进程读取的单独凭据变量传递凭据。
3. 在子进程中打印该变量以确认，例如通过 shell 工具执行 `printenv DATABASE_URL`：它打印出你传入的值。
