---
description: "delorun 命令：它如何按约定 C1 的模式解析并创建 ~/.delo home，拒绝更宽松的文件，选择 CLI profile，获取 home 锁，把新 home 交给 setup，并运行上游的 profile 命令。"
---

# @delo/cli

[English](README.md) | 中文

## 摘要

本应用即 `delorun` 命令。它解析 Delo home，以 0700 模式创建 home 及其中 Delo 的条目，拒绝其他用户可以访问的 home 或受保护文件，选择 CLI profile，并通过上游的 profile 运行器运行该 profile，同时把 Delo home 作为 `DSH_HOME`。新 home 先交给 setup 的入口。一次启动会获取该 profile 的 home 锁，因此每个 profile 只运行一个 home 进程。[约定 C1](../../docs/contracts/c01-home-layout.zh.md) 定义 home，[`@delo/contract-home-layout`](../../packages/contract-home-layout/README.zh.md) 包提供其名称与限额。

## 目录

- [命令](#commands)
- [home](#the-home)
- [Profile](#profiles)
- [home 锁](#the-home-lock)
- [delorun 如何运行上游](#how-delorun-runs-upstream)
- [扩展点](#extension-points)
- [尚未实现](#not-yet-implemented)
- [开发](#development)

<a id="commands"></a>

## 命令

| 命令 | 作用 |
| --- | --- |
| `delorun [--profile <name>]` | 若 home 上还没有 CLI profile，则运行 setup；否则在此终端中启动 home 进程并打开 studio |
| `delorun setup [--profile <name>]` | setup 的入口：创建 CLI profile，已存在的 profile 保持不变 |
| `delorun start --foreground [--profile <name>]` | 在此终端中启动 home 进程，但不打开 studio |
| `delorun status [--profile <name>]` | 打印 home、profile、其 home 进程是否在运行，以及 `delorun` 忽略的、已继承的 `DSH_HOME` |
| `delorun plugin …` | 上游的 `dsh plugin …`，不作改动，针对 Delo home 运行 |
| `delorun headless …` | 上游的 `dsh headless …`，不作改动，针对 Delo home 运行 |

退出码：0 表示完成，1 表示失败，2 表示命令行错误，3 表示该 profile 没有 home 进程在运行（`status`）。失败时，标准错误输出一行，以 C1 的错误代码开头，例如 `HOME_MODE`，并在存在修复命令时以该命令结尾。

<a id="the-home"></a>

## home

- **解析。** 当 `DELO_HOME` 已设置且非空白时，home 即为它，否则为 `~/.delo`（Windows 上为 `%USERPROFILE%\.delo`）。开头的 `~` 展开为操作系统的用户主目录。相对路径、文件系统根目录与操作系统的用户主目录会以 `HOME_INVALID` 被拒绝；上游的 `~/.dsh`、其中的路径以及指向二者的链接会以 `HOME_IS_DSH_HOME` 被拒绝。
- **`DSH_HOME`。** 在任何上游代码运行之前，`delorun` 会把 `DSH_HOME` 与 `DELO_HOME` 设为该 home，把 `DELO_PROFILE` 设为该 profile，因此上游、其 `.env` 层以及每个子进程都使用 Delo home。已继承的 `DSH_HOME` 会被忽略，`delorun status` 会将其指出。
- **`~/.dsh`。** `delorun` 从不读取、写入或迁移上游的 home。
- **目录树。** 除 `status` 外，每个命令都会通过带该模式的 `mkdir`，以 0700 模式创建 home、Delo 的顶层条目（`runtimes/`、`staging/`、`trust/`、`status/`、`catalogue/`、`secrets/`、`run/`、`supervisor/`、`bin/`、`alerts/`）以及 `run/<profile>/`，因此 umask 只能收窄该模式。上游的条目，例如 `profiles/` 与 `sessions/`，保持上游的布局与模式。
- **目录拒绝。** 当 home、`secrets/` 或 `run/<profile>/` 中任一项是符号链接、属于其他用户，或设置了组或其他用户的权限位时，它会以 `HOME_MODE` 被拒绝；错误信息给出路径与修复命令 `chmod 700 <path>`。`delorun` 自身不修改任何权限。
- **受保护文件。** `writeProtectedFile` 以 0600 模式写入文件：先通过以该模式独占创建的同目录临时文件写入，再重命名覆盖目标路径。`readProtectedFile` 遇到符号链接、非常规文件、属于其他用户的文件，或设置了组或其他用户权限位的文件时，会以 `SECRET_FILE_MODE` 拒绝读取，并给出修复命令 `chmod 600 <path>`；它在打开文件之前检查路径，打开之后再次检查打开的文件，因此中途被替换的文件同样会被拒绝。在 `secrets/`、`trust/`、`status/` 与 `catalogue/` 下保存文件的组件，使用 `src/home/protected-file.ts` 中的这两个函数。

<a id="profiles"></a>

## Profile

CLI profile 为 `default`，或由 `DELO_PROFILE` 或 `--profile` 选定的名称，遵循上游的 profile 命名规则。桌面应用的 `desktop` profile 无论字母大小写如何，都会以用法退出码被拒绝；`delorun plugin --profile desktop` 也会被上游自身的解析器拒绝。因此 `delorun` 从不运行、初始化或修改 `profiles/desktop/` 或其锁。setup 的入口从上游的 `web` profile 模板创建 CLI profile，该模板的 Web 应用提供 studio。

<a id="the-home-lock"></a>

## home 锁

一次启动会在引导该 profile 之前获取 `run/<profile>/home.lock`，并持有至进程退出。该锁以 0600 模式保存 C1 的 JSON 记录（`v`、`pid`、`startId`、`runtime`、`startedAt`）。记录先写入临时文件，再硬链接到锁路径，因此锁要么完整出现，要么完全不出现；两次同时启动时，只有一个链接会成功。进程已不存在的锁会被移开并替换；仍存活的持有者绝不会被接管，第二次启动会打印正在运行的进程并以 0 退出，与 C19 的 `delorun start` 相同。进程退出时，若仍持有自己的记录，则删除该锁。被 `SIGKILL` 杀死的进程会留下该锁，下一次启动会将其替换。

在更新通道存在之前，仍存活的持有者无法被询问状态，并被视为已响应，因此不会报告 `HOME_UNRESPONSIVE`；`acquireHomeLock` 以参数形式接收在 `HOME_RUNNING` 与 `HOME_UNRESPONSIVE` 之间作出决定的探测。当同一 profile 的三次启动在相同的少数系统调用内竞争同一个陈旧锁时，其新锁被另一次启动移开的那次启动，可能在没有锁文件的情况下继续运行。

<a id="how-delorun-runs-upstream"></a>

## delorun 如何运行上游

`delorun` 只通过上游的 profile 运行器启动应用，这是根目录 `AGENTS.md` 的要求。一次启动以 CLI profile 调用 `@deepseek-ai/dsh/profile-boot` 中的上游 `runProfile`，与桌面 Host 为其 profile 所做的相同；`plugin` 与 `headless` 则以 `dsh` 会收到的相同参数调用上游的 `runCli`。为该 home 不修改任何上游文件：上游已从 `DSH_HOME` 解析其 home。

<a id="extension-points"></a>

## 扩展点

- **命令**是导出一个 `CliCommand`（`src/command.ts`）的模块，并在 `src/main.ts` 的 `COMMANDS` 中添加一行。`delorun doctor` 属于 `src/doctor/`，`delorun logs` 属于 `src/logs/`，二者都通过这一行接入。
- **Setup** 是 `src/setup/index.ts` 中的 `runSetup`，`delorun setup` 与首次运行都会调用它。setup 界面替换其函数体，并保留其签名。
- **持有者探测**是 `src/start.ts` 中 `StartDependencies` 的 `probe`；home 进程的 `status` 请求会替换把仍存活的持有者视为已响应的探测。

<a id="not-yet-implemented"></a>

## 尚未实现

- 不带 `--foreground` 的 `delorun start`、`delorun stop`，以及 `delorun status` 中来自 home 进程的部分：后台 home 进程、其更新通道、启动令牌与限制探测。
- setup 的问题：setup 的入口只创建 CLI profile。
- Windows 的 DACL 检查：在 Windows 上，目录与受保护文件的检查只查看文件类型。
- `delorun --version`、`verify`、`doctor`、`logs`、`update`、`recover`、`reach`、`devices`、`export`、`import` 与 `dev`。

<a id="development"></a>

## 开发

在检出的代码中用 `pnpm --filter @delo/cli delorun <command>` 运行 `delorun`；它需要先执行 `pnpm run build:artifacts`。规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli` 运行，应用的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json` 运行。规格测试使用临时的操作系统 home，从不触及真实的 `~/.delo` 或 `~/.dsh`。
