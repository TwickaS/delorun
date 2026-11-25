---
description: "Contract C4: the admission seam in upstream's connection, the loopback and reach listeners with their scheme and Host rule, authentication in the dispatcher before any route or upgrade, the pre-login allowlist, server-side sessions with their lifetimes and rotation, and the reach listeners' response headers, Content Security Policy and Trusted Types."
---

# Contract C4: admission and listeners

English | [中文](c04-admission.zh.md)

<a id="summary"></a>
## Summary

Admission decides, for every HTTP request and every upgrade that reaches a home's Host, whether it may proceed and which Peer it speaks for. Upstream's connection admits every authenticated browser as one shared owner Peer and leaves each route to authenticate itself. Delorun adds an Authenticator Service Definition to upstream's connection, a second kind of listener for reach, and authentication in the reach listener's dispatcher before any route, upgrade or fallback. This page defines the Authenticator, the listeners with their declared scheme and `Host` rule, the dispatch order, the pre-login allowlist, the session store with its cookie, lifetimes and rotation, and the response headers of a reach listener. The types package [`@delorun/contract-admission`](../../packages/contract-admission/README.md) carries the identifiers, codes and limits.

<a id="status"></a>
## Status

The loopback listener runs with upstream's admission. The Tailscale private reach listener runs only while the person has turned reach on, admitted by `@delorun/home-auth`; no other reach listener is opened.

- **Built and reached:** the loopback listener at `127.0.0.1:3080` in the CLI profile, which admits a [one-time launch token](#launch-tokens) that `delorun open` and the start obtain from the home process, `/connect` and upstream's stateless `dsh-auth-*` cookies, as [sessions](#sessions) states, with upstream's `Host` and `Origin` checks on `/api` and `/connect`. Upstream's connection announces each loopback mint with `authenticator/minted`, and nothing listens to it.
- **Built and reached while reach is on:** the `authenticator` Service Definition, which `@delorun/home-auth` provides in every CLI profile and which keeps upstream's admission on the loopback listener; the Tailscale private reach listener with the dispatch order, the refusal of upstream credentials, the response headers, the Content Security Policy, the Trusted Types header and the remote-image placeholder; the pre-login routes except the passkey, OpenID Connect and recovery routes; and reach sessions with creation, rolling, rotation and the idle and absolute limits.
- **Built, reached by nothing:** the Funnel and relay reach listeners, which only tests open.
- **Not built:** the passkey, OpenID Connect and recovery routes of the pre-login allowlist; the loopback credential records, the 7-day idle limit and the rotation of loopback credentials, and `delorun devices reset`, which are in the [reach design](../design/reach.md#loopback-credentials); and a Content Security Policy on the loopback studio. Loopback credentials are upstream's launch cookie and API credential, admitted by upstream's built-in admission; no per-credential record exists, so no request is refused for lacking one.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Authenticator](#authenticator)
  - [Listeners](#listeners)
  - [Dispatch order](#dispatch-order)
  - [Pre-login allowlist](#pre-login-allowlist)
  - [Sessions](#sessions)
  - [Page unlock](#page-unlock)
  - [Launch tokens](#launch-tokens)
  - [Rotation and revocation](#rotation-and-revocation)
  - [Response headers](#response-headers)
  - [Trusted Types](#trusted-types)
  - [Refusals](#refusals)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
  - [What this does not prove](#what-this-does-not-prove)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="authenticator"></a>
### Authenticator

The admission seam has three roles. The Service Definition is the Cordis service `authenticator`, an abstract class `Authenticator` that upstream's `@deepseek-ai/dsh-client-connection` declares. No package provides it: while no provider is registered, upstream's connection admits with its own launch-token and `dsh-auth-*` cookie admission, unchanged. Delorun's provider is specified below and is not built; `@delorun/home-auth` does not provide `authenticator`. Its consumers are upstream's `HostConnectionService` and the reach listeners' dispatcher in the same package.

- **`admit(request, listener)`** returns an `Admission` for one request on one listener. It is synchronous: it reads only the provider's in-memory state and never awaits, performs I/O or calls another service that does. Upstream's `admit()` and `admitConnection()` call it before they return.
- **`policy(listener)`** returns the `ListenerPolicy` of one listener: its declared scheme, its `Host` rule, its pre-login allowlist and whether launch tokens are accepted. The dispatcher reads the policy once when the listener starts and again when the provider announces a change.
- **State changes** happen outside `admit`. The provider's own pre-login routes verify device signatures, passkey assertions and OpenID Connect responses asynchronously, then update the in-memory state that `admit` reads. Persistence of that state follows [sessions](#sessions).

An `Admission` is one of three results:

| Result | Fields | Meaning |
| --- | --- | --- |
| `admitted` | `peer`, `deviceId`, `sessionId`, optional `setCookie` | The request proceeds and speaks for `peer`. `setCookie` carries a rolled or rotated cookie the dispatcher adds to the response. |
| `pre-login` | `route` | The request is unauthenticated and its method and path are on the listener's pre-login allowlist. Only that route may answer it. |
| `refused` | `status`, `code` | The dispatcher answers `status` with the body `{"error":"<code>"}` and dispatches nothing. |

**One Peer per device.** The provider creates one Peer for each trusted device on each listener it is admitted on, through upstream's `createPeer`. The Peer's principal is `{ kind: 'reach-device', deviceId }`, never upstream's owner, so upstream's Gateway decides each call and each forwarded event of the Peer from the `reach-device` remote access policy the provider registers, which allows only what [C14](c14-oidc-passkeys.md#tailnet-membership) allows a device; the provider keeps the map from Peer id to device id. The Peer is disposed when the device is removed, when its last session ends or when the listener stops, and disposing it ends every stream that speaks for it.

<a id="listeners"></a>
### Listeners

A home's Host runs one loopback listener and, while reach is on, one reach listener for each active reach option of [C7](c07-reach-providers.md). Each listener has its own address, its own policy and its own declared scheme. The scheme is part of the policy, not derived from the socket, because `tailscaled` ends TLS and forwards plain HTTP, so a listener's `Secure` cookie decision follows the scheme the browser sees.

| Listener id | Bound to | Declared scheme | TLS ends at | `Host` rule | Sign-in |
| --- | --- | --- | --- | --- | --- |
| `loopback` | Upstream's web server address, `127.0.0.1:3080` in Delorun's profiles | `http` | No TLS | Upstream's fence: a loopback name or the bind address | A [one-time launch token](#launch-tokens) at the root and at `/connect` |
| `reach-tailscale-private` | The Tailscale private target of [C7](c07-reach-providers.md#tailscale-serve-target): a TCP port on `127.0.0.1`, or the Unix socket of C7's socket variant | `https` | `tailscaled` | Equals the configured `ts.net` address, with its port when it is not 443 | [Session](#sessions) after device key and identity factor |
| `reach-tailscale-funnel` | A TCP port on `127.0.0.1`, separate from the private target | `https` | `tailscaled` | Equals the configured Funnel address, with its port when it is not 443 | As above |
| `reach-self-hosted-relay` | No address: it accepts only the streams the relay client of [C6](c06-relay-protocol.md) passes to it inside the home process | `https` | The listener, with the home's own certificate | Equals the bound name and equals the connection's SNI | As above |

- **No host override.** No configuration field sets a reach listener's address. A TCP reach listener binds `127.0.0.1` with a port the operating system assigns, and the reach provider reads the bound port. A profile row that sets `host` or `port` for a reach listener fails at load with `REACH_LISTENER_HOST_OVERRIDE`.
- **Port reuse.** The loopback listener and the reach listeners never share a port or a socket.
- **Reach listeners depend on home-auth.** A reach listener starts only while `@delorun/home-auth` provides `authenticator`. When the provider is removed or replaced, every reach listener closes its connections and stops before the replacement serves a request, and reach does not fall back to upstream's cookies.

<a id="dispatch-order"></a>
### Dispatch order

A reach listener applies these steps, in this order, to every HTTP request and every upgrade request, before any route, upgrade handler or the fallback runs.

1. **Header removal.** The listener removes every request header whose name begins with `tailscale-` (in any case), except on the listener and under the condition that [C7](c07-reach-providers.md#identity-headers) names.
2. **`Host` rule.** A request whose `Host` does not satisfy the listener's rule is refused with `421 HOST_MISMATCH`. A loopback name or address (`localhost`, `127.0.0.1`, `[::1]`, any `127.0.0.0/8` address) never satisfies a reach listener's rule.
3. **SNI.** On `reach-self-hosted-relay`, a request whose `Host` differs from the TLS connection's SNI is refused with `421 SNI_MISMATCH`.
4. **Origin.** A request whose `Origin` header is present and is not the listener's address, or whose `Sec-Fetch-Site` is `cross-site`, is refused with `403 ORIGIN_MISMATCH`. An upgrade request without an `Origin` header is refused the same way.
5. **Upstream credentials.** A request carrying a `token` query parameter is refused with `401 LAUNCH_TOKEN_REFUSED`, a request for `/connect` with `401 CONNECT_REFUSED`, and a request carrying a cookie whose name begins with `dsh-auth-` with `401 UPSTREAM_COOKIE_REFUSED`.
6. **Admission.** The dispatcher calls `admit`. An `admitted` request continues to the route, upgrade handler or fallback that matches it. A `pre-login` request goes only to its allowlisted route. Any other request is refused with `401 NOT_SIGNED_IN`, or with the code of the `refused` result; a refused upgrade receives the status line and the socket is closed. A `refused` result may name a `location`: the dispatcher then answers a `GET` or `HEAD` request with `303 See Other` to it instead, provided it is a path on the listener's own origin (one leading `/` not followed by `/` or `\`, and no `\`, control character or space). Delorun names `/auth/sign-in` for a browser navigation without a live session (`Sec-Fetch-Mode: navigate`, or `Accept` naming `text/html` without fetch metadata), with the target as `next` when it is a plain path outside `/auth`; a script's request, a state change and an upgrade keep the JSON refusal, and the loopback listener never redirects.

The loopback listener applies upstream's fence and calls `admit` for its routes as upstream does; steps 1 to 5 are specific to reach listeners.

**Arrival fails closed.** The provider stamps every request a reach listener passes to `admit` with that listener's id before any route runs. A route that answers only on the loopback listener, such as the owner claim and the device routes of [C5](c05-device-approval.md), treats a request as loopback only when it carries no stamp and the loopback listener's own socket accepted it: the socket's local port is the configured listener's bound port and its local address a loopback address. A request with neither is never loopback, so a reach listener that forwarded a request without a stamp gains nothing, and the route also requires a loopback `Host`.

The loopback listener's fence is upstream's `api-request-trust.ts` with Delorun's recorded edits, applied to `/api` and to every route that calls `requestRejection`, such as the studio's dist files other than its install files:

- **`Host`.** The `Host` must be a loopback name or address, the listener's bind address, or a `trustedHosts` entry, written as a bare authority. Every listener of upstream's web server answers a request or upgrade with more than one `Host` line `400` before the fence or any route runs.
- **Origin account.** A present `Origin` must be the listener's own origin, and `Sec-Fetch-Site: cross-site` is refused. A state-changing request (any method but `GET`, `HEAD` and `OPTIONS`) whose target is `/api` or below must also state its origin: an `Origin`, or `Sec-Fetch-Site: same-origin` or `none`; `same-site` and `cross-origin` are refused. The target is read as the router reads it, through WHATWG URL parsing, so a dot segment (`/x/../api`) or its percent-encoded spelling (`/x/%2e%2e/api`) cannot move a request out of the rule.
- **Markerless requests.** A state-changing `/api` request with neither `Origin` nor `Sec-Fetch-Site` passes only toward a loopback `Host` or a listener whose scheme is `https`, where a browser that sends Fetch-Metadata always attaches it, so a missing marker names a non-browser caller such as a script, `curl` or the desktop forwarder. Over plain HTTP toward any other authority, a `trustedHosts` name or a non-loopback bind address, it is refused with `403`: a browser withholds the markers there and a no-referrer form post withholds `Origin` too, so the request cannot be told apart from a forged one. A script calling such a listener sends `Origin` naming it ([upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.1/api-origin-over-plain-http/guide.md)).

<a id="pre-login-allowlist"></a>
### Pre-login allowlist

Before sign-in, a reach listener serves only these exact method and path pairs. Every other path, every upgrade and the fallback answers `401` before sign-in.

| Method and path | Owner | Purpose |
| --- | --- | --- |
| `GET /auth/sign-in` | `@delorun/home-auth` | The sign-in page, served before the studio boots. It loads only the assets below and no plugin code. |
| `GET /auth/assets/<asset>` | `@delorun/home-auth` | The sign-in page's own built assets: content-hashed `.js` and `.css` files. |
| `POST /auth/device/request` | `@delorun/home-auth` | An approval request from a new device ([C5](c05-device-approval.md#approval-request)). |
| `GET /auth/device/request/<request id>` | `@delorun/home-auth` | The state of one approval request, read with its request secret. |
| `POST /auth/device/challenge` | `@delorun/home-auth` | A fresh device-key challenge ([C5](c05-device-approval.md#sign-in)). |
| `POST /auth/session` | `@delorun/home-auth` | Session creation and rotation from a device-key signature and, for creation, an identity-factor proof. |
| `POST /auth/passkey/options` | `@delorun/home-auth` | WebAuthn options for the listener's address ([C14](c14-oidc-passkeys.md#passkeys)). |
| `GET /auth/oidc/start` | `@delorun/home-auth` | The start of an OpenID Connect sign-in ([C14](c14-oidc-passkeys.md#authorization-flow)). |
| `GET /auth/oidc/callback` | `@delorun/home-auth` | The redirect URI of that sign-in. |
| `POST /auth/recovery` | `@delorun/home-auth` | Use of the recovery kit ([C5](c05-device-approval.md#recovery-kit)). |
| `POST /auth/owner/claim` | `@delorun/home-auth` | Answers `403 OWNER_CLAIM_LOOPBACK_ONLY` on every reach listener without reading the body, except where [C5](c05-device-approval.md#owner-claim) allows a claim on the Tailscale private target. |

A listener's policy lists only the routes of this table that the home builds; in `0.1.0` that is every row except the passkey, OpenID Connect and recovery routes. A plugin route joins a reach listener's pre-login allowlist only when the profile's `home-auth` configuration lists its exact method and path in `preLoginRoutes`. A plugin's own declaration adds nothing. After sign-in, `admit` passes a reach request only when its target is a plain path, matched without its query, on `@delorun/home-auth`'s `REACH_DEVICE_PATHS` (the studio page and its assets, `/api` and its upgrade, `/plugins`, `/auth` and `/delorun/reach/status`), and refuses every other route, upgrade and the fallback with `403 LOOPBACK_REQUIRED`.

<a id="sessions"></a>
### Sessions

**Reach sessions** are server-side.

- **Token.** A session token is 32 bytes from the operating system's cryptographic random source, encoded as base64url without padding (43 characters).
- **Cookie.** `__Host-delorun-session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<seconds to the absolute expiry>`, with no `Domain` attribute. Each studio address is its own origin, so a session cookie of one address is never sent to another.
- **Store.** The provider holds each session in memory as a record keyed by the SHA-256 hash of its token: the device id, the listener, the studio address, the identity factor used at creation, whether a rotation trigger fired since it was minted, the creation time, the last-use time, the last-roll time and the absolute expiry. No record holds a token. A stored record that names no listener, no identity factor of [C14](c14-oidc-passkeys.md) or no rotation mark is refused as unreadable, because the home reads the factor wherever it grants an action reserved for its own computer ([C14](c14-oidc-passkeys.md#tailnet-membership)). The store is persisted to `~/.delorun/secrets/home-auth/sessions.json` ([C1](c01-home-layout.md#secrets)) within 5 seconds of a change and when the home process stops. A revocation is persisted before the response that caused it returns.
- **Creation.** `POST /auth/session` creates a session only from a fresh device-key signature of a trusted device approved for this listener's address and an identity-factor proof for that address ([C5](c05-device-approval.md#sign-in), [C14](c14-oidc-passkeys.md)).
- **Enrolment sessions.** On an address with no enrolled identity factor, the same signature without a proof creates an enrolment session: a reach session with a 10-minute absolute limit, admitted only to the enrolment routes of [C14](c14-oidc-passkeys.md#enrolment) and refused elsewhere with `401 NOT_SIGNED_IN`. A listener whose provider declares `tailnet-membership` has no enrolment session: the signature of an approved device creates a full session with that factor, and no factor is enrolled from it.

**Loopback sessions** keep upstream's credentials: the launch-token exchange, `/connect` and the stateless HMAC cookies `dsh-auth-<hash>` signed with the browser session secret in upstream's `.credentials.yaml`. In the CLI profile the launch token is one-time ([launch tokens](#launch-tokens)); upstream's own profiles keep a launch token of 32 random bytes made once per Host process and accepted for that process's whole life. A cookie is checked by its signature and expiry only: no server-side record exists, nothing revokes one, and every cookie admits as the one owner Peer. It expires `cookieMaxAgeDays` after it was minted, upstream's default of 30, which Delorun's profiles do not change. The browser session secret is never replaced, so a cookie stays valid across restarts until it expires. Upstream's connection announces each mint with the event `authenticator/minted`, synchronously and before it writes the response that carries the credential, with the credential's kind (`browser` from the launch-token exchange, `api` from `/connect`), the SHA-256 hash of its value as base64url without padding, its audience, its issue and expiry times and, for `api`, the id of the Peer it admits; the event never carries the credential's value. No listener of the event exists; recording each loopback credential and refusing one without a record is in the [reach design](../design/reach.md#loopback-credentials).

| Listener | Idle limit | Absolute limit | Rolling |
| --- | --- | --- | --- |
| `loopback` | None | 30 days since minting | None: a loopback credential keeps its value until it expires. |
| Every reach listener | 12 hours since last use | 14 days since creation | Every 24 hours of use, the next admitted request receives a new token in `setCookie`. The old token stays valid for 30 seconds for requests already in flight, then its record is deleted. |

A session past its idle or absolute limit is refused with `401 SESSION_EXPIRED` and its record is deleted. Rolling never extends the absolute limit. A reach session's use is an admitted HTTP request or upgrade carrying its token; traffic on a connection admitted earlier, frames a client sends on an open WebSocket included, is not use. When a reach session passes its idle or absolute limit, or a rolled token's 30-second grace ends, the provider closes every open reach connection that carried a request admitted for that token, at that time and whether or not a request arrives.

<a id="page-unlock"></a>
### Page unlock

No route mints a page unlock: [PIN mode](c14-oidc-passkeys.md#pin-mode) refuses the unlock to every device, which confirms each action with a one-action grant, or a device with a passkey within a Face ID pass, instead. Admission still strips and checks the token carriers below, so a token a page still sends is refused with `401 UNLOCK_INVALID` and admits nothing. Each part below is a fact of admission, not of the routes.

- **Carriers.** The token travels as the `Delorun-Unlock` header on `/api` requests and as the WebSocket subprotocol `delorun-unlock.<token>` on the `/api/remote.mux` upgrade. A query parameter is never read as a token. A page that offers the subprotocol also offers one fixed protocol before it, so the upgrade answer names a protocol the browser accepts.
- **Stripped.** `admit` removes both carriers from the request, in every header view, before any route, upgrade handler or plugin sees it. With PIN mode off, the token is stripped and ignored.
- **Checked.** After the session is admitted, the token must name an unlock bound to that session's device, listener and session (a session rolled within the last 30 seconds counts as the same session). A request without a token is admitted as today, to the device's locked Peer. A token that is unknown, ended, repeated or bound to anything else is refused with `401 UNLOCK_INVALID`, and an unlock bound to another device, listener or session ends: a token that moved has leaked.
- **Per-page Peers.** A device holds one locked Peer per listener and one Peer for each running page unlock, whose principal carries the unlock's `unlockId`. The Peer decides what its page may do; no Peer answers a reserved prompt or takes a `face` action without a grant of its own, and an unlock never admits another page.
- **Ending.** When an unlock ends, its Peer is disposed and the reach connections of its session close. The device's other pages reconnect with their own tokens.
- **Caching.** The reach index answers `Cache-Control: no-store`, so a restored page is not served from the cache.

**Grants (Face ID).** A confirmed action does not travel as a token: the home keeps a grant per device, listener, action and call hash (C14, "Face ID unlock"). A plugin Fetch route of class `face` names its grant in the `Delorun-Grant` header, which the home reads and removes before the route runs, as it does `Delorun-Unlock`; the header holds only the grant id and the home checks the hash of the request it received. A Remote call and a prompt answer carry nothing: the policy and the answer guard look the grant up. A terminal's or folder picker's hold is bound to that id and to the connection.


<a id="launch-tokens"></a>
### Launch tokens

A launch token is what a browser presents once to obtain a loopback cookie. Upstream's connection holds one random launch token for the life of the Host and accepts it any number of times. The CLI profile turns on upstream's `oneTimeLaunchTokens` (C16 switch `one_time_launch_tokens`, on in Delorun's default composition and off in the parity composition), and with it:

- **No reusable token.** The Host has no process launch token. Each call of upstream's `authenticatedUrl` mints a token for one opening: 32 bytes from the cryptographic random source, base64url-encoded, bound to the protocol and host of the URL it is added to.
- **Who mints.** `delorun` asks the home process for a link with the C19 operation `studio.open-token`, which it accepts only with the start token from the token file ([C19](c19-home-process.md#requests-and-responses)); `delorun open`, `delorun start`, a bare `delorun` and setup's ending all ask that way. No HTTP route mints a token, and a channel request carrying the Host's own channel token is refused for that operation. Code running in the Host is not confined: a Host plugin can call `authenticatedUrl` itself.
- **Forwarded ports.** A link names the studio's loopback host and port. `delorun open --print --port <n>` names the same loopback host with another port, such as the local end of an `ssh -L` forward; the host is never anything but the studio's loopback address.
- **Lifetime.** A token expires 60 seconds after it is minted. At most 5 unconsumed tokens exist at once; minting a sixth drops the oldest.
- **One use.** The first presentation of a token consumes it, whatever its outcome: at the root or `/connect`, whether the exchange succeeds or is refused by the `Host`/`Origin` fence, by a provider policy that refuses launch tokens, or for its method, site or a second `token` value; on any other path of the loopback listener, such as an asset or `/api`, through the web server's `webserver/request` event before routing; and on a reach listener, which also refuses it with `LAUNCH_TOKEN_REFUSED`. The one exception is a request with more than 4 `token` values: it is refused, and none of its values is read or consumed.
- **The exchange.** A presentation signs in only when it is a `GET` of the root or `/connect` with exactly one `token` value that is unconsumed and unexpired, its `Host` names the minted URL's host, its `Sec-Fetch-Site`, when present, is `none` or `same-origin`, and its `Origin`, when present, is the request's own origin. It then receives the loopback cookie above, unchanged.
- **Comparison.** The connection keeps only the SHA-256 digests of unconsumed tokens and compares a presented value with each in constant time.
- **Refusal.** A refused presentation receives upstream's `401` text with Delorun's instruction: run `delorun open`, or `delorun open --print --port <port>` for a link through a forwarded port. A token presented at another host or port than the one it was minted for is refused with a text that names the address it was made for.
- **Not written down.** The token appears only in the link handed to the browser launcher and, under `delorun open --print`, in that command's output. No log, status answer, error message or printed start line carries it; the home log's redaction of `token` URL parameters ([C20](c20-operational-logs.md)) remains as a second line.

<a id="rotation-and-revocation"></a>
### Rotation and revocation

These events rotate every session of the home, on every listener:

- a device approval;
- a device removal;
- a sign-in factor change: enrolling, replacing or removing a passkey, changing the OpenID Connect provider or client, and the completion of a recovery-kit restore;
- a reach-provider change: turning a reach option on or off, or adding, removing or changing a studio address.

A rotation closes every open reach connection that carried a request admitted for a rotated session before the trigger's operation returns. A rotated reach session's next request is refused with `401 ROTATION_REQUIRED`. The studio then signs a fresh device-key challenge and calls `POST /auth/session` with the old token, which returns a new token with the same absolute expiry and deletes the old record; the identity factor is not asked again. Rotation does not reach loopback credentials, which have no record.

Revocation ends a session at once. Removing a device deletes its sessions and records and disposes its Peers before the removal returns. `delorun devices reset` ([C5](c05-device-approval.md#reset)), which is not built, deletes every session record and replaces the browser session secret ([reach design](../design/reach.md#loopback-credentials)).

<a id="response-headers"></a>
### Response headers

Every response from a reach listener carries these headers. The loopback listener keeps upstream's headers.

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<nonce>'; style-src-elem 'self' 'nonce-<nonce>'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'; trusted-types default delorun-plugin-loader delorun-blob-worker` |
| `Strict-Transport-Security` | `max-age=31536000` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `no-store` on every `/auth/` and `/api` response |

`<nonce>` is 16 bytes from the cryptographic random source, base64url-encoded, and new for every index and sign-in page response. Upstream's index renderer adds it as the `nonce` attribute of every inline `<script>` and `<style>` element it renders.

**No string evaluation and nonced styles.** The policy never allows `'unsafe-eval'`, so no studio code evaluates a string when it loads. The Loader compiles its `!!js` evaluator only when a configuration expression needs it, and the browser composition carries no such expression. The Web entry stamps the page's nonce on every `<style>` element created through `document.createElement`, so plugin and library styles apply, and puts zod in jitless mode, so zod does not probe for string evaluation.

**Remote images.** On a reach listener, the studio renders an image or media element in chat content whose source is not same-origin and not a `data:` URL as a placeholder that names the source's host. The placeholder never requests the source, and the Content Security Policy refuses the request if any code makes it.

<a id="trusted-types"></a>
### Trusted Types

Trusted Types are enforced on reach listeners by the `require-trusted-types-for 'script'` directive above, with three policies. The `trusted-types` directive names each of them, because a policy whose name that directive omits cannot be created at all.

- **`default`.** Its `createHTML` passes the input through the studio's HTML sanitiser, which removes `<script>` elements, event-handler attributes, `javascript:` URLs and `<iframe srcdoc>`, and returns the result, so upstream components and community client plugins that assign `innerHTML` keep working. Its `createScriptURL` returns a URL only when it is same-origin, its path begins with `/plugins/` and that path without its query is a bundle listed in the client module registry's current boot manifest; otherwise it returns `null`, and the assignment fails. Its `createScript` always returns `null`.
- **`delorun-plugin-loader`.** Upstream's client module loader assigns `script.src` through this named policy, which applies the same URL rule as the default policy's `createScriptURL`.
- **`delorun-blob-worker`.** Its `createScriptURL` returns a URL only when it is a `blob:` URL whose origin is the page's own; otherwise it returns `null`. A blob URL inherits the origin of the page that created it, so this admits a Worker source the page itself built and refuses one another origin built. A page with an opaque origin is refused every URL, because every opaque origin has the same string form. The four features that run their work in a Worker built from a Blob — file and image upload, and the spreadsheet, PDF and Office previews — mint their Worker URL through this policy. The `worker-src` directive admits `blob:` for the same reason: the constructor accepting the URL is not enough, because the Worker is refused afterwards if the directive does not admit its source.

<a id="refusals"></a>
### Refusals

| Code | Status | Raised when |
| --- | --- | --- |
| `HOST_MISMATCH` | 421 | `Host` does not satisfy the listener's rule. |
| `SNI_MISMATCH` | 421 | `Host` differs from the SNI on `reach-self-hosted-relay`. |
| `ORIGIN_MISMATCH` | 403 | A foreign `Origin`, `Sec-Fetch-Site: cross-site`, or an upgrade without `Origin`. |
| `LAUNCH_TOKEN_REFUSED` | 401 | A `token` query parameter on a reach listener. |
| `CONNECT_REFUSED` | 401 | `/connect` on a reach listener. |
| `UPSTREAM_COOKIE_REFUSED` | 401 | A `dsh-auth-*` cookie on a reach listener. |
| `NOT_SIGNED_IN` | 401 | No admitted session and no allowlisted route. |
| `SESSION_EXPIRED` | 401 | A reach session's idle or absolute limit passed. |
| `ROTATION_REQUIRED` | 401 | A rotated reach session's next request. |
| `OWNER_CLAIM_LOOPBACK_ONLY` | 403 | `POST /auth/owner/claim` on a reach listener where no claim is allowed. |
| `REACH_LISTENER_HOST_OVERRIDE` | Load failure | A profile row sets a reach listener's `host` or `port`. |

<a id="consumers"></a>
## Consumers

- Upstream's `packages/client/connection`: the `Authenticator` Service Definition, its default provider, the per-listener `admit` calls, and each reach listener's dispatcher, which applies the dispatch order.
- Upstream's `packages/host/webserver`: the reach listeners' sockets and streams, the gate that calls the dispatcher before any route, upgrade handler or the fallback, the response headers and the nonce on inline elements.
- Upstream's `packages/client/modules/src/client/system.ts` and the upstream components that assign `innerHTML`: the Trusted Types policies.
- `delorun/packages/home-auth/`: the `authenticator` provider with the pre-login routes, the session store and rotation, the loopback-only owner claim, device list, approval window and removal; every CLI profile loads it. It records no loopback credential.
- The reach providers of [C7](c07-reach-providers.md): the Tailscale private provider is built and supplies that listener's target; the Funnel provider and the relay client's handoff to `reach-self-hosted-relay` are not built.
- `delorun/packages/plugin-changes/`: the Changes routes ([C21](c21-changes.md#routes-and-the-recovery-screen)) call `admit` first, let a reach session read, and act only for a request under a loopback `Host`, on the loopback listener by the listener stamp `home-auth`'s authenticator sets on every request a reach listener admits, whose session Connection's `isReachPeer` does not name; `@delorun/home`'s arrival helpers decide the first two.
- `delorun/packages/contract-admission/`: listener ids, refusal codes, the cookie name and the limits.
- [C10](c10-host-qualified-keys.md): the cookie names it leaves outside its inventory. [C15](c15-verification-checks.md): the `reach-binding` check reads the listener table.

<a id="compatibility"></a>
## Compatibility

Without an `authenticator` provider upstream's admission runs unchanged; with `@delorun/home-auth`, which keeps upstream's admission on the loopback listener, the CLI profile still admits loopback requests as stock DSH does, except that `@delorun/bundle-local` turns on upstream's one-time launch tokens there; upstream's profiles, the desktop app and the parity composition keep the reusable launch token. Reach is off in the parity composition ([C16](c16-parity-composition.md)), so no reach listener runs there. Admission adds no model-visible input and no session event.

The cookie name `__Host-delorun-session`, the listener ids, the refusal codes and the session store's format, version 1, are fixed. Changing a lifetime, a header value or the pre-login allowlist is a change to this contract. A newer session store format is a new file with a new version; a provider that reads a store of an unknown version starts with no reach sessions and keeps the file.

<a id="security"></a>
## Security

Requirements:

- A reach listener binds only `127.0.0.1` or a Unix socket, or no address at all, and no configuration overrides it.
- A reach listener authenticates in its dispatcher before any route, upgrade or fallback. Before sign-in it serves only the pre-login allowlist, and a plugin route joins that allowlist only when the profile lists it.
- A reach listener refuses launch tokens, `/connect`, upstream `dsh-auth-*` cookies and loopback `Host` values.
- On each listener, a `Host` that the listener's rule does not allow is refused; on the relay listener, `Host` also equals SNI.
- Reach sessions are stored hashed, server-side and revocable, in `__Host-` cookies with the declared scheme's `Secure` attribute.
- Sessions follow the lifetimes and rotate on the events above; a removed device's sessions end before the removal returns.
- `delorun devices reset` replaces the loopback browser session secret, so loopback cookies minted before it stop working. Not built ([reach design](../design/reach.md#loopback-credentials)).
- The reach listener's Content Security Policy limits `connect-src`, `img-src` and `media-src` to `'self'`, with `data:` for images and media and `blob:` for images, never allows `'unsafe-eval'`, and chat-rendered remote images are placeholders that are never fetched.
- Trusted Types are enforced with the two policies above.
- Removing or replacing `@delorun/home-auth` stops every reach listener, and reach never falls back to upstream's cookies.
- `admit` is synchronous over in-memory state; a provider that needs I/O to decide refuses until its state is loaded.
- In the CLI profile a launch token works once, expires after 60 seconds, is bound to the host it was minted for, is refused from another site, and is consumed by any loopback or reach request that presents it; at most 5 wait at once, and a request with more than 4 `token` values is refused unread. `delorun` obtains one only through `studio.open-token` with the person's start token.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `every route and upgrade answers 401 before sign-in on each reach listener` | Each exact route, prefix route, upgrade route and the fallback registered with the web server, plus a fixture plugin's route and upgrade, answers 401 without its handler running on every reach listener. |
| `a plugin route is pre-login only when the profile lists it` | A fixture plugin route that declares itself pre-login answers 401 before sign-in until the profile's `preLoginRoutes` lists it. |
| `a cookie minted with upstream's secret is refused on a reach listener` | A valid `dsh-auth-*` cookie for the same authority is refused with `UPSTREAM_COOKIE_REFUSED`. |
| `launch tokens and /connect are refused on a reach listener` | The process launch token in a `token` query and a request for `/connect` are each refused, and no cookie is set. |
| `a loopback Host is refused on a reach listener` | `localhost`, `127.0.0.1` and `[::1]` in `Host` are refused with `HOST_MISMATCH`. |
| `each listener refuses a Host its rule does not allow` | On each listener, a `Host` other than its bound name or address is refused, and on the relay listener a `Host` that differs from SNI is refused. |
| `an upgrade with a foreign or absent Origin is refused` | A WebSocket upgrade to `/api` with another origin, or without `Origin`, is refused on a reach listener. |
| `no reach listener runs without home-auth` | With `@delorun/home-auth` removed, or replaced by another provider, no reach listener accepts a connection, and open reach connections close. |
| `a reach listener refuses a host override` | A profile that sets `host` for a reach listener fails at load with `REACH_LISTENER_HOST_OVERRIDE`. |
| `a request without a listener stamp is not loopback` | A claim and a device-list request with a loopback `Host` and no stamp, accepted on a socket other than the loopback listener's, are refused, and nothing is claimed. |
| `a forged Tailscale-User-Login changes nothing` | On the Tailscale private listener a request carrying forged `Tailscale-*` headers reaches admission without them, and an unapproved device that sends them receives `DEVICE_NOT_TRUSTED` and no session. |
| `the session store holds no token` | After sessions are created, `sessions.json` contains none of their tokens, and a token planted as a record key does not admit. |
| `idle and absolute limits refuse a session` | A reach session unused for 12 hours and a reach session 14 days old are each refused with `SESSION_EXPIRED`. |
| `a rolled token stops after its grace` | After a roll, the old token admits for 30 seconds and is refused after them. |
| `a removed device's sessions end before the removal returns` | After removal returns, the device's next request is refused and its open stream has ended. |
| `a rotation needs a fresh device-key proof` | After a device approval, an old reach session is refused with `ROTATION_REQUIRED` until a new device-key signature rotates it, and a replayed signature does not. |
| `a script URL outside the allowlist does not load` | A script element whose `src` is a same-origin path not in the boot manifest, or another origin, is refused by the policy and never requested. |
| `a community plugin's HTML loses its scripts` | A fixture client plugin that assigns HTML containing `<script>` and an `onerror` attribute renders the rest of the HTML with neither. |
| `the studio boots and styles a terminal with no policy violation` | On a reach listener, the studio boots, connects a workspace and renders a sidebar terminal whose `<style>` elements all apply, and the page reports no Content Security Policy violation, including none for string evaluation. |
| `a remote image in chat is never requested` | A recorded fixture chat whose message holds a Markdown image with a remote URL renders a placeholder on a reach listener, and a network guard records no request to the remote host. |
| `signs in once with each token and refuses its second use with the configured instruction` | A one-time launch token mints a cookie once; its second presentation is refused with the `delorun open` instruction. |
| `refuses a token after 60 seconds` | A token presented 60 seconds after it was minted is refused. |
| `keeps at most five waiting tokens and drops the oldest when a sixth is minted` | After a sixth mint the first token is refused and the other five sign in. |
| `refuses and consumes a token presented with another Host, from another site, by another method or beside another token` | Each such presentation is refused, and the same token is refused afterwards where it would have signed in. |
| `consumes a one-time launch token it refuses, so the loopback listener refuses it too` | A token presented on a reach listener is refused there and no longer signs in on the loopback listener. |
| `refuses a token at another loopback port or name, naming the address it was made for` | A token presented with another loopback port or `localhost` for `127.0.0.1` is refused with a text naming its address and consumed; a token minted for a forwarded port signs in through it. |
| `refuses Origin: null and accepts Sec-Fetch-Site: same-origin` | An opaque origin is refused and consumes the token; a same-origin navigation signs in. |
| `drops expired tokens before it counts the five, and refuses more than four token values unread` | Expired tokens leave the waiting set at the next mint, and five values with a valid token among them neither sign in nor consume it. |
| `consumes a one-time launch token wherever a loopback request presents it and is refused` | A token presented to `/connect` behind the trust fence, under a provider policy that refuses launch tokens, to an index route, an asset path, `/api` or another route no longer signs in. |
| `refuses a reach request with more than four token values without reading them` | A reach request with five values is refused with `LAUNCH_TOKEN_REFUSED`. |
| `keeps the reusable process token when the mode is off` | With the switch at its parity value, the process token signs in repeatedly, as upstream's does. |
| `studio-open-token-person-only` | Only the start token from the token file obtains a link; the Host's channel token and a caller without the start token are refused, and the home log holds no link. |
| `setup-ending-signs-in` | Setup's ending opens a link from the home process that signs in once against a real connection, and a second use is refused with the `delorun open` instruction. |
| `reads the target as the router does, so no dot-segment spelling of /api skips the origin rule` | A state-changing request whose target reaches `/api` only after dot-segment removal, plain or percent-encoded, is held to the origin rule and refused with a `same-site` marker. |
| `lets a caller with no browser markers reach only a destination a browser would have marked` | A markerless state-changing `/api` request passes toward loopback and HTTPS and is refused toward a `trustedHosts` name or a bind address over plain HTTP. |
| `are answered 400 on the configured and an additional listener before any gate, route, resource, upgrade or fallback runs` | A request or upgrade with two `Host` lines is answered 400 on both kinds of listener, and no gate, handler, resource, upgrade handler or fallback runs. |
| `keeps public only the exact dist-root install files, so a look-alike chunk or a nested copy stays fenced` | A dist file named like an install file, or a copy of one in a subdirectory, needs sign-in; only the fixed root files and the root-level icons the manifest lists are public. |

<a id="what-this-does-not-prove"></a>
### What this does not prove

- **Code on a trusted origin.** Admission decides who reaches the Host, not what admitted code does. A community client plugin, or script that defeats the sanitiser, runs on the studio's origin with the session's full authority; the Content Security Policy and Trusted Types limit how script and requests get in, not code the person installed.
- **Every device is the owner.** Each trusted device's Peer acts as upstream's `owner` principal, so this contract gives no device less authority than another.
- **The person's own processes.** A process of the person's user outside the sandbox can read the home's secrets, including the browser session secret, and can mint loopback credentials and edit the session store; the session limits protect against other parties, not against it ([C1](c01-home-layout.md#security)).
- **A copied loopback cookie.** A loopback cookie admits for 30 days from minting, survives restarts, and has no record that could revoke it; the loopback studio sends no Content Security Policy, so the Trusted Types policies the studio creates are not enforced there.
- **A link on a command line.** The browser launcher (`xdg-open`, `open`, or `cmd.exe` under Windows and WSL) receives the link as an argument, so the token is on that process's command line and, when the launcher starts a new browser process, on the browser's. Another process that reads command lines (another user's on Linux without `hidepid`, or a confined command under Landlock or Seatbelt, whose dialects do not hide the person's processes) can race the browser to the token in the time between the launch and the browser's first request, at most the token's 60 seconds. After that request the token is worthless. bwrap gives a confined command its own process namespace, so it sees no other Linux process; under WSL that namespace does not cover Windows processes reached through interop, and that case is not covered until it is verified.
- **Remote content outside chat rendering.** The placeholder rule covers images and media that the studio renders in chat content; other requests a client plugin makes are refused only by the Content Security Policy.

<a id="decided-values"></a>
## Decided values

- Loopback credentials: absolute 30 days from minting, upstream's default; the 7-day idle limit is in the [reach design](../design/reach.md#loopback-credentials) and is not built.
- Reach sessions: idle 12 hours, absolute 14 days, rolled every 24 hours of use with a 30-second grace for the old token.
- Rotation triggers: a device approval or removal, a sign-in factor change and a reach-provider change.
- Session tokens and the session store: 32 random bytes per token, records keyed by SHA-256, persisted within 5 seconds and before a revocation returns.
- The Content Security Policy nonce: 16 random bytes per page response.
- The loopback listener's address in Delorun's profiles: `127.0.0.1:3080`.
- Launch tokens in the CLI profile: one use, 60 seconds, at most 5 unconsumed, 32 random bytes each, at most 4 `token` values read per request.
