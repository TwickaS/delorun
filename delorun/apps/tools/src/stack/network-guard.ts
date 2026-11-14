/**
 * A test-process network guard. Once installed it refuses, before any packet is sent, every
 * TCP or TLS connection, UDP send or bind, server listen and DNS query whose target is not a
 * loopback address, and records every connection that reaches its peer with the peer's
 * address. Name lookups resolve only `localhost`, and only to loopback addresses; every other
 * name is refused without a query, so a stand-in is addressed by its IP literal. The guard
 * patches `node:net`, `node:dgram` and `node:dns` in this process and restores them on
 * {@link NetworkGuard.uninstall}.
 *
 * What it does not see: child processes, worker threads (each has its own module instances),
 * native addons that open sockets themselves, and sockets created before it was installed.
 *
 * @module @delorun/tools/stack/network-guard
 */
import dgram from 'node:dgram'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import net, { isIP } from 'node:net'

/** Error code of every refusal. */
export const NETWORK_GUARD_CODE = 'DELORUN_NETWORK_GUARD_REFUSED'

/** The kinds of operation the guard checks. */
export type GuardedOperation = 'connect' | 'listen' | 'lookup' | 'resolve' | 'udp-send' | 'udp-bind' | 'udp-connect'

/** An operation the guard refused before it reached the network. */
export interface GuardRefusal {
  readonly operation: GuardedOperation
  /** The host, address or name the operation targeted, `<unspecified>` for an all-interfaces bind. */
  readonly target: string
  readonly port?: number
}

/** A connection that reached its peer. */
export interface GuardedConnection {
  /** The host the caller asked for. */
  readonly host: string
  /** The peer address the socket connected to. */
  readonly remoteAddress: string
  readonly remotePort: number
  /** Whether the peer address is loopback; always true while the guard holds. */
  readonly loopback: boolean
}

/** An installed guard. */
export interface NetworkGuard {
  readonly connections: readonly GuardedConnection[]
  readonly refusals: readonly GuardRefusal[]
  /** Restore the patched functions. Idempotent. */
  readonly uninstall: () => void
}

/** The error a refused operation fails with. */
export class NetworkGuardRefusal extends Error {
  /** {@link NETWORK_GUARD_CODE}, where Node's own socket errors carry theirs. */
  readonly code = NETWORK_GUARD_CODE
  /** The refused operation, with its target and port. */
  readonly refusal: GuardRefusal

  constructor(refusal: GuardRefusal) {
    super(`network guard: ${refusal.operation} to ${refusal.target}${refusal.port === undefined ? '' : `:${String(refusal.port)}`} leaves loopback`)
    this.refusal = refusal
  }
}

/**
 * Whether an address literal is loopback: `127.0.0.0/8`, `::1` or an IPv4-mapped `127.0.0.0/8`.
 * @param address - an IP literal, possibly in brackets.
 * @returns true for a loopback literal, false for any other text.
 */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(bare) === 4) return bare.startsWith('127.')
  if (isIP(bare) !== 6) return false
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)
  return mapped?.[1] !== undefined && mapped[1].startsWith('127.')
}

let installed: NetworkGuard | undefined

type LookupFunction = net.LookupFunction
type LookupCallback = Parameters<LookupFunction>[2]

const RESOLVE_METHODS = [
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr',
  'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
] as const

interface Patch {
  readonly target: object
  readonly key: string
  readonly original: unknown
}

/**
 * Install the guard for this process.
 * @returns the guard, whose records start empty.
 * @throws Error when a guard is already installed.
 */
export function installNetworkGuard(): NetworkGuard {
  if (installed !== undefined) throw new Error('a network guard is already installed')
  const connections: GuardedConnection[] = []
  const refusals: GuardRefusal[] = []
  const patches: Patch[] = []
  const guardedLookups = new WeakSet<object>()

  const refuse = (refusal: GuardRefusal): NetworkGuardRefusal => {
    refusals.push(refusal)
    return new NetworkGuardRefusal(refusal)
  }
  const patch = <T extends object>(target: T, key: string, replacement: (original: never) => unknown): void => {
    const original = (target as Record<string, unknown>)[key]
    if (typeof original !== 'function') return
    patches.push({ target, key, original })
    ;(target as Record<string, unknown>)[key] = replacement(original as never)
  }

  // Resolves only `localhost`, and only to loopback results; refuses every other name without a query.
  const guardedLookup = (original: LookupFunction): LookupFunction => (hostname, options, callback) => {
    if (isIP(hostname) !== 0) {
      if (isLoopbackAddress(hostname)) {
        original(hostname, options, callback)
        return
      }
    } else if (hostname.toLowerCase() === 'localhost') {
      original(hostname, options, (error, address, family) => {
        if (error !== null) {
          callback(error, address, family)
          return
        }
        const addresses = Array.isArray(address) ? address.map(entry => entry.address) : [address]
        const escaped = addresses.find(entry => !isLoopbackAddress(entry))
        if (escaped === undefined) callback(null, address, family)
        else callback(refuse({ operation: 'lookup', target: escaped }), '', 4)
      })
      return
    }
    const error = refuse({ operation: 'lookup', target: hostname })
    process.nextTick(() => { callback(error, '', 4) })
  }

  patch(net.Socket.prototype, 'connect', (original: (this: net.Socket, ...args: unknown[]) => net.Socket) => function connect(this: net.Socket, ...args: unknown[]): net.Socket {
    // `net.connect` passes its normalized arguments as one array; a direct call passes them as written.
    const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
    const options: Record<string, unknown> = typeof first === 'object' && first !== null
      ? first as Record<string, unknown>
      : typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))
        ? { port: Number(first), host: typeof args[1] === 'string' ? args[1] : undefined }
        : { path: first }
    if (typeof options.path === 'string') return original.apply(this, args)
    const host = typeof options.host === 'string' ? options.host : 'localhost'
    const port = Number(options.port)
    if (isIP(host) !== 0 ? !isLoopbackAddress(host) : host.toLowerCase() !== 'localhost') {
      const error = refuse({ operation: 'connect', target: host, port })
      process.nextTick(() => { this.destroy(error) })
      return this
    }
    // Without its own lookup the socket calls `dns.lookup`, which the guard patches below.
    if (typeof options.lookup === 'function' && !guardedLookups.has(options.lookup)) {
      const wrapped = guardedLookup(options.lookup as LookupFunction)
      guardedLookups.add(wrapped)
      options.lookup = wrapped
    }
    this.once('connect', () => {
      const remoteAddress = this.remoteAddress ?? ''
      connections.push({ host, remoteAddress, remotePort: this.remotePort ?? 0, loopback: isLoopbackAddress(remoteAddress) })
    })
    return original.apply(this, args)
  })

  patch(net.Server.prototype, 'listen', (original: (this: net.Server, ...args: unknown[]) => net.Server) => function listen(this: net.Server, ...args: unknown[]): net.Server {
    const first = args[0]
    let host: unknown
    if (typeof first === 'object' && first !== null) {
      const options = first as Record<string, unknown>
      if (typeof options.path === 'string' || 'fd' in options || '_handle' in options || 'handle' in options) return original.apply(this, args)
      host = options.host
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      return original.apply(this, args)
    } else {
      host = typeof args[1] === 'string' ? args[1] : undefined
    }
    if (typeof host !== 'string' || !isLoopbackAddress(host)) {
      const error = refuse({ operation: 'listen', target: typeof host === 'string' ? host : '<unspecified>' })
      process.nextTick(() => { this.emit('error', error) })
      return this
    }
    return original.apply(this, args)
  })

  const udpTarget = (address: unknown): string | undefined => {
    if (address === undefined || address === null) return undefined
    if (typeof address !== 'string') return '<invalid>'
    if (isIP(address) !== 0 ? isLoopbackAddress(address) : address.toLowerCase() === 'localhost') return undefined
    return address
  }
  patch(dgram.Socket.prototype, 'send', (original: (this: dgram.Socket, ...args: unknown[]) => void) => function send(this: dgram.Socket, ...args: unknown[]): void {
    // `send(msg, offset, length, port, address)` against `send(msg, port, address)`; a connected socket omits both.
    const offsetForm = typeof args[1] === 'number' && typeof args[2] === 'number'
    const address = offsetForm ? args[4] : args[2]
    const escaped = typeof address === 'function' ? undefined : udpTarget(address)
    if (escaped === undefined) {
      original.apply(this, args)
      return
    }
    const error = refuse({ operation: 'udp-send', target: escaped })
    const callback = args.findLast(arg => typeof arg === 'function') as ((error: Error) => void) | undefined
    process.nextTick(() => { if (callback === undefined) this.emit('error', error); else callback(error) })
  })
  patch(dgram.Socket.prototype, 'connect', (original: (this: dgram.Socket, ...args: unknown[]) => void) => function connect(this: dgram.Socket, ...args: unknown[]): void {
    const escaped = typeof args[1] === 'string' ? udpTarget(args[1]) : undefined
    if (escaped === undefined) {
      original.apply(this, args)
      return
    }
    const error = refuse({ operation: 'udp-connect', target: escaped })
    process.nextTick(() => { this.emit('error', error) })
  })
  patch(dgram.Socket.prototype, 'bind', (original: (this: dgram.Socket, ...args: unknown[]) => dgram.Socket) => function bind(this: dgram.Socket, ...args: unknown[]): dgram.Socket {
    const first = args[0]
    const address = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).address : args[1]
    if (typeof address === 'string' && isLoopbackAddress(address)) return original.apply(this, args)
    const error = refuse({ operation: 'udp-bind', target: typeof address === 'string' ? address : '<unspecified>' })
    process.nextTick(() => { this.emit('error', error) })
    return this
  })

  patch(dns, 'lookup', (original: LookupFunction) => function lookup(hostname: string, ...rest: unknown[]): void {
    const callback = rest.findLast(arg => typeof arg === 'function') as LookupCallback
    const raw = rest.length > 1 ? rest[0] : {}
    const options: dns.LookupOptions = typeof raw === 'number' ? { family: raw } : raw as dns.LookupOptions
    guardedLookup(original)(hostname, options, callback)
  })
  patch(dns.promises, 'lookup', (original: (hostname: string, options?: dns.LookupOptions) => Promise<unknown>) => async function lookup(hostname: string, options?: dns.LookupOptions): Promise<unknown> {
    if (isIP(hostname) !== 0 ? !isLoopbackAddress(hostname) : hostname.toLowerCase() !== 'localhost') throw refuse({ operation: 'lookup', target: hostname })
    const result = await original(hostname, options)
    const entries = (Array.isArray(result) ? result : [result]) as dns.LookupAddress[]
    const escaped = entries.find(entry => !isLoopbackAddress(entry.address))
    if (escaped !== undefined) throw refuse({ operation: 'lookup', target: escaped.address })
    return result
  })
  for (const target of [dns, dns.Resolver.prototype, dns.promises, dns.promises.Resolver.prototype]) {
    const promised = target === dns.promises || target === dns.promises.Resolver.prototype
    for (const method of RESOLVE_METHODS) {
      patch(target, method, () => function resolve(name: unknown, ...rest: unknown[]): unknown {
        const error = refuse({ operation: 'resolve', target: String(name) })
        if (promised) return Promise.reject(error)
        const callback = rest.findLast(arg => typeof arg === 'function') as ((error: Error) => void) | undefined
        process.nextTick(() => { callback?.(error) })
        return undefined
      })
    }
  }
  syncBuiltinESMExports()

  const guard: NetworkGuard = {
    connections,
    refusals,
    uninstall: () => {
      if (installed !== guard) return
      for (const { target, key, original } of patches.reverse()) (target as Record<string, unknown>)[key] = original
      syncBuiltinESMExports()
      installed = undefined
    },
  }
  installed = guard
  return guard
}
