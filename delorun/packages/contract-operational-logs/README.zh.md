---
description: "Delorun 运行日志约定（C20）的类型与常量，供日志器、每个写日志的入口、delorun logs 与清除使用。"
---

# @delorun/contract-operational-logs

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包为实现约定 C20 的代码提供单一来源：各入口及其文件、日志记录、轮转与保留、脱敏器的键名与限额，以及 `delorun logs` 的选项。它只包含类型与只读常量，没有运行时行为。[约定页面](../../docs/contracts/c20-operational-logs.zh.md)是权威来源，本包与该页面在同一个拉取请求中修改。

## 目录

- [使用本包](#use-this-package)
- [导出](#exports)

<a id="use-this-package"></a>

## 使用本包

导入记录类型与限额，而不是重新声明它们：

```text
import { ROTATE_BYTES, type LogRecord } from '@delorun/contract-operational-logs'
```

本包是 `delorun/packages/logs`、`delorun/apps/cli` 以及通过该日志器写日志的每个入口的依赖。

<a id="exports"></a>

## 导出

- **入口：** `SURFACE_FILES`、`UPSTREAM_STARTUP_REPORTS` 与 `CLI_SURFACES`，以及 `SurfaceKind` 与 `SurfaceName` 类型。
- **记录：** `LogRecord`、`LogLevel`、`SessionId` 与 `WorkspaceId` 类型，`RECORD_MAX_BYTES` 与 `CAPTURED_LINE_MAX_BYTES`。
- **轮转与保留：** `ROTATE_BYTES`、`KEPT_FILES`、`RETENTION_MS`、`AGE_CHECK_INTERVAL_MS`、`LOG_DIR_MODE` 与 `LOG_FILE_MODE`。
- **脱敏：** `MIN_REGISTERED_SECRET_LENGTH`、`REDACTED_KEY_PARTS` 与 `REDACTION_EXEMPT_FIELDS`，以及 `SecretKind` 类型。
- **`delorun logs`：** `DEFAULT_TAIL_RECORDS` 与 `MAX_TAIL_RECORDS`。
