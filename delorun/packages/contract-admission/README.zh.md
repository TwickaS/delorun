---
description: "只含类型的包，保存 home 准入的监听器 id、准入结果、登录前路由、拒绝代码、会话 cookie 与会话限值，规格见约定 C4。"
---

# @delorun/contract-admission

[English](README.md) | 中文

## 摘要

本只含类型的包导出 home 准入的标识符与限值：监听器 id 及其策略、Authenticator 的 `admit` 的结果、远程访问（reach）监听器的登录前路由、拒绝代码及其 HTTP 状态、远程访问会话 cookie，以及会话有效期。上游连接与 web 服务器的编辑、`@delorun/home-auth` 与 `@delorun/reach` 都导入这些定义，因此每个代码与限值只有一处定义。规格见[约定 C4](../../docs/contracts/c04-admission.zh.md)。

## 导出

- `LISTENER_IDS`、`ListenerId`、`ReachListenerId`、`DeclaredScheme`、`HostRule` 与 `ListenerPolicy`：各监听器，以及分发器读取的策略。
- `DeviceId`、`SessionId` 与 `StudioAddress`：受信任设备（trusted device）、会话记录与 studio 地址的带品牌 id。
- `Admission`：`admit` 的三种结果。
- `HOME_AUTH_PRE_LOGIN_ROUTES` 与 `PreLoginRoute`：远程访问监听器在登录之前提供的路由。
- `ADMISSION_REFUSAL_CODES`、`ADMISSION_REFUSAL_STATUS` 与 `REACH_LISTENER_HOST_OVERRIDE`：各项拒绝与加载失败。
- `LOOPBACK_MINT_EVENT` 与 `LoopbackCredentialMint`：上游每签发一个回环凭据时发出的通知，由 `@delorun/home-auth` 记录。
- `ROTATION_TRIGGERS`：轮换每个会话的事件。
- `REACH_SESSION_COOKIE`、`UPSTREAM_COOKIE_PREFIX`、`SESSION_TOKEN_BYTES`、`SESSION_LIMITS`、`LOOPBACK_COOKIE_MAX_AGE_DAYS`、`SESSION_STORE_PERSIST_MS` 与 `SESSION_STORE_VERSION`：cookie、令牌大小、有效期与存储。
- `LOOPBACK_LISTENER_ADDRESS` 与 `REACH_LISTENER_BIND_HOST`：各监听器地址。
- `CSP_NONCE_BYTES`、`REACH_CSP_DIRECTIVES`、`TRUSTED_TYPES_POLICIES` 与 `PLUGIN_SCRIPT_PATH_PREFIX`：内容安全策略（Content Security Policy）的 nonce 与指令，以及 Trusted Types 策略。

## 限制

本包没有运行时代码。它只依赖工作区的 brand 包，用于带品牌的 id。`Admission` 以 Peer 类型作为类型参数，因此本包不从上游导入任何内容。对代码、限值或路由的变更，遵循该约定的兼容性一节。
