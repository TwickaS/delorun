---
description: "Delorun home 布局与运行时仓库约定（C1）的类型与常量，供 CLI、运行时仓库、home 进程、监管器与验证检查使用。"
---

# @delorun/contract-home-layout

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包为实现约定 C1 的代码提供名称、权限模式、限额与错误代码的单一来源：`~/.delorun` 的条目、启动令牌的大小、运行时仓库的指针文件、启动器的下载限额，以及 `delorun verify` 报告的隔离规则。它包含类型与只读常量，以及一个纯函数，即 profile 名称检查 `profileNameProblem`。[约定页面](../../docs/contracts/c01-home-layout.zh.md)是权威来源，本包与该页面在同一个 pull request 中修改。

## 目录

- [使用本包](#use-this-package)
- [home 条目](#home-entries)
- [导出](#exports)

<a id="use-this-package"></a>

## 使用本包

导入这些名称与限额，而不是重新声明它们：

```text
import { PRIVATE_DIR_MODE, RUN_ENTRIES, type ConfinementReport } from '@delorun/contract-home-layout'
```

本包是 `delorun/apps/cli`、`delorun/packages/home`、`delorun/packages/runtime-store`、`delorun/packages/home-process`、`delorun/packages/supervisor` 以及其他读取或写入 home 的 Delorun 包的依赖，也是共用其令牌与版本类型的其他约定包的依赖。

<a id="home-entries"></a>

## home 条目

`DELORUN_HOME_ENTRIES` 列出 Delorun 添加到 home 的每个顶层目录，`delorun/packages/home` 中的 `ensureHomeTree` 以 0700 模式创建它们：

- `runtimes/` 和 `staging/`：运行时仓库及其进行中的安装，由 `delorun/packages/runtime-store` 写入。
- `trust/`：已验证的根、时间戳、日志检查点和发布日志检查状态，由 `delorun/apps/install` 和 `delorun/packages/release-verify` 写入。
- `status/`：每个安装的更新状态记录，由 CLI home 和桌面应用写入。
- `catalogue/`：已验证的插件索引和撤销列表。
- `secrets/`：每个所属包一个存放密钥文件的目录，例如 `home-auth/`。
- `run/`：每个 CLI profile 一个运行目录，以及 `run/data-users/`，由 `delorun/packages/home`、home 进程和 `delorun` 写入。
- `supervisor/`：Docker 监管器的根文件，由 `delorun/packages/supervisor` 写入。
- `bin/`：安装脚本和登录项使用的启动器副本。
- `alerts/`：已签名的证书告警文件。
- `data-copies/`：更新所做的会话数据副本和恢复的日志，由 `delorun/packages/update` 写入。
- `data-set-aside/`：回滚所替换的 chat 数据，由 `delorun/packages/update` 的回滚写入。
- `trash/`：被放入回收站的 chat 和工作区，直到保留期结束或被恢复，由 `delorun/packages/trash` 经 studio 的回收站插件和 `delorun trash` 写入。
- `archive/`：工作区归档的导入，先暂存再发布，由 `delorun import` 写入。

规格 `tests/home-entries.spec.ts` 扫描每个 Delorun 应用和包的源码中位于 home 之下的路径拼接，并在出现既不在此列表、也不在上游条目中的顶层条目时失败；其文件头说明它读取的模式以及它看不到的内容。

<a id="exports"></a>

## 导出

- **home：** `DELORUN_HOME_DIR_NAME`、`DELORUN_HOME_ENV`、`DELORUN_PROFILE_ENV`、`DSH_HOME_ENV`、`UPSTREAM_HOME_DIR_NAME`、`CLI_PROFILE`、`DESKTOP_PROFILE`、`HEADLESS_PROFILE`、`DATA_USERS_DIRECTORY`、`DELORUN_HOME_ENTRIES`、`READ_EXEMPTIONS`、`RUN_ENTRIES`、`SUPERVISOR_ROOTS_FILE`、`TRUST_FILES`、`STATUS_FILES` 与 `CATALOGUE_FILES`。
- **profile 名称：** `RESERVED_PROFILE_NAMES`（每个保留名称及其原因）、`PROFILE_NAME_PATTERN` 与 `profileNameProblem`，即启动器和 `delorun` 对每个 profile 名称应用的检查。
- **权限模式：** `PRIVATE_DIR_MODE`、`PROTECTED_FILE_MODE` 与 `FORBIDDEN_MODE_BITS`，以及 `ModeFinding` 类型。
- **通道与令牌：** `SOCKET_PATH_MAX_BYTES`、`WINDOWS_PIPE_PREFIX`、`HOME_ID_HEX_DIGITS`、`START_TOKEN_BYTES`、`START_TOKEN_LENGTH`、`HOME_STATUS_TIMEOUT_MS`，以及 `StartToken`、`StartId` 与 `HomeLockRecord` 类型。
- **运行时仓库：** `STORE_ENTRIES`、`STAGING_NAME_HEX_DIGITS`、`STORE_LAYOUT`、`LAUNCH_PROTOCOL`、`RUNTIME_VERSION_PATTERN`、`RUNTIME_VERSION_MAX_LENGTH`、`POINTER_FILE_MAX_BYTES`、`RETAINED_RUNTIME_VERSIONS`、`STORE_LOCK_WAIT_MS`、`POINTER_RENAME_RETRY_MS`，以及 `RuntimeVersion` 与 `StoreLayoutRecord` 类型。
- **启动器下载：** `ARCHIVE_MAX_BYTES`、`MANIFEST_MAX_BYTES`、`DOWNLOAD_CONNECT_TIMEOUT_MS`、`DOWNLOAD_STALL_TIMEOUT_MS` 与 `RELEASE_DOWNLOAD_HOSTS`。
- **隔离：** `CONFINEMENT_RULES`，以及 `ConfinementRule`、`SandboxDialect`、`RuleStatus`、`RuleReason`、`RuleFinding`、`DockerEndpoint` 与 `ConfinementReport` 类型。
- **错误：** `HomeLayoutErrorCode` 类型。
