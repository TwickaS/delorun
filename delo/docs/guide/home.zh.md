---
description: "你的 Delo home：delorun 在哪里保存你的数据，如何用 DELO_HOME 迁移它，CLI profile，为何 ~/.dsh 保持不动，以及如何修复其他用户可以读取的 home 或密钥文件。"
---

# 你的 Delo home

[English](home.md) | 中文

## 摘要

Delo 把它所知道的关于你的一切都保存在一个目录中，即你的 home：`~/.delo`，Windows 上为 `%USERPROFILE%\.delo`。你的 profile、会话、工作区、凭据，以及 Delo 自己的密钥与记录，都保存在其中。`delorun` 命令在首次运行时创建 home，并将其设置为只有你能打开。

## 目录

- [home 的位置](#where-the-home-is)
- [首次运行](#the-first-run)
- [Profile](#profiles)
- [你的 DeepSeek Harness home](#your-deepseek-harness-home)
- [修复权限](#fixing-permissions)

<a id="where-the-home-is"></a>

## home 的位置

设置 `DELO_HOME` 可将 home 保存到别处，例如 `DELO_HOME=~/work/delo delorun`。路径必须是绝对路径，或以 `~` 开头。`delorun` 会拒绝你的用户主目录本身、文件系统根目录，以及 DeepSeek Harness 自己的 home `~/.dsh` 或其中的任何目录。`delorun status` 会打印它所使用的 home。

<a id="the-first-run"></a>

## 首次运行

在新 home 上首次运行 `delorun` 会运行 setup，它创建 CLI profile。此后，`delorun` 会在你的终端中启动 Delo，并在浏览器中打开 studio；按 Ctrl-C 即可停止。`delorun start` 会在后台启动 Delo，因此你可以关闭终端；`delorun start --foreground` 则在你的终端中运行它。两者都不打开浏览器。`delorun status` 显示 Delo 是否在运行、其进程与运行时版本；`delorun stop` 会在运行中的 chat 结束后停止它，使用 `delorun stop --now` 则立即停止。每个 profile 只运行一个 Delo：第二次启动会提示已有一个 Delo 在运行。

<a id="profiles"></a>

## Profile

命令行使用 profile `default`。设置 `DELO_PROFILE`，或传入 `--profile <name>`，即可使用其他 profile。桌面应用保有自己的 profile `desktop`，`delorun` 拒绝运行或修改它。两者共享你的会话、工作区与凭据。

<a id="your-deepseek-harness-home"></a>

## 你的 DeepSeek Harness home

Delo 从不读取、修改或移动 `~/.dsh`。如果你为 DeepSeek Harness 设置了 `DSH_HOME`，`delorun` 会忽略它并使用你的 Delo home，`delorun status` 会告诉你这一点。`delorun plugin` 与 `delorun headless` 的行为与 `dsh plugin` 和 `dsh headless` 相同，只是在你的 Delo home 内运行。

<a id="fixing-permissions"></a>

## 修复权限

你的 home 及其中 Delo 的目录只有你能读取（模式 700），Delo 的密钥文件也只有你能读取（模式 600）。如果其他用户能够读取其中之一，Delo 会拒绝使用它，并打印修复它的命令，例如：

```text
delorun: SECRET_FILE_MODE: /home/you/.delo/secrets/home-auth/device.key has mode 0640, which other users can read; it must be 0600; fix it with: chmod 600 /home/you/.delo/secrets/home-auth/device.key
```

运行打印出的 `chmod 700` 或 `chmod 600` 命令，然后再次运行 `delorun`。Delo 从不替你更改这些权限。在 Windows 上，Delo 目前尚不检查它们。
