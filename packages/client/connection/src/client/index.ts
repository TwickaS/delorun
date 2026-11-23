/** Browser wire client: Remote transport and connection generations. */
import type { Context } from '@deepseek-ai/cordis'
import {
  ConnectionController,
  type ConnectionRecoveryConfig,
  type ConnectionGeneration,
  type ConnectionGenerationSource,
  type ConnectionSinks,
  type ConnectionState,
} from './connection.ts'
import { createWebConnectionRpc, type RpcFetch, type RpcStreamOpen } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { resolveConnectionConfig } from '../recovery-config.ts'
import type { ConnectionInteractions } from '../connect-protocol.ts'
import { openConnectionWebSocket, type ConnectionWebSocket, type ConnectionWebSocketFactory } from './socket.ts'

export type { ConnectionInteractions } from '../connect-protocol.ts'
export type { ConnectionWebSocket, ConnectionWebSocketFactory } from './socket.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connection generation was established. Wire-derived caches must
     * repull; long-lived streams own their own resume and baseline lifecycle.
     * @mode emit
     */
    'connection/reset'(): void
  }
}

// ---- Browser-safe protocol and shared value re-exports ----
export type {
  MessageId,
  RpcRequest, RpcResponse, RpcResult,
  ClientRequest, ServerResponse, RpcMessage,
  SessionId, SessionEvent, ContentBlock, StreamChunk,
} from './api.ts'
export {
  RpcId,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type {
  ConnectionRecoveryConfig,
  ConnectionGeneration,
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionSinks,
  ConnectionState,
} from './connection.ts'
export type {
  ClientConnectionRpc, ConnectionRpcFailure, ConnectionRpcResult,
} from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** Observable identity and Host facts for the active connection generation. */
export interface ConnectionGenerationState {
  /** Active generation, or undefined before readiness and while reconnecting. */
  getSnapshot(): ConnectionGeneration | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Observable recovery lifecycle of the owned Connection loop. */
export interface ConnectionStateSource {
  /** Current state, or undefined before the first connection outcome. */
  getSnapshot(): ConnectionState | undefined
  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void
}

/** Observable time of the owned Connection loop's next automatic attempt. */
export interface ConnectionRetrySource {
  /** `Date.now()` milliseconds of the next automatic attempt while the loop waits out a backoff delay; otherwise undefined. */
  getSnapshot(): number | undefined
  /** Subscribe to a delay starting and ending. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Physical carrier selected when the Connection service is installed. The
 * served web app omits it and gets HTTP + WebSocket; a shell that owns a
 * different transport (the worker preview's postMessage tunnel) provides both
 * halves instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /**
   * Already decoded logical RPC carrier. When present it replaces the HTTP
   * caller outright: no envelopes, no `fetch`, no `openStream` (an in-process
   * Host such as a test mock plugs in here).
   */
  rpc?: ClientConnectionRpc
  /** Transport for generic unary RPC channels (the Typert gateway); unused when `rpc` is present. */
  fetch?: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket or `rpc` is present. */
  openStream?: RpcStreamOpen
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
  /**
   * Package-asset resolver for the module system, present when the page cannot
   * request `plugins/<package>/assets/<path>` itself (the worker tunnel): it
   * maps each reference to a URL the page can load. Absent in the served web app.
   */
  resolveAsset?(reference: string): string
  /**
   * The transport owner declares the page owns the Host outright: the Host
   * runs inside a worker this page spawned, so no other party can reach it and
   * the loopback stand-in for "the owner's own machine" is vacuous.
   * `ctx.connection.isLoopback` then reports the privileged surface reachable
   * regardless of the page authority. Only a shell that assembles its own
   * transport can set this; served pages never carry the global at all.
   */
  ownsHost?: boolean
  /** Authenticated WebSocket factory; omission uses the browser API and its cookie jar. */
  createWebSocket?: ConnectionWebSocketFactory
  /** Host base URL for desktop or Node sockets; omission uses the document base. */
  streamBaseUrl?: string
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
  __DSH_CONNECTION_RECOVERY__?: unknown
  __DSH_REMOTE_MEDIA__?: unknown
}

/**
 * How the page treats images and media from other origins: `placeholder` on
 * a page a reach listener served, whose Content Security Policy refuses them,
 * so renderers show a placeholder and never request them; `load` elsewhere.
 */
export type RemoteMediaMode = 'load' | 'placeholder'

/** Browser location fields used to classify loopback authority. */
export interface ConnectionLocation {
  readonly hostname: string
}

/** Instance-local inputs for installing a Connection service. */
export interface ConnectionInstallOptions {
  /** Forwarded-event participation; omission selects answer for a page and none otherwise. */
  readonly interactions?: ConnectionInteractions
  /** Explicit physical carrier; omit for the browser HTTP + WebSocket carrier. */
  readonly transport?: ClientTransportHooks
  /** Reconnect timing overrides; omitted fields use controller defaults. */
  readonly recovery?: ConnectionRecoveryConfig
  /** Page location; omit for a non-browser composition. */
  readonly location?: ConnectionLocation
  /** Remote media handling the Host declared for this page; omission loads remote media. */
  readonly remoteMedia?: RemoteMediaMode
}

/**
 * The ctx.connection service API. API Gateway supplies generation readiness
 * and reset callbacks; Connection stays independent of downstream domain state.
 */
export interface ConnectionHandle {
  /** Forwarded-event participation selected at installation. */
  readonly interactions: ConnectionInteractions
  /**
   * Whether the privileged surface is reachable: the page authority is
   * loopback, the transport declares the page owns the Host
   * ({@link ClientTransportHooks.ownsHost}), or the context is not a browser.
   */
  readonly isLoopback: boolean
  /** How renderers treat images and media from other origins on this page. */
  readonly remoteMedia: RemoteMediaMode
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: ConnectionGenerationState
  /** Current recovery lifecycle for connection-specific consumers. */
  readonly state: ConnectionStateSource
  /**
   * When the next automatic attempt starts, while the loop waits between attempts, for a countdown. `installConnection`
   * always provides it; it is optional so that a stand-in handle built without an owned loop need not.
   */
  readonly retry?: ConnectionRetrySource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Create a socket on the selected carrier; the channel owns framing and closing.
   * @param path - absolute logical channel path, resolved beneath the Host mount.
   * @returns a newly connecting socket using the installed authentication factory.
   */
  openWebSocket(path: string): ConnectionWebSocket
  /**
   * Register a provider of extra request headers and WebSocket subprotocols for the browser carrier, which a client
   * plugin uses to attach a credential it holds in page memory. The provider is read for every `rpc` request and every
   * `openWebSocket`, so a changed credential applies to the next request or socket; a socket already open keeps the
   * subprotocols it offered, and the plugin calls `reconnect` to replace it. Headers are not sent by a Host-provided
   * `transport.rpc`, and subprotocols are not offered by a `transport.createWebSocket`. Several
   * providers merge in registration order, a later one winning a header name.
   * @param provider - called per request; returns the headers and the subprotocols to add.
   * @returns disposer that withdraws the provider.
   */
  registerRequestExtras(provider: RequestExtrasProvider): () => void
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /**
   * Register the sole source defining Host generations. The source reports
   * ready only after its incremental listeners are attached.
   * @param source - long-lived generation source owned by the push carrier.
   * @returns disposer withdrawing the source and stopping an active loop.
   */
  registerGenerationSource(source: ConnectionGenerationSource): () => void
  /**
   * Start the connect/reconnect loop with the consumer's state callbacks.
   * API Gateway owns the loop; a second call throws.
   * @param sinks - connection-state callbacks.
   * @param config - explicit timing overrides; omitted fields use Host bootstrap timing.
   * @returns lifecycle controls for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): ConnectionLoop
}

/** Extra request headers and WebSocket subprotocols a client plugin adds to the browser carrier. */
export interface RequestExtras {
  readonly headers?: Readonly<Record<string, string>>
  readonly subprotocols?: readonly string[]
}

/** Reads the {@link RequestExtras} of one request or socket. */
export type RequestExtrasProvider = () => RequestExtras

/** Controls retained by the sole owner of a running connection loop. */
export interface ConnectionLoop {
  /** Stop the loop and withdraw its active generation. */
  stop(): void
}

interface ConnectionOwner {
  readonly token: object
  readonly source: ConnectionGenerationSource
  readonly controller: ConnectionController
  readonly stopNetworkWatch: () => void
}

interface BrowserNetworkTarget {
  readonly navigator?: { readonly onLine?: boolean }
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

/**
 * Feed the browser's online and offline events into the controller, which pauses automatic retries while offline.
 * A loopback Host is reachable without any network, so a page served from it never follows them: a computer with its
 * Wi-Fi off, or a browser in a network namespace with only loopback, reports `navigator.onLine === false` while the
 * studio on the same computer is up.
 * @param controller - the connection controller.
 * @param hostIsLoopback - whether the page's Host is on this computer.
 * @returns the function that removes the listeners.
 */
function watchBrowserNetwork(controller: ConnectionController, hostIsLoopback: boolean): () => void {
  if (hostIsLoopback) return () => {}
  const browser = (globalThis as { readonly window?: BrowserNetworkTarget }).window
  const initiallyAvailable = browser?.navigator?.onLine
  if (browser === undefined || initiallyAvailable === undefined) return () => {}
  const online = (): void => { controller.setNetworkAvailable(true) }
  const offline = (): void => { controller.setNetworkAvailable(false) }
  controller.setNetworkAvailable(initiallyAvailable)
  browser.addEventListener('online', online)
  browser.addEventListener('offline', offline)
  return () => {
    browser.removeEventListener('online', online)
    browser.removeEventListener('offline', offline)
  }
}

/**
 * Install one Context-owned Connection service from explicit composition inputs.
 * @param ctx - client Cordis context.
 * @param options - interaction participation, physical carrier, reconnect timing, and page location.
 */
export function installConnection(ctx: Context, options: ConnectionInstallOptions = {}): void {
  const pageLocation = options.location
  const transport = options.transport
  const recovery = options.recovery ?? {}
  const interactions = options.interactions ?? (pageLocation === undefined ? 'none' : 'answer')
  const extrasProviders = new Set<RequestExtrasProvider>()
  interface MergedExtras { headers: Record<string, string>; subprotocols: string[] }
  const requestExtras = (): MergedExtras => {
    const merged: MergedExtras = { headers: {}, subprotocols: [] }
    for (const provider of extrasProviders) {
      const extras = provider()
      Object.assign(merged.headers, extras.headers)
      merged.subprotocols.push(...extras.subprotocols ?? [])
    }
    return merged
  }
  const rpc = transport?.rpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream, () => requestExtras().headers)
  let generationSource: ConnectionGenerationSource | undefined
  let owner: ConnectionOwner | undefined
  let generationId = 0
  let generation: ConnectionGeneration | undefined
  let state: ConnectionState | undefined
  let retryAt: number | undefined
  const generationListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const retryListeners = new Set<() => void>()
  const publishGeneration = (next: ConnectionGeneration | undefined): void => {
    if (Object.is(generation, next)) return
    generation = next
    for (const listener of [...generationListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] generation listener threw:', error)
      }
    }
  }
  const publishState = (next: ConnectionState | undefined): void => {
    if (state === next) return
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] state listener threw:', error)
      }
    }
  }
  const publishRetry = (next: number | undefined): void => {
    if (retryAt === next) return
    retryAt = next
    for (const listener of [...retryListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] retry listener threw:', error)
      }
    }
  }
  const releaseOwner = (current: ConnectionOwner): void => {
    if (owner !== current) return
    owner = undefined
    current.stopNetworkWatch()
    current.controller.stop()
    publishGeneration(undefined)
    publishState(undefined)
    publishRetry(undefined)
  }
  const handle: ConnectionHandle = {
    interactions,
    openWebSocket: path => openConnectionWebSocket(
      path, transport?.createWebSocket, transport?.streamBaseUrl, requestExtras().subprotocols,
    ),
    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    remoteMedia: options.remoteMedia ?? 'load',
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    retry: {
      getSnapshot: () => retryAt,
      subscribe: (listener) => {
        retryListeners.add(listener)
        return () => { retryListeners.delete(listener) }
      },
    },
    rpc,
    registerRequestExtras(provider) {
      extrasProviders.add(provider)
      return () => { extrasProviders.delete(provider) }
    },
    reconnect() {
      owner?.controller.reconnect()
    },
    registerGenerationSource(source) {
      if (generationSource !== undefined) {
        throw new Error('connection: a generation source is already registered')
      }
      generationSource = source
      return () => {
        if (generationSource !== source) return
        generationSource = undefined
        const current = owner
        if (current?.source === source) releaseOwner(current)
      }
    },
    start(sinks, config) {
      if (owner !== undefined) throw new Error('connection: the stream loop is already owned by another consumer')
      const source = generationSource
      if (source === undefined) throw new Error('connection: no generation source is registered')
      const token = {}
      const ownsGeneration = (): boolean => owner?.token === token
      const controller = new ConnectionController(source, {
        ...sinks,
        onConnected: (host) => {
          const nextGeneration = { id: ++generationId, host }
          publishGeneration(nextGeneration)
          if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return
          sinks.onConnected?.(host)
        },
        onStateChange: (state) => {
          if (state !== 'connected') {
            publishGeneration(undefined)
          }
          if (!ownsGeneration()) return
          publishState(state)
          sinks.onStateChange?.(state)
        },
        onRetryScheduled: (at) => {
          if (!ownsGeneration()) return
          publishRetry(at)
          sinks.onRetryScheduled?.(at)
        },
      }, { ...recovery, ...config })
      const current = { token, source, controller, stopNetworkWatch: watchBrowserNetwork(controller, handle.isLoopback) }
      owner = current
      controller.start()
      return {
        stop: () => { releaseOwner(current) },
      }
    },
  }
  ctx.provide('connection', handle)
}

/**
 * Client plugin body: read the page composition and install its Connection service.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: Context): void {
  const globals = globalThis as ClientTransportGlobal
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const transport = globals.__DSH_TRANSPORT__
  installConnection(ctx, {
    ...(transport === undefined ? {} : { transport }),
    recovery: resolveConnectionConfig(globals.__DSH_CONNECTION_RECOVERY__),
    ...(pageLocation === undefined ? {} : { location: pageLocation }),
    remoteMedia: globals.__DSH_REMOTE_MEDIA__ === 'placeholder' ? 'placeholder' : 'load',
  })
}
