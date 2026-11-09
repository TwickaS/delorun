---
description: "The self-hosted relay of contract C6: the configuration and its start refusals, the tunnel token, the handshake and close codes, the frame limits and flow control, SNI routing on port 443, the peer facts it asserts, the container image, C20's relay log, and the specs that prove each refusal."
---

# The self-hosted relay

English | [中文](README.zh.md)

## Summary

This app is the relay data plane of [contract C6](../../docs/contracts/c06-relay-protocol.md): one Node service that accepts browser connections on TCP port 443 and the homes' outbound WebSocket tunnels, then passes each browser connection's encrypted bytes to the home that registered its name.
The person runs it on their own server and domain.
`delo/packages/reach/` is the home's side of the same contract, and `@delo/contract-relay-protocol` carries the frame types, codes and limits.

The data plane takes no socket of its own: `src/relay.ts` holds the state and every refusal, and `src/node/server.ts` is the transport that reads the ClientHello, terminates TLS for the tunnel host and upgrades the tunnel.
A spec therefore drives the whole plane through in-memory connections, and one spec drives it through the real listener on loopback.

## What the relay can and cannot see

- **It reads each browser connection's SNI name and nothing else of it.** The ClientHello reader in `src/client-hello.ts` parses the first TLS record to the `server_name` extension and stops; every later byte is a `DATA` payload it moves.
- **It terminates TLS for its own tunnel host only.** `tunnelCertFile` and `tunnelKeyFile` name one certificate; a bound name's handshake ends at the home, which is the only holder of that name's key.
- **It holds no studio key.** The configuration holds a home's public key per bound name and one token key of the relay's own.
- **It asserts the browser's peer address, and the home cannot check it.** The `OPEN` frame's `clientAddress` and `clientPort` are what the relay's socket observed, marked `verified: false` in the data plane ([`peer.ts`](src/peer.ts)); C6 calls them an assertion, and no field of the frame claims otherwise.
- **It cannot route across homes.** A browser connection reaches the one tunnel whose bound name equals the ClientHello's SNI, and a frame a home sends is resolved in that home's own stream map.
- **It cannot keep going after a home leaves.** A tunnel that closes ends every browser connection it owns in the same turn, and the name accepts the next handshake.
- **It cannot read a stream it refuses to carry.** An unbound name, a hello without SNI, a hello over 16,384 bytes and a name without a live tunnel are closed without a response.

## Configuration

The container reads `/etc/delo-relay/relay.yaml`, or the file `DELO_RELAY_CONFIG` names.

| Field | Value |
| --- | --- |
| `tunnelHost` | The relay's own name. It terminates TLS for this name only. |
| `tunnelCertFile`, `tunnelKeyFile` | The PEM chain and key for `tunnelHost`. |
| `bindings` | `{ name, homePublicKey }` entries: one studio name and the 32-byte raw Ed25519 home public key bound to it. |
| `bindings[].rebindStatement` | Optional. The statement must name its own binding and its binding's `homePublicKey`. |
| `bindings[].forceRebind` | Optional, `true` only. It is refused beside a `rebindStatement`. |
| `stateDir` | Where the token key lives. `/var/lib/delo-relay` by default. |

The relay refuses to start when a name appears in two bindings, when one home key is bound to two names, when `tunnelHost` is a bound name, when a name or the tunnel host is not a DNS host name, and when a rebind statement does not describe its own binding.
`CONFIG_INVALID` names the field; `CONFIG_UNREADABLE` names the file.

The token key is `<stateDir>/token-key.pem`, an Ed25519 PKCS #8 key created at the first start at mode 0600.
An existing key that another user can read, that is a symbolic link or that is not Ed25519 is refused with `TOKEN_KEY_UNPROTECTED` rather than replaced.
The relay id is the base64url SHA-256 hash of the token public key's 32 raw bytes.

## Tunnel token

`POST /v1/tunnel-token` takes `{ v, name, homePublicKey, timestamp, signature }`, where the signature is the Ed25519 signature by the home key over the RFC 8785 serialization of the object without `signature`.
It answers `{ token }`, or one of these refusals:

| Status | Code | When |
| --- | --- | --- |
| 400 | `TOKEN_REQUEST_INVALID` | The body is not the schema, the key is not 32 bytes, or the signature does not verify. |
| 401 | `TOKEN_REQUEST_STALE` | `timestamp` is more than 60 seconds from the relay's clock. |
| 403 | `NAME_NOT_BOUND` | The name is not bound to the presented key. |

The token is the base64url RFC 8785 claims, a dot and the base64url Ed25519 signature by the token key.
Its claims are `{ v, iss, name, homeKeyId, jti, iat, exp }`: `iss` is the relay id, `jti` is 16 random bytes, `exp` is `iat` plus 60 seconds, and every instant is milliseconds since the epoch.
The relay refuses a token whose signature does not verify, whose `iss` is another relay, whose binding changed, whose `exp` has passed, whose `iat` is before the relay started, and whose `jti` it already accepted.

## Handshake

`GET wss://<tunnelHost>/v1/tunnel` needs the subprotocol `delo-relay.v1` and `Authorization: Delo-Tunnel <token>`, and the relay checks both before it upgrades the request: an upgrade without the subprotocol answers 400 `SUBPROTOCOL_MISSING`, and a missing, forged, expired or replayed token answers 401 with C6's code.

After the upgrade the relay sends `{"type":"challenge","relayId","nonce"}`, and the home answers `{"type":"proof","signature"}`: the Ed25519 signature by the bound home key over the UTF-8 bytes of `delo-relay-tunnel-v1`, one zero byte, then `relayId`, `name`, `jti` and `nonce`.
A proof that does not verify closes with 4401.
When another tunnel is live for the name, the relay answers `{"type":"refused","code":"TUNNEL_ALREADY_LIVE"}`, closes with 4409 and sends the live tunnel an `announce` of kind `second-tunnel-refused` carrying the refused token's `jti`.
Otherwise it answers `{"type":"ready","tunnelId","limits"}` and the name is live.
The handshake completes within 10 seconds or the relay closes with 4408.

| Close code | Code | When |
| --- | --- | --- |
| 4400 | `PROTOCOL_ERROR` | A malformed or unexpected frame or message, a frame for a stream the tunnel never opened, or 45 seconds without receiving anything, a WebSocket pong included. |
| 4401 | `PROOF_INVALID` | The proof does not verify with the bound key. |
| 4408 | `HANDSHAKE_TIMEOUT` | The handshake did not complete within 10 seconds. |
| 4409 | `TUNNEL_ALREADY_LIVE` | A second handshake for a live name. |
| 4413 | `FRAME_TOO_LARGE` | A payload over its limit. |

## Frames and flow control

After `ready` every message is binary: one type byte, a 4-byte big-endian stream id, then the payload.
Stream 0 is the tunnel's; streams 1 and above are browser connections, numbered by the relay per tunnel without reuse.

| Type | Name | Payload | Limit |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | JSON `{ sni, clientAddress, clientPort }`, relay to home | 1,024 bytes |
| `0x02` | `DATA` | 1 to 65,536 bytes of the connection's encrypted bytes | 65,536 bytes |
| `0x03` | `CREDIT` | A 4-byte big-endian number of bytes the sender may add | 4 bytes |
| `0x04` | `CLOSE` | One reason byte: 0 normal, 1 refused, 2 limit, 3 protocol error, 4 timeout | 1 byte |
| `0x10` | `CONTROL` | JSON on stream 0: `announce` from the relay, `pong` and `rebind-pending` from the home | 16,384 bytes |

Each direction of each stream starts with 1 MiB of credit.
The relay sends a `DATA` frame only within the credit the home granted, holds at most 1 MiB of the browser's bytes while it waits for credit, and pauses the browser connection at that cap.
It grants the home credit only as the browser's transport takes the bytes, so its own buffer for the home's payloads stays within 1 MiB too.
A side that sends beyond its credit closes the stream with reason 3.
A home has at most 64 concurrent streams; the 65th browser connection is closed without an `OPEN` frame.

## SNI routing

Every TCP connection's first ClientHello is read to `server_name`, at most 16,384 bytes within 10 seconds, and nothing is decrypted.
When the name is `tunnelHost` the relay terminates TLS and serves `/v1/tunnel-token` and `/v1/tunnel` there and nothing else.
When the name is a bound name with a live tunnel the relay sends `OPEN`, then the ClientHello and every later byte as `DATA`.
A hello without SNI, a name with no binding or no live tunnel, a 65th stream and a hello over the limit are closed without a response.
A hello whose ALPN is `acme-tls/1` is forwarded like any other, so a TLS-ALPN-01 challenge is answered only through the home's key-proven tunnel; the relay serves nothing on port 80.

## The image

The data plane imports C6's contract package and C20's logger from this repository, so the image builds from the repository root, from a clean checkout:

```sh
git archive HEAD | docker build -f delo/apps/relay/Dockerfile -t delo-relay -
docker run --rm \
  -p 443:443 \
  -v /etc/delo-relay:/etc/delo-relay:ro \
  -v delo-relay-state:/var/lib/delo-relay \
  -v delo-relay-logs:/var/log/delo-relay \
  delo-relay
```

The image runs the entry through this repository's tsx launcher, `node --import tsx/esm delo/apps/relay/src/node/main.ts`, because Node 24 cannot strip the types of every workspace package the relay imports.
`DELO_RELAY_CONFIG` names another configuration file and `DELO_RELAY_PORT` another port; C6 fixes 443.
The process stops on `SIGTERM` and `SIGINT`, and it reports a start failure as its code and detail.
The image runs as its `node` user, which must read the configuration and its certificate files and write the state and log volumes; a mounted configuration at mode 0600 therefore needs a group that user is in.
A named volume takes the image's mode-0700 state and log directories; a bind-mounted directory must be prepared at mode 0700 and owned by the container user, because C20 refuses a log directory another user can reach.

## The log

The relay writes C20's `relay` surface at `/var/log/delo-relay/relay.log` through `@delo/logs`: the listening port, each accepted or refused attempt, each live and closed tunnel, each routed or dropped browser connection.
Every token the relay handles is registered with the redactor as a `relay-key`, so a token cannot reach the file even from a message that carries one.
An accepted id's `jti` stays in memory and never reaches the log.
The app also registers a driver for C20's cross-surface denial suite (`delo/packages/logs/tests/denial/`), so that suite's secret, rotation, mode and clear tests run over this surface too.

## Specs

`delo/apps/relay/tests` proves each refusal; the spec that names a check fails when that check is removed, because the attempt it must refuse is paired with one that succeeds.

| Spec | Proves |
| --- | --- |
| `config.spec.ts` | The bindings and ids, each start refusal of C6, a rebind statement's self-consistency, the token key's mode, identity and refusals. |
| `token.spec.ts` | The request signature, the clock skew, the binding, the expiry, the restart rule, single use, the canonical claims a token signs. |
| `frames.spec.ts` | Every round trip, each payload limit, the stream and header rules, and a deterministic corpus of malformed messages that answers refusals only. |
| `client-hello.spec.ts` | The SNI in one chunk and in pieces, a hello without it, the record and size limits, a split hello, a name that is not a host name. |
| `handshake.spec.ts` | `ready`, the pre-upgrade refusals including a token whose signature is forged or another token key's, a proof by another key, the 10-second limit, a second valid-key tunnel refused and announced, a token for one name that opens none for another, frames before `ready`. |
| `routing.spec.ts` | One home per name, no prefix match, a frame resolved in its own home's map, an `OPEN` a home may not send, the peer facts, the 64-stream limit. |
| `stream.spec.ts` | Opaque bytes in both directions, the DATA limit, the credit rule in both directions, the 1 MiB held-bytes cap, the browser's backpressure. |
| `teardown.spec.ts` | A home's disconnect ends every browser connection it owns at once, the name accepts the next handshake, another name is untouched, the stall limit, which a WebSocket pong from the home resets, the relay's own shutdown. |
| `logging.spec.ts` | C20's fields, the token registered as a secret, a refusal recorded with its code and no token. |
| `node/end-to-end.spec.ts` | Over loopback: a browser's handshake completes only with the home's certificate, the bytes round-trip, the home receives the browser socket's own address and port, the log holds no plaintext, and the token endpoint answers C6's statuses. |

## Files

- `src/config.ts`: the configuration, the bindings, the token key and the relay id.
- `src/token.ts`: the token request, the token and its checks.
- `src/tunnel.ts`: the handshake, the live check, the announcements and the frame loop.
- `src/stream.ts`: one stream's flow control, buffers and close.
- `src/relay.ts`: the data plane's state and every refusal a transport asks for.
- `src/frames.ts`, `src/client-hello.ts`, `src/peer.ts`, `src/keys.ts`, `src/errors.ts`: the codecs, the SNI reader, the peer assertion, the key primitives and the typed refusals.
- `src/log.ts`: C20's `relay` surface.
- `src/node/server.ts`, `src/node/main.ts`: the TCP listener, the tunnel host's TLS, the HTTP endpoints and the entry point.

## Not in this app yet

- **Rebinding's 60-second delay and announcement.** The configuration checks a rebind statement's self-consistency, and a changed binding's statement, its delay and C6's `tunnel-rebound` announcement wait for the binding history in `stateDir`.
- **Certificate monitoring.** C6 gives it to `delo/packages/certificates/`.
- **The Delo relay.** Relay control and `delo.run` names are C6's fast-follow, and the data plane serves the self-hosted relay only.
