---
description: "只含类型的包，保存身份因子、每个远程访问地址的依赖方规则、通行密钥选项、OpenID Connect 流程参数、必需声明、允许的算法、注册路由、错误代码、上限以及身份因子的 spike 证据，规格见约定 C14。"
---

# @delorun/contract-oidc-passkeys

[English](README.md) | 中文

## 摘要

本只含类型的包导出远程访问（reach）所要求的身份因子（identity factor）的定义：因子名称、在当前约定下哪些远程访问方式提供通行密钥以及如何选择依赖方（relying party）ID、通行密钥注册选项、OpenID Connect 流程用途与参数、客户端认证与动态注册字段、允许的 ID 令牌算法与必需声明、注册路由、错误代码、上限，以及 `ts.net` spike 报告记录的证据。`@delorun/home-auth`、setup 与远程访问屏幕导入这些定义，因此每条规则与上限只有一处定义。规格见[约定 C14](../../docs/contracts/c14-oidc-passkeys.zh.md)。

## 导出

- `IDENTITY_FACTORS` 与 `IdentityFactor`：因子名称。
- `PASSKEYS_AVAILABLE`、`RELYING_PARTY_ID_RULE` 与 `RELYING_PARTY_NAME`：每种远程访问方式的依赖方规则。
- `PASSKEY_COSE_ALGORITHMS` 与 `PASSKEY_REGISTRATION`：通行密钥选项。
- `OIDC_CALLBACK_PATH`、`DELORUN_CALLBACK_PATH`、`OIDC_FLOW_PURPOSES`、`OIDC_FLOW_COOKIE`、`OIDC_AUTHORIZATION_PARAMETERS`、`OIDC_REAUTH_PARAMETERS`、`OIDC_CLIENT_AUTH_METHOD`、`OIDC_DYNAMIC_REGISTRATION` 与 `OIDC_CLIENT_FILE`：OpenID Connect 流程与客户端注册。
- `ID_TOKEN_ALGORITHMS`、`REQUIRED_ID_TOKEN_CLAIMS` 与 `PinnedOwnerIdentity`：ID 令牌检查与已固定的所有者身份。
- `ENROLMENT_ROUTES`：注册会话可访问的路由。
- `IDENTITY_LIMITS`、`IDENTITY_ERROR_CODES` 与 `IdentityErrorCode`：上限与错误代码。
- `TsNetRelyingPartySpikeEvidence`：在 `ts.net` 地址提供通行密钥之前，spike 报告记录的内容。

## 限制

本包没有运行时代码。它只依赖 `@delorun/contract-reach-providers`，用于远程访问方式 id。对规则、声明、上限或代码的变更，遵循该约定的兼容性一节。
