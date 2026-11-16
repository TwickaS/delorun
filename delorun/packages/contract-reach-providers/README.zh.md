---
description: "只含类型的包，保存远程访问提供方的远程访问方式 id 与监听器、提供方状态与转换、配置行、Tailscale serve 目标的变体与 spike 证据、身份请求头规则、指定的证书颁发机构与错误码，规格见约定 C7。"
---

# @delorun/contract-reach-providers

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本只含类型的包导出远程访问提供方（reach provider）的定义：远程访问方式 id 及每种方式所连接的监听器、提供方状态及其转换、配置行、两种 Tailscale serve 目标变体以及 spike 报告记录的证据、身份请求头规则、自有域名远程访问所指定的证书颁发机构及所检查的 CAA 参数，以及错误码。`@delorun/reach`、`@delorun/certificates`、远程访问屏幕与验证检查都导入这些定义，因此每种方式、每个状态与每个错误码只有一处定义。规格见[约定 C7](../../docs/contracts/c07-reach-providers.zh.md)。

## 导出

- `REACH_OPTION_IDS`、`ReachOptionId` 与 `REACH_OPTION_LISTENERS`：远程访问方式及其监听器。
- `REACH_STATES`、`ReachState`、`REACH_STATE_TRANSITIONS` 与 `ReachStateChange`：状态与 `reach/state` 事件。
- `ReachConfigRows`、`DEFAULT_SERVE_PORT`、`FUNNEL_PORTS` 与 `DEFAULT_FUNNEL_PORT`：配置行。
- `TailscaleServeTarget`、`SERVE_SOCKET_PATH`、`SERVE_SOCKET_MODE` 与 `ServeSocketSpikeEvidence`：serve 目标变体与 spike 证据。
- `TAILSCALE_HEADER_PREFIX` 与 `TAILSCALE_LOGIN_HEADER`：身份请求头。
- `NAMED_CA`、`CAA_ENFORCED_PARAMETERS`、`RELAY_PATH_VALIDATION_METHOD`、`DELORUN_CONTROLLED_ZONES`、`CAA_CHECK_INTERVAL_MS` 与 `CERTIFICATE_RENEW_BEFORE_DAYS`：自有域名远程访问。
- `REACH_ERROR_CODES` 与 `ReachErrorCode`：错误码。

## 限制

本包没有运行时代码。它只依赖 `@delorun/contract-admission`，用于监听器 id 与 studio 地址类型。对方式、状态、行或错误码的变更，遵循该约定的兼容性一节。
