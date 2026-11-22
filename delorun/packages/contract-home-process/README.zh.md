---
description: "Delorun home 进程与更新握手约定（C19）的类型与常量，供 home 进程、delorun 命令与 studio 的更新插件使用。"
---

# @delorun/contract-home-process

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包为实现约定 C19 的代码提供单一来源：更新通道的请求与响应、home 进程的状态、握手的阶段与结果、更新日志文件以及每一项限额。它只包含类型与只读常量，没有运行时行为。[约定页面](../../docs/contracts/c19-home-process.zh.md)是权威来源，本包与该页面在同一个拉取请求中修改。

## 目录

- [使用本包](#use-this-package)
- [导出](#exports)

<a id="use-this-package"></a>

## 使用本包

导入协议的类型与限额，而不是重新声明它们：

```text
import { REQUEST_MAX_BYTES, type UpdateChannelRequest } from '@delorun/contract-home-process'
```

本包是 `delorun/packages/home-process`、`delorun/apps/cli` 以及 `@delorun/bundle-local` 中 Host 更新插件的依赖。它使用 [`@delorun/contract-home-layout`](../contract-home-layout/README.zh.md) 的令牌、启动 id 与版本类型。

<a id="exports"></a>

## 导出

- **协议：** `UPDATE_PROTOCOL_VERSION`，请求类型 `StatusRequest`、`UpdatePrepareRequest`、`UpdateApplyRequest`、`UpdateCancelRequest`、`RollbackRequest`、`StopRequest` 及其联合类型 `UpdateChannelRequest`，以及 `DrainArgs`、`UpdateChannelResponse` 与 `HomeStatus`。
- **状态与阶段：** `HomeProcessState`、`UpdatePhase`、`UpdateOutcome`、`DrainPolicy` 与 `StopMode` 类型。
- **记录：** `UpdateJournal` 与 `HandoverMessage` 类型，以及 `HANDOVER_FD`。
- **限额：** `HOME_PROCESSES_PER_PROFILE`、`START_WAIT_MS`、`REQUEST_MAX_BYTES`、`REQUEST_DEADLINE_MS`、`MAX_CONNECTIONS`、`AUTH_FAILURE_LOG_LINES_PER_SECOND`、`REPORT_LIFETIME_MS`、`DRAIN_TIMEOUT_MIN_S`、`DRAIN_TIMEOUT_MAX_S`、`DRAIN_TIMEOUT_DEFAULT_S`、`HEALTH_CHECK_TIMEOUT_MS`、`SUCCESSOR_DEADLINE_MS`、`LOGIN_RESTART_LIMIT`、`LOGIN_RESTART_WINDOW_MS` 与 `STATUS_EXIT_NOT_RUNNING`。
- **错误：** `HomeProcessErrorCode` 类型。
