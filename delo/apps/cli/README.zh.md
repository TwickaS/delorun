---
description: "delorun 命令：它的命令、如何在上游运行前通过 @delo/home 准备 ~/.delo home、选择 CLI profile、获取 home 锁、把新 home 交给 setup，并运行上游的 profile 命令。"
---

# @delo/cli

[English](README.md) | 中文

## 摘要

本应用即 `delorun` 命令。在任何上游代码运行之前，它通过 [`@delo/home`](../../packages/home/README.zh.md) 解析并准备 Delo home（该包实现 [约定 C1](../../docs/contracts/c01-home-layout.zh.md) 的 home），选择 CLI profile，并通过上游的 profile 运行器运行该 profile，同时把 Delo home 作为 `DSH_HOME`。新 home 先交给 setup 的入口。一次启动会获取该 profile 的 home 锁，因此每个 profile 只运行一个 home 进程。

## 目录

- [命令](#commands)
- [home](#the-home)
- [Profile](#profiles)
- [Setup](#setup)
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
| `delorun setup [--profile <name>] [--yes \| --config <file>]` | setup：在终端中提问，或用 `--yes` 应用全部默认值，或用 `--config` 应用答案文档；已完成的 setup 保持不变 |
| `delorun start --foreground [--profile <name>]` | 在此终端中启动 home 进程，但不打开 studio |
| `delorun status [--profile <name>]` | 打印 home、profile、其 home 进程是否在运行，以及 `delorun` 忽略的、已继承的 `DSH_HOME` |
| `delorun plugin …` | 上游的 `dsh plugin …`，不作改动，针对 Delo home 运行 |
| `delorun headless …` | 上游的 `dsh headless …`，不作改动，针对 Delo home 运行 |

退出码：0 表示完成，1 表示失败，2 表示命令行错误，3 表示该 profile 没有 home 进程在运行（`status`）。失败时，标准错误输出一行，以 C1 的错误代码开头，例如 `HOME_MODE`，并在存在修复命令时以该命令结尾。

<a id="the-home"></a>

## home

- **解析。** 当 `DELO_HOME` 已设置且非空白时，home 即为它，否则为 `~/.delo`；`@delo/home` 拒绝约定 C1 所禁止的 home，错误代码为 `HOME_INVALID` 或 `HOME_IS_DSH_HOME`。
- **`DSH_HOME`。** 在任何上游代码运行之前，`delorun` 会把 `DSH_HOME` 与 `DELO_HOME` 设为该 home，把 `DELO_PROFILE` 设为该 profile，因此上游、其 `.env` 层以及每个子进程都使用 Delo home。已继承的 `DSH_HOME` 会被忽略，`delorun status` 会将其指出。
- **`~/.dsh`。** `delorun` 从不读取、写入或迁移上游的 home。
- **目录树。** 除 `status` 外，每个命令都会以 0700 模式通过 `ensureHomeTree` 创建 home 的目录树；当 home、`secrets/` 或 `run/<profile>/` 的模式更宽松时，它以 `HOME_MODE` 停止，并给出修复命令 `chmod 700 <path>`。`delorun` 自身不修改任何模式。

<a id="profiles"></a>

## Profile

CLI profile 为 `default`，或由 `DELO_PROFILE` 或 `--profile` 选定的名称，遵循上游的 profile 命名规则。桌面应用的 `desktop` profile 无论字母大小写如何，都会以用法退出码被拒绝；`delorun plugin --profile desktop` 也会被上游自身的解析器拒绝。因此 `delorun` 从不运行、初始化或修改 `profiles/desktop/` 或其锁。setup 的入口以 [`@delo/bundle-local`](../../packages/bundle-local/README.zh.md) 的 `DELO_PROFILE_BUNDLES` 创建 CLI profile：上游的 `web` profile 模板（其 Web 应用提供 studio），其后是 `@delo/bundle-local`。

启动时按上游启动的方式加载该 profile；若某个 Delo bundle（`@delo/` 作用域下的任何 bundle）因无法解析、读取或接受而被跳过，则拒绝启动它。否则上游会以其余各层及其自身默认值启动，而这些默认值会把会话日志上传给 DeepSeek。错误信息列出每个被跳过的 bundle、上游给出的原因及修复方法：在源码检出中，对本 `delorun` 自带的 bundle 运行 `delorun plugin --profile <name> add link:<directory>`；否则重新安装 Delo，或运行 `delorun plugin --profile <name> install`。被跳过的上游 bundle 按上游的方式报告，不会阻止启动。

<a id="setup"></a>

## Setup

Setup（[`src/setup/`](src/setup/index.ts)）回答[约定 C11](../../docs/contracts/c11-setup-answers.zh.md)中的问题，并写入 CLI profile。三种形式给出相同的答案，因此产生相同的写入：

- **提问**需要终端。setup 会说明 Delo 没有自己的遥测，并说明两个上游开关（桌面端分析与 DeepSeek 的会话日志上传）除非用户打开，否则保持关闭；在提问之前，它会说明每项会发送什么。这些声明来自 [`@delo/bundle-local`](../../packages/bundle-local/README.zh.md) 的 `./statements` 导出。
- **`--yes`** 应用全部默认值，并从 `DEEPSEEK_API_KEY` 读取模型密钥；该变量未设置时，它以一条指出变量名的错误停止。
- **`--config <file>`** 读取答案文档。若文档启用了 reach 或某个上游开关、在任何字段中携带了凭据值，或指定了非 1 的架构版本，它会拒绝该文档；拒绝信息指出字段，且从不回显任何值。

Setup 按顺序执行各步骤：创建 CLI profile；把输入的密钥以 0600 模式存入上游的 `.credentials.yaml`（从环境变量读取的密钥则不存储）；把会话日志行写入 profile 的 `cordis.patch.yml`；并记录桌面端分析的答案。在运行未完成期间，`run/<profile>/setup-progress.json` 保存不含密钥的答案以及已完成的步骤，因此被中断的运行会从第一个未完成的步骤继续。所有步骤完成后，setup 会删除该文件，并把答案写入 `profiles/<profile>/setup-answers.json`，供应用这些答案的界面读取。在对应界面存在之前，reach 与凭据转发都记录为关闭。

当系统的沙箱方言无法强制执行 `docker-connect` 时（Landlock、Windows，以及没有沙箱的系统），Docker 运行时选项带有 C1 的标签。

桌面端分析是“记录而不写入”：setup 记录答案，但不向桌面应用的 profile 写入任何行，因为桌面打包不在 MVP 范围内，桌面应用仍保留上游自己的 profile；待桌面应用组合 Delo 的组合包后，它再应用已记录的答案。规格测试固定了这一行为。尚未由 setup 写入的还有：模型选择、studio 附加功能、引导标志与运行时；它们的目标分别随各自的包到来。setup 把这些答案记录在答案记录中。

<a id="the-home-lock"></a>

## home 锁

一次启动会在引导该 profile 之前，使用 `@delo/home` 的 `acquireHomeLock` 获取 `run/<profile>/home.lock`，并在进程退出时释放它。在任意多次启动中，恰好只有一次会持有该锁，包括取代已死亡持有者留下的锁。存活的持有者绝不会被接管，第二次启动会打印正在运行的进程并以 0 退出，与 C19 的 `delorun start` 相同。被 `SIGKILL` 杀死的进程会留下该锁，下一次启动会将其替换。在更新通道存在之前，仍存活的持有者无法被询问状态，并被视为已响应，因此不会报告 `HOME_UNRESPONSIVE`。

<a id="how-delorun-runs-upstream"></a>

## delorun 如何运行上游

`delorun` 只通过上游的 profile 运行器启动应用，这是根目录 `AGENTS.md` 的要求。一次启动以 CLI profile 调用 `@deepseek-ai/dsh/profile-boot` 中的上游 `runProfile`，与桌面 Host 为其 profile 所做的相同；`plugin` 与 `headless` 则调用上游的 `runCli`，并以其 `argv` 选项传入 `dsh` 会收到的参数。该选项是 Delo 为此命令对上游所做的唯一改动，记录在差异台账中，类别为 `generic-fix`；上游已从 `DSH_HOME` 解析其 home，因此 home 不需要改动。

<a id="extension-points"></a>

## 扩展点

- **命令**是导出一个 `CliCommand`（`src/command.ts`）的模块，并在 `src/main.ts` 的 `COMMANDS` 中添加一行。`delorun doctor` 属于 `src/doctor/`，`delorun logs` 属于 `src/logs/`，二者都通过这一行接入。
- **Setup** 是 `src/setup/index.ts` 中的 `runSetup`，`delorun setup` 与首次运行都会调用它。提问位于 `src/setup/interactive.ts`，经由 `src/setup/prompts.ts` 的 `Prompter` 接口，因此测试可用脚本化的提问器运行它们。
- **持有者探测**是 `src/start.ts` 中 `StartDependencies` 的 `probe`；home 进程的 `status` 请求会替换把仍存活的持有者视为已响应的探测。

<a id="not-yet-implemented"></a>

## 尚未实现

- 不带 `--foreground` 的 `delorun start`、`delorun stop`，以及 `delorun status` 中来自 home 进程的部分：后台 home 进程、其更新通道、启动令牌与限制探测。
- setup 的 reach 问题，以及导入 DeepSeek Harness 的 stock home。setup 将 reach 记录为关闭。
- Windows 的 DACL 检查（[#48](https://github.com/Delo-Run/delo/issues/48)）：在 Windows 上，目录与受保护文件的检查只查看文件类型。
- `delorun --version`、`verify`、`doctor`、`logs`、`update`、`recover`、`reach`、`devices`、`export`、`import` 与 `dev`。

<a id="development"></a>

## 开发

在检出的代码中用 `pnpm --filter @delo/cli delorun <command>` 运行 `delorun`；它需要先执行 `pnpm run build:artifacts`，且检出中的 CLI profile 需要按首次启动的错误信息所示链接 `@delo/bundle-local`。规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli` 运行，应用的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json` 运行。规格测试使用临时的操作系统 home，从不触及真实的 `~/.delo` 或 `~/.dsh`。
