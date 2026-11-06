---
description: "Types-only package holding the relay configuration, tunnel token claims, handshake messages, frame types, close and error codes, announcements, rebind statements and limits of the relay protocol, as specified by contract C6."
---

# @delo/contract-relay-protocol

English | [中文](README.zh.md)

## Summary

This types-only package exports the wire definitions of the relay protocol: the self-hosted relay's configuration and bindings, the tunnel token request and claims, the handshake messages, the frame types and their payloads, the stream close reasons, the announcements, the rebind statement, the close and error codes, the limits and the certificate monitoring source. The relay in `delo/apps/relay/`, the relay client in `@delo/reach` and the fuzz corpus import these definitions, so each frame and limit has one definition. The specification is [contract C6](../../docs/contracts/c06-relay-protocol.md).

## Exports

- `RELAY_PROTOCOL_VERSION`, `RELAY_SUBPROTOCOL` and `RELAY_PATHS`: the version, the WebSocket subprotocol and the relay's two paths.
- `Base64Url` and `RelayId`: the branded values.
- `RelayConfig` and `RelayBinding`: the self-hosted relay's configuration.
- `TunnelTokenRequest`, `TunnelTokenClaims`, `TUNNEL_PROOF_LABEL` and `HandshakeMessage`: the token and the handshake.
- `FRAME_TYPES`, `FRAME_HEADER_BYTES`, `OpenPayload` and `STREAM_CLOSE_REASONS`: the frames.
- `Announcement`, `AnnouncementKind` and `RebindStatement`: announcements and rebinding.
- `TUNNEL_CLOSE_CODES` and `RELAY_HTTP_ERRORS`: the close codes and HTTP errors.
- `RELAY_LIMITS`, `DEFAULT_CT_SOURCE` and `CT_QUERY_INTERVAL_MS`: the limits and certificate monitoring.

## Limits

The package has no runtime code. It depends only on the workspace brand package, for the branded values. A change to a frame, a signed object or a limit is a new protocol version, as the compatibility section of the contract states.
