---
description: "Delorun 运行时与监管器约定（C9）的类型与常量，供运行时提供方、Docker 监管器、各 Docker 形态与 studio 的工作区插件使用。"
---

# @delorun/contract-runtime-supervisor

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包为实现约定 C9 的代码提供单一来源：运行时提供方的操作、能力报告、监管器的封闭请求结构、资源预设、出站默认值、凭据转发、S2 辅助通道、镜像以及容器拒绝标记。它只包含类型与只读常量，没有运行时行为。[约定页面](../../docs/contracts/c09-runtime-supervisor.zh.md)是权威来源，本包与该页面在同一个拉取请求中修改。

## 目录

- [使用本包](#use-this-package)
- [导出](#exports)

<a id="use-this-package"></a>

## 使用本包

导入这些结构、预设与限额，而不是重新声明它们：

```text
import { PRESETS, type SupervisorRequest } from '@delorun/contract-runtime-supervisor'
```

本包是 `delorun/packages/supervisor`、`delorun/packages/runtime-docker`、studio 的工作区插件与 `delorun/packages/integrity` 的依赖。它使用 [`@delorun/contract-home-layout`](../contract-home-layout/README.zh.md) 的令牌与限制类型。

<a id="exports"></a>

## 导出

- **运行时提供方：** `RUNTIME_PROVIDER_SERVICE`，以及 `RuntimeProvider`、`RuntimeKind`、`DockerShape`、`WorkspaceRuntimeRequest`、`WorkspaceRuntimeSpec`、`WorkspaceRuntimeState` 与 `WorkspaceId` 类型。
- **能力报告：** `REQUIRED_LIMITS`，以及 `CapabilityReport`、`DockerCapabilities`、`DockerLimit`、`LimitFinding`、`ShapeAvailability` 与 `ShapeReason` 类型。
- **预设：** `PRESETS`、`DEFAULT_PRESET`、`ADVANCED_BOUNDS`、`GIB` 与 `MIB`，以及 `PresetName` 与 `ResourceLimits` 类型。
- **出站与凭据：** `DEFAULT_EGRESS`、`DEFAULT_EGRESS_HOSTS`、`MAX_ALLOWLIST_ADDITIONS`、`MAX_HOST_LENGTH`、`EGRESS_PROXY_PORT`、`EGRESS_PROXY_ENTRY` 与 `EGRESS_REFUSED_RANGES`，以及 `EgressMode` 与 `CredentialOption` 类型。
- **监管器：** `SUPERVISOR_PROTOCOL_VERSION`、`SUPERVISOR_REQUEST_MAX_BYTES`、`SUPERVISOR_REQUEST_DEADLINE_MS`、`SUPERVISOR_MAX_CONNECTIONS`、`WORKSPACE_ID_MAX_LENGTH`、`ROOT_MAX_BYTES`、`GRACEFUL_STOP_MS`、`MAX_ROOT_PARENTS`、`LABELS` 与 `NAME_HASH_HEX_DIGITS`，以及 `SupervisorRequest`、`SupervisorFailure`、`SupervisorErrorCode` 与 `SupervisorRoots` 类型。
- **辅助通道与 S3：** `HELPER_KEY_BYTES`、`HELPER_CHALLENGE_LABEL`、`HELPER_CHALLENGE_TIMEOUT_MS`、`HELPER_SOCKET_DIR`、`AGENT_SOCKET_PATH` 与 `S3_USERS`。
- **镜像：** `IMAGES`、`IMAGE_BASE` 与 `IMAGE_PULL_HOSTS`。
- **拒绝标记：** `ENVIRONMENT_DENIAL_SIGNATURES` 与 `ENVIRONMENT_DENIAL_MARKER`。
