---
description: "@delo/home 库：每个 Delo 组件所用的约定 C1 home，从解析 ~/.delo 并以 0700 模式创建其目录树，到以 0600 模式读写受保护文件及按 profile 划分的 home 锁。"
---

# @delo/home

[English](README.md) | 中文

## 摘要

本包是每个 Delo 组件都使用的、[约定 C1](../../docs/contracts/c01-home-layout.zh.md) 中 home 的唯一实现。它解析 Delo home，以 0700 模式创建 home 及其中 Delo 的条目，拒绝其他用户可以访问的目录或受保护文件，以 0600 模式读写受保护文件，并获取按 profile 划分的 home 锁，使每个 profile 只运行一个 home 进程。名称、模式与错误代码均来自 [`@delo/contract-home-layout`](../contract-home-layout/README.zh.md)。`delorun` 命令（[`delo/apps/cli`](../../apps/cli/README.zh.md)）是它的首个使用者。

## 目录

- [使用本包](#use-this-package)
- [解析 home](#resolving-the-home)
- [目录树及其模式](#the-tree-and-its-modes)
- [受保护文件](#protected-files)
- [home 锁](#the-home-lock)
- [尚未实现](#not-yet-implemented)
- [开发](#development)

<a id="use-this-package"></a>

## 使用本包

```text
import { ensureHomeTree, readProtectedFile, resolveDeloHome, writeProtectedFile } from '@delo/home'
```

约定定义的每个失败都是一个 `HomeLayoutError`，携带 C1 的 `code`、其涉及的 `path`，以及存在时位于 `fix` 中的 shell 命令；其消息以该命令结尾。

<a id="resolving-the-home"></a>

## 解析 home

`resolveDeloHome(env)` 返回 home：当 `DELO_HOME` 已设置且非空白时即为它，否则为 `~/.delo`（Windows 上为 `%USERPROFILE%\.delo`），开头的 `~` 展开为操作系统的用户主目录，路径经规范化。相对路径、文件系统根目录与操作系统的用户主目录以 `HOME_INVALID` 被拒绝；上游的 `~/.dsh`、其中的路径以及指向二者的链接以 `HOME_IS_DSH_HOME` 被拒绝；比较前先解析链接。它还会返回指向另一目录的已继承 `DSH_HOME`，调用方忽略它，并可以报告它。

<a id="the-tree-and-its-modes"></a>

## 目录树及其模式

`ensureHomeTree(home, profile)` 以 0700 模式、通过带该模式的 `mkdir` 创建 home、Delo 的每个顶层条目（`runtimes/`、`staging/`、`trust/`、`status/`、`catalogue/`、`secrets/`、`run/`、`supervisor/`、`bin/`、`alerts/`）以及 `run/<profile>/`，因此 umask 只能收窄该模式。随后它以 `checkPrivateDirectory` 检查 home、`secrets/` 与 `run/<profile>/`；该函数以 `HOME_MODE` 拒绝符号链接、其他用户的目录，或设置了组或其他用户权限位的目录，并给出修复命令 `chmod 700 <path>`。`checkPrivateDirectorySync(path)` 以同步方式执行相同的检查，供处于同步路径上的调用方使用，例如 [`@delo/logs`](../logs/README.zh.md) 的日志写入方。已存在的目录保持其模式：此处不改动任何模式。上游的条目保持上游的布局与模式，本包不创建其中任何条目。

<a id="protected-files"></a>

## 受保护文件

约定 C1 的受保护文件包括 `secrets/`、`trust/`、`status/` 与 `catalogue/` 之下的每个文件、启动令牌、监管器的根文件，以及运行日志文件。

- `writeProtectedFile(path, data)` 先写入一个同目录临时文件（以 0600 模式独占创建），将其刷新，再重命名覆盖该路径，并在 Linux 与 macOS 上刷新该目录。写入失败时，它删除临时文件，并保持该路径不变。
- `readProtectedFile(path)` 拒绝以下路径：符号链接、非常规文件、属于其他用户的文件，或设置了组或其他用户权限位的文件，错误代码为 `SECRET_FILE_MODE`；对于较宽松的模式，它给出修复命令 `chmod 600 <path>`。它在打开路径之前先检查该路径，因此 FIFO 或设备永远不会被打开；打开之后它再次检查已打开的文件，因此中途被替换的文件同样会被拒绝。
- `checkProtectedFile(path)` 执行相同的检查，但不读取文件；`checkProtectedFileSync(path)` 以同步方式执行该检查，并返回它所检查的 `lstat` 结果，以便随后打开该文件的调用方确认打开的是同一个文件。

<a id="the-home-lock"></a>

## home 锁

`acquireHomeLock({ runDirectory, runtime, probe })` 获取 `run/<profile>/home.lock`，其记录为约定 C1 的 JSON 对象（`v`、`pid`、`startId`、`runtime`、`startedAt`），模式为 0600，并返回一个句柄；当锁中仍是本持有者的记录时，该句柄的 `release()` 会删除该锁。`release()` 是同步的，因此进程的 `exit` 监听器可以调用它。

- **创建。** 锁写入的每个文件都先写入临时文件，再硬链接到其路径，因此它要么完整出现，要么完全不出现；无论有多少争用者，恰好只有一个链接会成功。
- **存活的持有者**绝不会被接管。`probe` 在约定 C1 规定的两秒内询问其状态：有回应时结果为 `HOME_RUNNING`，无回应时为 `HOME_UNRESPONSIVE`。在 home 进程的更新通道存在之前，CLI 传入的探测会把存活的持有者视为已回应。
- **陈旧的锁**，即其进程已不存在的锁，由 `removeStaleLock` 在接管守卫 `home.lock.takeover-<startId>` 之下删除；该守卫以同样方式创建，因此同一时刻只有一个争用者能够删除该记录。持有守卫的争用者只有在锁仍持有该 `startId` 时才会删除它。`startId` 是随机的且从不复用，且只有守卫持有者可以删除其记录，因此争用者无论运行得多晚，都不会删除它所发现的陈旧锁之外的锁。争用者死亡后遗留的守卫，由另一争用者以其自身的随机 id 作为守卫名称，以同样方式删除；在存活的争用者完成删除期间，争用者最多等待 10 秒。

<a id="not-yet-implemented"></a>

## 尚未实现

- 约定 C1 Windows 规则中的 DACL 检查（[#48](https://github.com/Delo-Run/delo/issues/48)）：在 Windows 上，目录与受保护文件的检查只查看文件类型。
- 启动令牌、各通道的套接字，以及 home 进程所增加的限制探测。

<a id="development"></a>

## 开发

规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home` 运行，包的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/packages/home/tsconfig.json` 运行。锁的规格测试从 `tests/fixtures/lock-contender.ts` 启动至多 16 个进程，在空闲的锁与已死亡持有者的锁上逐轮竞争，且只使用临时目录。
