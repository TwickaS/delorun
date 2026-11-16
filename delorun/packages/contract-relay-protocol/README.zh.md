---
description: "只含类型的包，保存中继协议的中继配置、隧道令牌声明、握手消息、帧类型、关闭代码与错误代码、通告、重新绑定声明与限额，规格见约定 C6。"
---

# @delorun/contract-relay-protocol

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本只含类型的包导出中继协议的线上传输定义：自托管中继的配置与绑定、隧道（tunnel）令牌请求与声明、握手消息、帧类型及其负载、流关闭原因、通告、重新绑定声明、关闭代码与错误代码、限额，以及证书监控来源。`delorun/apps/relay/` 中的中继、`@delorun/reach` 中的中继客户端与模糊测试语料库都导入这些定义，因此每个帧与限额只有一处定义。规格见[约定 C6](../../docs/contracts/c06-relay-protocol.zh.md)。

## 导出

- `RELAY_PROTOCOL_VERSION`、`RELAY_SUBPROTOCOL` 与 `RELAY_PATHS`：版本、WebSocket 子协议，以及中继的两个路径。
- `Base64Url` 与 `RelayId`：带品牌的值。
- `RelayConfig` 与 `RelayBinding`：自托管中继的配置。
- `TunnelTokenRequest`、`TunnelTokenClaims`、`TUNNEL_PROOF_LABEL` 与 `HandshakeMessage`：令牌与握手。
- `FRAME_TYPES`、`FRAME_HEADER_BYTES`、`OpenPayload` 与 `STREAM_CLOSE_REASONS`：帧。
- `Announcement`、`AnnouncementKind` 与 `RebindStatement`：通告与重新绑定。
- `TUNNEL_CLOSE_CODES` 与 `RELAY_HTTP_ERRORS`：关闭代码与 HTTP 错误。
- `RELAY_LIMITS`、`DEFAULT_CT_SOURCE` 与 `CT_QUERY_INTERVAL_MS`：限额与证书监控。

## 限制

本包没有运行时代码。它只依赖工作区的 brand 包，用于带品牌的值。对帧、签名对象或限额的变更即为新的协议版本，如该约定的兼容性一节所述。
