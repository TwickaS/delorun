---
description: "Delo home 布局与运行时仓库约定（C1）的类型与常量，供 CLI、运行时仓库、home 进程、监管器与验证检查使用。"
---

# @delorun/contract-home-layout

[English](README.md) | 中文

## 摘要

本包为实现约定 C1 的代码提供名称、权限模式、限额与错误代码的单一来源：`~/.delorun` 的条目、启动令牌的大小、运行时仓库的指针文件、启动器的下载限额，以及 `delorun verify` 报告的限制规则。它只包含类型与只读常量，没有运行时行为。[约定页面](../../docs/contracts/c01-home-layout.zh.md)是权威来源，本包与该页面在同一个拉取请求中修改。

## 目录

- [使用本包](#use-this-package)
- [导出](#exports)

<a id="use-this-package"></a>

## 使用本包

导入这些名称与限额，而不是重新声明它们：

```text
import { PRIVATE_DIR_MODE, RUN_ENTRIES, type ConfinementReport } from '@delorun/contract-home-layout'
```

本包是 `delorun/apps/cli`、`delorun/packages/home`、`delorun/packages/runtime-store`、`delorun/packages/home-process`、`delorun/packages/supervisor` 与 `delorun/packages/integrity` 的依赖，也是共用其令牌与版本类型的其他约定包的依赖。

<a id="exports"></a>

## 导出

- **Home：** `DELORUN_HOME_DIR_NAME`、`DELORUN_HOME_ENV`、`DELORUN_PROFILE_ENV`、`DSH_HOME_ENV`、`UPSTREAM_HOME_DIR_NAME`、`CLI_PROFILE`、`DESKTOP_PROFILE`、`DELORUN_HOME_ENTRIES`、`READ_EXEMPTIONS`、`RUN_ENTRIES`、`SUPERVISOR_ROOTS_FILE`、`TRUST_FILES`、`STATUS_FILES` 与 `CATALOGUE_FILES`。
- **权限模式：** `PRIVATE_DIR_MODE`、`PROTECTED_FILE_MODE` 与 `FORBIDDEN_MODE_BITS`，以及 `ModeFinding` 类型。
- **通道与令牌：** `SOCKET_PATH_MAX_BYTES`、`WINDOWS_PIPE_PREFIX`、`HOME_ID_HEX_DIGITS`、`START_TOKEN_BYTES`、`START_TOKEN_LENGTH`、`HOME_STATUS_TIMEOUT_MS`，以及 `StartToken`、`StartId` 与 `HomeLockRecord` 类型。
- **运行时仓库：** `STORE_ENTRIES`、`STAGING_NAME_HEX_DIGITS`、`STORE_LAYOUT`、`LAUNCH_PROTOCOL`、`RUNTIME_VERSION_PATTERN`、`RUNTIME_VERSION_MAX_LENGTH`、`POINTER_FILE_MAX_BYTES`、`RETAINED_RUNTIME_VERSIONS`、`STORE_LOCK_WAIT_MS`、`POINTER_RENAME_RETRY_MS`，以及 `RuntimeVersion` 与 `StoreLayoutRecord` 类型。
- **启动器下载：** `ARCHIVE_MAX_BYTES`、`MANIFEST_MAX_BYTES`、`DOWNLOAD_CONNECT_TIMEOUT_MS`、`DOWNLOAD_STALL_TIMEOUT_MS` 与 `RELEASE_DOWNLOAD_HOSTS`。
- **限制规则：** `CONFINEMENT_RULES`，以及 `ConfinementRule`、`SandboxDialect`、`RuleStatus`、`RuleReason`、`RuleFinding`、`DockerEndpoint` 与 `ConfinementReport` 类型。
- **错误：** `HomeLayoutErrorCode` 类型。
