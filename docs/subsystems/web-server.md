# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: one `node:http` server — `node:https` when `tls` is configured — providing `ctx.webServer`, a named-route registry, optional gzip response compression, index.html transform callbacks, and one fallback, a handler or a resource, that a plugin may claim. It is not part of the agent loop and not a capability seam; its only harness concept is the Peer an index render speaks for, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering reference](../../packages/boot/app-boot/README.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

```ts type-equiv
/**
 * Answers one GET or HEAD request with a Fetch response. An HTTP request
 * arrives without a Peer and carries the client's headers; an in-process
 * {@link WebServer.readResource} read passes the Peer its caller admitted.
 */
type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>
```

```ts type-equiv
/** One named route answered by a resource instead of a handler. */
interface WebResourceRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Answers HTTP GET and HEAD requests and in-process reads. */
  resource: WebResource
}
```

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. The shipped Web composition claims the seat with [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts), the SPA dist server with locked semantics: Connection authenticates the dist root and configured index before their HTML is read; non-index assets remain public; non-GET/HEAD is 405, traversal outside the dist root is 403, existing files are served directly, absent or non-file targets are empty 404 responses, and unknown extensions ship as octet-stream.

A route or the fallback may give a resource, a function from a Fetch `Request` to a `Response`, instead of a handler. HTTP `GET` and `HEAD` requests reach it without a Peer, and `readResource(request, peer)` reads it in process for the Peer its caller admitted; a read follows the same match order but reaches only resources, so a route that returns owner-private data or performs an action stays a handler even when it answers `GET`.

<a id="config"></a>

## Config

```ts type-equiv
/** Web server listen, TLS, and response-compression config. */
interface Config {
  /**
   * Listen address: a concrete IPv4 or IPv6 literal of one local interface,
   * for example the container's own Pod address from `hostname -i`. A loopback
   * literal (any address in 127/8, `::1`, or a mapped form of either) keeps the
   * server on this machine; any other literal serves the network that address
   * belongs to, over plain HTTP unless `tls` is set. The unspecified address —
   * IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at
   * load: it would expose the port on every interface at once.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Serve HTTPS with this certificate and key instead of plain HTTP. Both files
   * are read once, before the listener binds: an unreadable or empty file,
   * invalid PEM, or a key that does not match the certificate rejects
   * initialization rather than falling back to HTTP. The material is never
   * re-read, so replacing a certificate takes a reload. Omitted or null listens
   * over plain HTTP.
   */
  tls?: TlsConfig
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}
```

```ts type-equiv
/**
 * TLS material for the HTTPS listener: one certificate chain file and the
 * private key file it pairs with. Both hold PEM text and both resolve against
 * the process working directory.
 */
interface TlsConfig {
  /** Certificate chain file, leaf certificate first, PEM, no passphrase. */
  certFile: string
  /** Private key file for the chain's leaf certificate; unencrypted PEM. */
  keyFile: string
}
```

No composition can bind every interface at once: the unspecified address is rejected at load. The exported `isWildcardHost` and `isLoopbackHost` classify a bind address from its parsed value, and an IPv6 `%zone` is kept for `listen` while classification reads the address alone. The carrier owns no authentication or Origin policy, and it serves plain HTTP unless `tls` supplies a certificate and key. `compression` defaults to `none`; the shipped Web bundle selects gzip level 1 with a 1024-byte threshold. The shipped `dsh web` command selects loopback by default and accepts one concrete `--host` address, warning at startup when a non-loopback bind serves plain HTTP; its Connection plugin supplies Host/Origin checks plus browser-session authentication for every Host API route and stream, and the bind address plus `--trusted-host` govern which browser Host is accepted; `--public-url` changes only the advertised URL. Other compositions own their bind and route-authentication policy. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. The `tls` pair is read once before the listener binds, and an unreadable, empty, or mismatched pair rejects initialization the same way instead of falling back to HTTP. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. Gzip wraps eligible socket-backed responses inside the server, so handlers keep direct `ServerResponse` ownership, and a resource hands the service a `Response` to write back. Existing content encodings, `Cache-Control: no-transform`, ranges, SSE, ZIP, and the packaged `.gz` Worker image remain identity responses. `collectIndexInjections(peer)` gathers structured `IndexInjection` rows over one `webserver/index-inject` emit that passes the Peer the page speaks for, and `renderIndex(html, peer)` renders them into successful root and configured index responses before applying the raw `tapIndex(transform)` escape-hatch transforms in registration order; [dsh-client-modules](../../packages/client/modules) answers the event with the boot manifest rows. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0, and `protocol` reports the scheme the listener serves (`http:` or `https:`). `openListener({ id, bind, gate })` opens an additional listener on the same routes, bound to an OS-assigned port on `127.0.0.1` or to byte streams its owner hands in, whose gate decides every request and upgrade request before any route, upgrade handler or the fallback; [dsh-client-connection](../../packages/client/connection/README.md#admission-providers-and-reach-listeners) opens reach listeners through it.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. A TLS socket counts as a connection only after its handshake, so the server tracks raw TLS sockets beside upgraded ones and destroys both at disposal. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthenticator--authenticator-abstract-seam"></a>

### `ctx.authenticator` — `Authenticator` (abstract seam)

Admission provider. Subclass it and load the subclass as a plugin; it registers as `ctx.authenticator`, one provider per context. Connection's loopback admission calls admit after its `Host` and `Origin` fence, and each reach listener's dispatcher calls it after the reach checks.

Providers must keep these rules:

- admit is synchronous and reads only in-memory state; a provider whose state is not loaded yet refuses.
- policy returns a policy only for listeners the provider serves. A reach listener opens only while its provider returns a policy for it, and closes when that provider is removed or replaced.
- Each change to a returned policy is announced with `authenticator/policy`.
- A `setCookie` on an upgrade request is never sent, because the upgrade handler writes the response; a provider rolls a session only on a request without an `Upgrade` header.

```ts cordis-catalog
/**
 * Admit one request on one listener.
 * @param request - the request's headers, method and target.
 * @param listener - the listener that received it.
 * @returns the admission.
 */
abstract admit(request: ConnectionIndexRequest, listener: string): Admission

/**
 * The policy of one listener.
 * @param listener - a listener id.
 * @returns the policy, or `undefined` when this provider does not serve the listener.
 */
abstract policy(listener: string): ListenerPolicy | undefined
```

Source: [`packages/client/connection/src/authenticator.ts`](../../packages/client/connection/src/authenticator.ts)

<a id="ctxconnection--hostconnectionadmission"></a>

### `ctx.connection` — `HostConnectionAdmission`

Host `ctx.connection`: the transport handle with the members for admission providers and reach listeners.

```ts cordis-catalog
/**
 * Connection's built-in loopback admission, which applies while no
 * `authenticator` provider is loaded and which a provider may delegate its
 * loopback decisions to: a valid signed browser cookie admits the shared
 * owner Peer, a valid API cookie admits its live API Peer, and anything else
 * is refused 401. It applies no Host or Origin fence; Connection applies the
 * fence before it calls the provider.
 * @param request - the loopback request's headers.
 * @returns the admission.
 */
builtinAdmission(request: ConnectionTrustRequest): Admission

/**
 * Destroy every open reach connection that carried a request the provider
 * admitted for this session or device, streams and upgraded sockets
 * included, as a session's revocation or a device's removal requires.
 * @param match - a session id, a device id, or both.
 * @returns how many connections were destroyed.
 */
closeReachConnections(match: { readonly sessionId?: string; readonly deviceId?: string }): number

/**
 * Open one reach listener, owned by the Context that read `ctx.connection`.
 * It needs a loaded `authenticator` provider that serves the listener, and
 * stops when that provider is removed or replaced.
 * @param options - the reach listener id and its binding.
 * @returns the open listener.
 */
openReachListener(options: ReachListenerOptions): Promise<ReachListener>
```

Source: [`packages/client/connection/src/reach.ts`](../../packages/client/connection/src/reach.ts)

<a id="ctxwebapp--webapp"></a>

### `ctx.webApp` — `WebApp`

The Web GUI this process serves, provided by the `web-runtime` row.

```ts cordis-catalog
/**
 * The URL this GUI advertises, also used for `DSH_WEB_URL` and the startup URL line.
 * @returns the configured `publicUrl`, otherwise the listener origin.
 */
getAdvertisedUrl(): string
```

Source: [`packages/bundle/web-app/src/index.ts`](../../packages/bundle/web-app/src/index.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation loads any configured TLS material, then listens immediately; a material or listen failure rejects initialization, and the boot process reports the failed fiber. Route registration order does not affect requests because configured named routes must be distinct, and a request no named route matches is answered 404 until the fallback owner registers.

```ts cordis-catalog
/**
 * The root URL local clients use to reach the bound listener: the protocol,
 * the {@link bindUrlHost} form of the bind address, and the listening port.
 * @returns the origin, for example `http://127.0.0.1:3080`.
 * @throws before `listen` binds a port, or when the bind address has no URL form.
 */
getOrigin(): string

/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler or resource.
 * @returns the disposer removing the route.
 */
register(route: WebRoute | WebResourceRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler or resource answering every request
 * no named route matches (the SPA dist server in the shipped Web
 * composition). One owner only — a second registration throws, because two
 * fallbacks cannot compose.
 * @param fallback - a handler owning the full response lifecycle of
 * unmatched requests, or `{ resource }` answering them.
 * @returns the disposer releasing the seat.
 */
registerFallback(fallback: WebRoute['handler'] | Pick<WebResourceRoute, 'resource'>): () => void

/**
 * Read the response an HTTP request for the same URL would receive, as the
 * resource computes it for `peer`, without an HTTP exchange. The request
 * path picks the responder by the HTTP match order — exact, longest prefix,
 * then the fallback — and only a resource answers. This method checks no
 * cookie, Host, or Origin: the caller admits the reader before reading.
 * @param request - the read; its URL path selects the responder.
 * @param peer - the Peer the read speaks for, passed to the resource.
 * @returns the resource's response, without a body for HEAD as over HTTP;
 * 405 with `Allow: GET, HEAD` for any other method, checked before matching,
 * where over HTTP a handler route or an unmatched path answers such a
 * method itself; 404 when the path matches a handler route, or reaches the
 * fallback seat while it is unclaimed or holds a handler. A resource that
 * throws rejects the read, where an HTTP request would receive 400.
 */
async readResource(request: Request, peer: PeerScope): Promise<Response>

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Open an additional listener beside the configured one. It serves the same
 * routes, upgrade routes and fallback, and its gate decides every request and
 * upgrade request before any of them runs. A `loopback` listener has bound its
 * port when the promise settles. The listener closes with this service; the
 * caller owns closing it earlier, as an effect of its own Context.
 * @param options - the listener's id, binding and gate.
 * @returns the open listener.
 * @throws when another open additional listener has the same id, or the
 * `streams` TLS material is unusable.
 */
async openListener(options: WebListenerOptions): Promise<WebListener>

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string

/**
 * Gather the structured injection table for one Peer: one
 * `webserver/index-inject` emit, every subscriber pushes its current rows.
 * Fresh per call, so subscribers read live state (module graph, theme
 * preference, the Peer's access) at emit time.
 * @param peer - the Peer the page speaks for.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(peer: PeerScope): IndexInjection[]

/**
 * Render one index.html body for one Peer: the structured injection table
 * first, then the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @param peer - the Peer the page speaks for.
 * @returns the transformed body.
 */
renderIndex(html: string, peer: PeerScope): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="authenticator-events"></a>

### `authenticator/*` events

<a id="authenticatorminted--emit"></a>

#### `authenticator/minted` — emit

Connection minted a loopback credential. Emitted synchronously, before the response that carries the credential is written, so a provider can record it before the browser can present it.

```ts cordis-catalog
/**
 * Connection minted a loopback credential. Emitted synchronously, before
 * the response that carries the credential is written, so a provider can
 * record it before the browser can present it.
 * @param credential - what identifies the credential; never its value.
 * @mode emit
 */
'authenticator/minted'(credential: MintedCredential): void
```

Source: [`packages/client/connection/src/authenticator.ts`](../../packages/client/connection/src/authenticator.ts)

<a id="authenticatorpolicy--emit"></a>

#### `authenticator/policy` — emit

The provider changed the policy of one listener. An open reach listener reads the policy again, and stops when the provider no longer serves it.

```ts cordis-catalog
/**
 * The provider changed the policy of one listener. An open reach listener
 * reads the policy again, and stops when the provider no longer serves it.
 * @param listener - id of the listener whose policy changed.
 * @mode emit
 */
'authenticator/policy'(listener: string): void
```

Source: [`packages/client/connection/src/authenticator.ts`](../../packages/client/connection/src/authenticator.ts)

<a id="connection-events"></a>

### `connection/*` events

<a id="connectionrequest--waterfall"></a>

#### `connection/request` — waterfall

Admit or wrap an authenticated shared API request, including body transfer. Existing requests continue when a listener refuses subsequent requests.

```ts cordis-catalog
/**
 * Admit or wrap an authenticated shared API request, including body transfer.
 * Existing requests continue when a listener refuses subsequent requests.
 * @param request - Authenticated incoming HTTP request.
 * @param response - Response owned until the delegated bridge settles.
 * @param next - Delegate to the next listener or the shared API bridge.
 * @mode waterfall
 */
'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table for the page `peer` speaks for. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table for the page `peer` speaks
 * for. Emitted on every index render and every worker boot-payload
 * request; listeners push their current rows, so a row's data is read
 * fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @param peer - The Peer the rendered page speaks for.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[], peer: PeerScope): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
