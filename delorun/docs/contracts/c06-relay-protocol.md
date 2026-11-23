---
description: "Contract C6: the self-hosted relay's protocol: its configuration and name bindings, short-lived tunnel tokens, the home-key challenge on every tunnel, stream framing and flow control, SNI routing of encrypted browser connections, one live tunnel per name, rebinding with a 60-second delay, limits, certificate monitoring, and the Delorun relay as a fast-follow."
---

# Contract C6: relay protocol

English | [中文](c06-relay-protocol.zh.md)

<a id="summary"></a>
## Summary

A relay lets a browser reach a home that accepts no inbound connection. The home opens an outbound WebSocket to the relay and proves its home key; the relay reads only the SNI of each browser connection on port 443 and passes that connection's encrypted bytes over the WebSocket to the home, where TLS ends with the home's own certificate. The relay holds no key of the studio and cannot read its traffic. At Delorun 1.0 the relay is the self-hosted relay, run by the person on their own server and domain from the image in `delorun/apps/relay/`. This page defines its configuration, the tunnel token, the handshake, the frames, SNI routing, the limits, rebinding, announcements and certificate monitoring, and states which rules bind the Delorun relay, a fast-follow. The types package [`@delorun/contract-relay-protocol`](../../packages/contract-relay-protocol/README.md) carries the frame types, codes and limits.

<a id="status"></a>
## Status

The relay's server side is built and parked; no home can use it.

- **Built, reached by nothing:** `delorun/apps/relay`, marked parked, with its configuration checks, the single-use 60-second tunnel token, the home-key challenge, one live tunnel per name with the refusal of a second, framing, flow control and limits, SNI routing and its container image. No home-side relay client exists, so no home opens a tunnel.
- **Does not hold in the relay:** a rebind. The relay checks only that a rebind statement names the binding's name and new key; it does not verify the old key's signature, applies no 60-second delay and announces nothing, and its configuration is read once at start, so an operator who edits the file and restarts rebinds a name silently. The fuzz corpus the Security section names does not exist.
- **Not built:** the home-side relay client, the alerts that announcements raise, certificate monitoring and the refusal to open a tunnel while a certificate is unexplained, and `delorun reach rebind-statement`.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Parties](#parties)
  - [Relay configuration](#relay-configuration)
  - [Tunnel token](#tunnel-token)
  - [Handshake](#handshake)
  - [Frames](#frames)
  - [Flow control](#flow-control)
  - [SNI routing](#sni-routing)
  - [One live tunnel per name](#one-live-tunnel-per-name)
  - [Rebinding](#rebinding)
  - [Announcements](#announcements)
  - [Certificate monitoring](#certificate-monitoring)
  - [Limits](#limits)
  - [Errors](#errors)
  - [Delorun relay](#delorun-relay)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
  - [What this does not prove](#what-this-does-not-prove)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="parties"></a>
### Parties

- **Relay.** The relay data plane in `delorun/apps/relay/`: a Node service that accepts browser connections on TCP port 443 and tunnels from homes. It stores no traffic, holds no studio key and terminates TLS only for its own tunnel host.
- **Token issuer.** The party that issues tunnel tokens. For the self-hosted relay it is the relay process itself, with a token key it generates at its first start. For the Delorun relay it is relay control in the [hosted service](../reference/glossary.md#hosted-service).
- **Relay client.** The home's side in `delorun/packages/reach/`. It obtains a token, opens the tunnel, answers the challenge, and passes each stream to the `reach-self-hosted-relay` listener of [C4](c04-admission.md#listeners), where TLS ends.

Every byte string is base64url without padding, and every signed object is signed over its RFC 8785 serialisation without its `signature` field. The home key and home key id are those of [C5](c05-device-approval.md#keys-and-storage).

<a id="relay-configuration"></a>
### Relay configuration

The self-hosted relay reads one YAML file, `/etc/delorun-relay/relay.yaml` inside its container. Its operator is the person who runs it, and the relay's configuration is the authority for its bindings.

| Field | Value |
| --- | --- |
| `tunnelHost` | The relay's own name, such as `relay.example.com`. The relay terminates TLS for this name only, with `tunnelCertFile` and `tunnelKeyFile`. |
| `tunnelCertFile`, `tunnelKeyFile` | PEM certificate chain and key for `tunnelHost`. |
| `bindings` | A list of `{ name, homePublicKey }`: one studio name, such as `studio.example.com`, and the 32-byte raw Ed25519 public key of the home it belongs to. |
| `bindings[].rebindStatement` | Optional: a [rebind statement](#rebinding) signed by the previously bound key. |
| `bindings[].forceRebind` | Optional, `true` only: the operator replaces a binding without the previous key's signature. |
| `stateDir` | Directory for the token key and the binding history, `/var/lib/delorun-relay` by default. |

The relay refuses to start when a name appears in two bindings, when a home public key appears in two bindings, when `tunnelHost` equals a bound name, or when a name is not a valid DNS host name. The token key is `<stateDir>/token-key.pem`, an Ed25519 key with mode 0600. The relay logs through the `relay` surface of [C20](c20-operational-logs.md).

<a id="tunnel-token"></a>
### Tunnel token

A tunnel token authorises one tunnel attempt for one name and home key.

- **Request.** The relay client sends `POST https://<tunnelHost>/v1/tunnel-token` with `{ "v": 1, "name", "homePublicKey", "timestamp", "signature" }`, signed by the home key. The issuer refuses a request whose `timestamp` differs from its clock by more than 60 seconds, whose signature does not verify, or whose name is not bound to that key.
- **Token.** The answer is `{ "token" }`, where the token is the base64url RFC 8785 serialisation of its claims, a dot and the base64url Ed25519 signature by the issuer's token key. The claims are `{ "v": 1, "iss" (the relay id: the SHA-256 hash of the token public key), "name", "homeKeyId", "jti" (16 random bytes), "iat", "exp" }`, and `exp` is `iat` plus 60 seconds.
- **Single use.** The relay records each `jti` it accepts until the token's `exp` passes, and refuses a token whose `jti` it has seen. It also refuses a token whose `iat` is earlier than its own start, so a restart cannot accept a token issued before it.

<a id="handshake"></a>
### Handshake

1. **Upgrade.** The relay client requests `GET wss://<tunnelHost>/v1/tunnel` with the WebSocket subprotocol `delorun-relay.v1` and the header `Authorization: Delorun-Tunnel <token>`. The relay verifies the token's signature, expiry, unused `jti` and binding before it upgrades, and otherwise answers `401` with the code of [errors](#errors).
2. **Challenge.** The relay sends the text message `{ "type": "challenge", "relayId", "nonce" }` with 32 random bytes in `nonce`.
3. **Proof.** The relay client answers `{ "type": "proof", "signature" }`: the Ed25519 signature by the home key over `"delorun-relay-tunnel-v1" ‖ 0x00 ‖ relayId ‖ name ‖ jti ‖ nonce`. The relay verifies it with the key bound to the token's name.
4. **Live check.** When a tunnel for that name is live, the relay sends `{ "type": "refused", "code": "TUNNEL_ALREADY_LIVE" }`, closes with code 4409 and [announces](#announcements) the attempt to the live tunnel.
5. **Ready.** Otherwise the relay sends `{ "type": "ready", "tunnelId", "limits" }`, where `limits` repeats the [limits](#limits) the relay applies, and the tunnel is live.

Steps 2 to 5 complete within 10 seconds of the upgrade, or the relay closes with 4408. Every tunnel, including a reconnect, repeats the whole handshake with a new token.

<a id="frames"></a>
### Frames

After `ready`, every message is a binary WebSocket message: one byte of frame type, a 4-byte unsigned big-endian stream id, then the payload. Stream id 0 belongs to the tunnel; streams 1 and above are browser connections, numbered by the relay without reuse within a tunnel.

| Type | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | Relay to home | JSON `{ "sni", "clientAddress", "clientPort" }`, at most 1,024 bytes. `clientAddress` is the relay's assertion and is unverified. |
| `0x02` | `DATA` | Both | 1 to 65,536 bytes of the connection's encrypted bytes. The relay's first `DATA` on a stream is the browser's ClientHello. |
| `0x03` | `CREDIT` | Both | A 4-byte unsigned big-endian number of bytes the sender may add ([flow control](#flow-control)). |
| `0x04` | `CLOSE` | Both | One byte: `0` normal, `1` refused, `2` limit, `3` protocol error, `4` timeout. |
| `0x10` | `CONTROL` | Both, stream 0 | JSON at most 16,384 bytes: `announce` from the relay, `pong` and `rebind-pending` acknowledgements from the home. |

An unknown type, a frame shorter than 5 bytes, a stream id that is not open, a `CONTROL` frame on a stream other than 0 or a payload over its limit is a protocol error: the receiver closes the tunnel with 4400, or with 4413 for an oversized payload. The relay sends a WebSocket ping every 15 seconds, and either side closes a tunnel from which it has received nothing for 45 seconds.

<a id="flow-control"></a>
### Flow control

Each direction of each stream starts with 1 MiB of credit. A sender sends `DATA` only within its remaining credit, and the receiver returns `CREDIT` as it forwards or consumes bytes. The relay buffers at most 1 MiB per stream in each direction and withholds credit while the browser connection or the tunnel is slower than its peer. `DATA` beyond the remaining credit closes the stream with reason `3`.

<a id="sni-routing"></a>
### SNI routing

The relay accepts TCP connections on port 443 and reads the TLS ClientHello, at most 16,384 bytes within 10 seconds, without decrypting anything.

- **Tunnel host.** When the SNI equals `tunnelHost`, the relay terminates TLS and serves only `/v1/tunnel-token` and `/v1/tunnel`.
- **Bound name.** When the SNI is a bound name whose tunnel is live and the home has fewer than 64 open streams, the relay sends `OPEN`, then the ClientHello and every later byte as `DATA`, and closes the browser connection when the stream closes.
- **Anything else.** A ClientHello without SNI, a name with no binding or no live tunnel, a 65th concurrent stream, a ClientHello over 16,384 bytes or one not complete within 10 seconds closes the TCP connection without a response.

The relay forwards a ClientHello whose ALPN is `acme-tls/1` like any other, so the home answers a TLS-ALPN-01 challenge only through its key-proven tunnel. The relay serves nothing on port 80 for a bound name, so no HTTP-01 challenge for it can be answered through the relay.

<a id="one-live-tunnel-per-name"></a>
### One live tunnel per name

A name has at most one live tunnel. A second handshake for a live name is refused at the live check even when its token and proof are valid, and the refusal is announced. A tunnel stops being live when it closes or when the relay has received nothing on it for 45 seconds; the relay client reconnects with backoff from 1 second, doubling to at most 60 seconds.

<a id="rebinding"></a>
### Rebinding

Rebinding replaces the home key bound to a name, for example when the home moves to a new computer.

- **Rebind statement.** The old home prints, through `delorun reach rebind-statement <new home public key>`, the statement `{ "v": 1, "name", "previousHomeKeyId", "newHomePublicKey", "issuedAt", "signature" }`, signed by the old home key. The operator places it in the binding's `rebindStatement` with the new key.
- **Forced rebind.** Without the old key, the operator sets `forceRebind: true`. The relay applies it under the same delay and records it in its operational log as forced.
- **Delay and notice.** When the relay reads a changed binding, it announces `tunnel-rebound` to the name's live tunnel at once, keeps the old binding for 60 seconds, then closes the old tunnel with 4410 and accepts only the new key. A statement whose signature does not verify with the previously bound key, without `forceRebind`, is refused and the old binding stays.

<a id="announcements"></a>
### Announcements

The relay sends `{ "type": "announce", "kind", "at", "clientAddress", "jti" }` on stream 0 of the name's live tunnel. `kind` is `second-tunnel-refused` or `tunnel-rebound`; `clientAddress` is the relay's unverified assertion; `jti` names the refused token. The home raises the [C5 alert](c05-device-approval.md#alerts) of the same kind, except for a `second-tunnel-refused` whose `jti` is one of its own attempts from the last 60 seconds.

<a id="certificate-monitoring"></a>
### Certificate monitoring

A running home with own-domain reach watches public Certificate Transparency logs for certificates that cover its names.

- **Source.** The home queries `https://api.certspotter.com/v1/issuances?domain=<registrable domain>&include_subdomains=true&expand=dns_names` every 30 minutes. The source is the configuration row `certificates.ctSource`, whose default is that URL. A query reveals the home's IP address and the queried domain to the source.
- **Coverage.** A certificate covers a name when one of its DNS names equals the name, or is `*.<parent>` where `<parent>` is the name without its first label. Every name of a multi-name certificate is checked.
- **Requested certificates.** The home records the SHA-256 hash of each certificate and precertificate its own ACME account obtained. A covering certificate whose hash is not recorded is unrequested, until the person marks it explained from the loopback listener or with `delorun certificates explain <SHA-256>`, or until it expires.
- **Refusal.** While an unrequested certificate is unexplained, the home raises `unrequested-certificate` and its relay client closes the tunnel and opens none.
- **Delay.** Detection waits for a log to include the certificate and for the next query, a delay that each log's inclusion policy bounds; during that delay the refusal cannot apply.

`ts.net` names are not monitored: Tailscale obtains their certificates ([C7](c07-reach-providers.md#visibility-notes)).

<a id="limits"></a>
### Limits

| Limit | Value |
| --- | --- |
| Live tunnels per name and per home | 1 |
| Concurrent streams per home | 64 |
| Buffer per stream, each direction | 1 MiB |
| `DATA` payload | 65,536 bytes |
| `OPEN` payload | 1,024 bytes |
| `CONTROL` payload | 16,384 bytes |
| ClientHello | 16,384 bytes, read within 10 seconds |
| Handshake | 10 seconds from the upgrade |
| Tunnel token | 60 seconds, single use |
| Token request clock skew | 60 seconds |
| Rebinding delay | 60 seconds |
| Ping interval and silence limit | 15 seconds and 45 seconds |
| Reconnect backoff | 1 second, doubling to 60 seconds |
| Certificate query interval | 30 minutes |

<a id="errors"></a>
### Errors

| Code | Where | Raised when |
| --- | --- | --- |
| `TOKEN_REQUEST_INVALID` | `400` on `/v1/tunnel-token` | A malformed request or a signature that does not verify. |
| `TOKEN_REQUEST_STALE` | `401` on `/v1/tunnel-token` | A `timestamp` more than 60 seconds from the issuer's clock. |
| `NAME_NOT_BOUND` | `403` on `/v1/tunnel-token` | The name is not bound to the presented key. |
| `TUNNEL_TOKEN_INVALID` | `401` on `/v1/tunnel` | A token with a bad signature, an expiry in the past or a binding that changed. |
| `TUNNEL_TOKEN_REPLAYED` | `401` on `/v1/tunnel` | A token whose `jti` the relay has accepted. |
| `PROOF_INVALID` | Close 4401 | A proof that does not verify with the bound key. |
| `TUNNEL_ALREADY_LIVE` | Close 4409 | A second tunnel for a live name. |
| `HANDSHAKE_TIMEOUT` | Close 4408 | The handshake did not complete within 10 seconds. |
| `PROTOCOL_ERROR` | Close 4400 | A malformed or unexpected frame. |
| `FRAME_TOO_LARGE` | Close 4413 | A payload over its limit. |
| `REBOUND` | Close 4410 | The name was rebound to another key. |

<a id="delorun-relay"></a>
### Delorun relay

The Delorun relay, on `delo.run` names with relay control in the hosted service, is not part of Delorun, which contains no Delorun relay client and no relay control ([roadmap](../guide/roadmap.md)). The relay data plane, the frames, SNI routing, the handshake and the limits above apply to it unchanged, with relay control as the token issuer. These rules also bind it:

- A name is never reassigned to another account, and a random name is never reused.
- Rebinding needs the bound key's signature; there is no forced rebind.
- Per-account limits and a per-name kill switch apply.
- DNS-01 challenges for `delo.run` names are delegated by CNAME to a scoped challenge zone, which relay control writes only after a home-key proof.
- The Public Suffix List entry for `delo.run` counts as in place only once current releases of Chromium, Firefox and Safari ship it.

The self-hosted relay's operator is its owner, so the Delorun relay's per-account limits and kill switch do not apply to it.

<a id="consumers"></a>
## Consumers

- `delorun/apps/relay/`: the relay data plane, the token issuer, configuration loading and the self-hosting image.
- `delorun/apps/relay/tests/fuzz/`: the fuzz corpus for the frame parser, the ClientHello reader and the control messages.
- `delorun/packages/reach/`: the relay client, the token request, the handshake and the handoff of streams to `reach-self-hosted-relay`.
- `delorun/packages/certificates/`: certificate monitoring and the refusal while a certificate is unexplained.
- `delorun/packages/contract-relay-protocol/`: the frame types, close codes, error codes and limits.
- [C5](c05-device-approval.md#alerts) for the alerts that announcements raise, [C7](c07-reach-providers.md) for the self-hosted relay provider and its own-domain rules.

<a id="compatibility"></a>
## Compatibility

The protocol version is the subprotocol `delorun-relay.v1` and the `v` field of every signed object. A relay refuses an upgrade without that subprotocol, and a home refuses a `ready` whose `limits` exceed this page's. A change to a frame, a signed object or a limit is a new subprotocol version; a relay may serve two versions while homes move between them. A new frame type is a new version, because an unknown type is a protocol error.

<a id="security"></a>
## Security

Requirements:

- Every tunnel proves possession of the bound home key against a fresh relay nonce, and carries a single-use tunnel token that expires after 60 seconds.
- A name has at most one live tunnel; a second, even with a valid key, is refused and announced to the live tunnel, and the home alerts its trusted devices.
- Rebinding needs the previously bound key's signature or the operator's explicit forced rebind, waits 60 seconds and is announced.
- The relay reads only SNI and passes encrypted bytes it cannot read; it holds no TLS key for a bound name, and its own TLS key serves only `tunnelHost`.
- Per-stream buffers are capped at 1 MiB in each direction, and a home has at most 64 concurrent streams.
- Client addresses the relay asserts are unverified everywhere the home uses them.
- The home answers TLS-ALPN-01 only through its key-proven tunnel, and the relay answers no HTTP-01 challenge for a bound name.
- Certificate monitoring matches exact, wildcard and multi-name certificates, and the home opens no tunnel while an unrequested certificate is unexplained.
- Every parser of relay input has the limits above and a fuzz corpus.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `a second valid-key tunnel is refused and announced` | With a tunnel live for a name, a second handshake with a valid token and proof closes with 4409, and the live tunnel receives `announce` with kind `second-tunnel-refused`, which raises the C5 alert. |
| `a replayed tunnel token is refused` | A token that opened a tunnel is refused with `TUNNEL_TOKEN_REPLAYED` when presented again before its expiry, and a token issued before a relay restart is refused after it. |
| `an expired tunnel token is refused` | A token presented 61 seconds after `iat` is refused with `TUNNEL_TOKEN_INVALID`. |
| `a proof by another key is refused` | A handshake whose proof is signed by a key other than the bound one closes with 4401. |
| `a token for one name cannot open another` | A token issued for one name, with a proof by that name's key, opens no tunnel for a second bound name. |
| `the relay holds no key for a bound name` | A browser completes a TLS handshake for a bound name only with the home's certificate, and the relay's files hold no private key other than the token key and the tunnel host's key. |
| `a rebind without the previous key's signature is refused` | A changed binding whose `rebindStatement` does not verify, without `forceRebind`, leaves the old binding in force. |
| `a rebind waits 60 seconds and is announced` | A valid rebind announces `tunnel-rebound` at once and accepts the new key only after 60 seconds. |
| `per-stream buffers and the stream limit hold` | `DATA` beyond the remaining credit closes the stream, the relay's buffer for one stream never exceeds 1 MiB, and a 65th concurrent browser connection is closed. |
| `oversized and malformed frames close the tunnel` | A `DATA` payload over 65,536 bytes closes with 4413, and an unknown frame type closes with 4400. |
| `a wildcard certificate for the home's domain raises the alert` | A fixture `*.example.com` certificate, and a multi-name certificate listing the home's name, unrecorded by the home's ACME account, each raise `unrequested-certificate` and close the relay tunnel. |
| `an unexplained certificate keeps the tunnel closed` | While the alert is unexplained, the relay client opens no tunnel; after it is explained from the loopback listener, the tunnel opens. |

<a id="what-this-does-not-prove"></a>
### What this does not prove

- **The certificate log window.** Monitoring sees a certificate only after a log includes it and the next query runs, a delay that each log's inclusion policy bounds. During that delay the tunnel stays open, and an interceptor holding that certificate is not detected.
- **The alert page on an intercepted path.** An interceptor that serves its own page drops the home's alert page on that path; the home closes the tunnel when it detects the certificate, and the alert reaches the person through the channels of [C5](c05-device-approval.md#alerts) that do not use the relay.
- **The relay operator.** The relay sees each connection's name, client address, timing and volume, can refuse or drop any connection, and, on the self-hosted relay, can rebind a name with `forceRebind`. Its operator is the person, so this contract protects the studio's content from the relay, not the relay's service.
- **Addresses.** The relay's `clientAddress` is its own assertion, and nothing on the home can check it.

<a id="decided-values"></a>
## Decided values

- Rebinding delay: 60 seconds.
- Per home: one live tunnel and 64 concurrent streams.
- Buffer per stream: 1 MiB in each direction.
- Tunnel tokens: 60 seconds, single use.
- Frame limits: 65,536 bytes of `DATA`, 1,024 bytes of `OPEN` and 16,384 bytes of `CONTROL` and of ClientHello.
- Certificate monitoring: Cert Spotter's issuance search every 30 minutes, configurable.
