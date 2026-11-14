---
description: "只含类型的包，保存设备批准的密钥类型、所有者认领与批准消息、匹配码参数、恢复套件、TLS 密钥声明、告警种类、错误码与限制，规格见约定 C5。"
---

# @delorun/contract-device-approval

[English](README.md) | 中文

## 摘要

本只含类型的包导出设备批准（device approval）的消息与限制：密钥算法及保存它们的文件、所有者认领、批准请求及其应答、带 WebAuthn 或重新认证证明的批准、会话请求、恢复套件（recovery kit）前缀、桌面应用的 TLS 密钥声明、告警文件及其种类、错误码，以及作为具名常量的每项限制。`@delorun/home-auth`、`@delorun/certificates`、远程访问（reach）屏幕与桌面应用都导入这些定义，因此每个消息字段与每项限制只有一处定义。规格见[约定 C5](../../docs/contracts/c05-device-approval.zh.md)。

## 导出

- `DEVICE_APPROVAL_VERSION`、`Base64Url`、`HomeKeyId` 与 `ApprovalRequestId`：消息版本与带品牌的值。
- `KEY_ALGORITHMS`、`HOME_AUTH_FILES` 与 `BROWSER_DEVICE_KEY_STORE`：密钥类型及其存储位置。
- `OwnerClaim`、`ApprovalRequest`、`ApprovalRequestAccepted`、`APPROVAL_REQUEST_STATES`、`Approval` 与 `WebAuthnAssertion`：认领与批准消息。
- `MATCH_CODE_LABEL` 与 `MATCH_CODE_DIGITS`：匹配码派生所用的标签与匹配码长度。
- `SIGN_IN_LABEL`、`IdentityFactorProof` 与 `SessionRequest`：登录。
- `RECOVERY_KIT_PREFIX` 与 `TlsKeyStatement`：恢复套件的书写形式，以及桌面应用的固定声明。
- `ALERT_KINDS`、`BLOCKING_ALERT_KINDS`、`AlertFile`、`ALERT_WEBHOOK_URL_FILE`、`ALERT_SIGNATURE_HEADER` 与 `ALERT_COMMAND_ENV`：告警及其渠道。
- `DEVICE_APPROVAL_LIMITS` 与 `DEVICE_APPROVAL_ERROR_CODES`：限制与错误码。

## 限制

本包没有运行时代码。它依赖工作区的 brand 包，并依赖 `@delorun/contract-admission` 提供设备 id 与 studio 地址类型。对消息、限制或错误码的变更，遵循该约定的兼容性一节。
