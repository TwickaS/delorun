/**
 * Who a connection to a reach listener really is, asked of Tailscale's local API (A667).
 *
 * `tailscale serve` terminates the tailnet connection and opens a *new* loopback connection to this home's fixed
 * listener port, so the socket peer the reach listener sees is always `127.0.0.1` and `whois` on it answers nothing.
 * The peer's own tailnet address reaches the listener only in `X-Forwarded-For`, which `tailscaled` overwrites on
 * every proxied request (`addProxyForwardedHeaders`, `ipn/ipnlocal/serve.go`). That address is a claim, so this module
 * never trusts it: it asks `GET /localapi/v0/whois?addr=<address>` over `tailscaled`'s Unix socket, and the daemon
 * names the device and its user from its own netmap (`serveWhoIsWithBackend`, `ipn/localapi/localapi.go`).
 *
 * Every way Tailscale can fail to answer is a refusal, never an assumption of the tailnet: a missing socket, a daemon
 * that does not answer, an address the daemon does not know, and a device whose key has expired or that left the
 * tailnet. {@link checkTailnetPeer} returns the refusal as a value, so a caller cannot mistake one for a peer.
 *
 * @module @delorun/reach/tailnet-peer
 */
import { request } from 'node:http'

/** Why a connection could not be shown to come from a tailnet peer. */
export type TailnetPeerRefusal =
  /** `tailscaled`'s socket is not there: Tailscale is not installed, or not running. */
  | 'socket-absent'
  /** The socket is there but the daemon did not answer, or answered something this module cannot read. */
  | 'daemon-down'
  /** The daemon answered and does not know the address: it is not a device of this tailnet. */
  | 'unknown-peer'
  /** The daemon knows the device but its key has expired, so it has left the tailnet. */
  | 'device-removed'
  /** The address is not a tailnet address at all, so no tailnet peer can have sent it. */
  | 'not-a-tailnet-address'

/** One device of the tailnet, as `tailscaled` names it. */
export interface TailnetPeer {
  /** The node's id in the netmap. */
  readonly nodeId: string
  /** The node's stable id, which survives a key rotation. */
  readonly stableId: string
  /** The node's MagicDNS name, without the trailing dot. */
  readonly name: string
  /** The tailnet login that owns the device. */
  readonly login: string
  /** The display name the identity provider gives that login. */
  readonly displayName: string
}

/** What {@link checkTailnetPeer} found. */
export type TailnetPeerCheck =
  | { readonly kind: 'peer'; readonly peer: TailnetPeer }
  | { readonly kind: 'refused'; readonly refusal: TailnetPeerRefusal; readonly detail: string }

/** The longest answer one local API call may print before it is refused. */
export const LOCAL_API_OUTPUT_LIMIT_BYTES = 1024 * 1024

/** The longest one local API call may take, in milliseconds. */
export const LOCAL_API_TIMEOUT_MS = 2_000

/**
 * The path of `tailscaled`'s Unix socket on this platform, from `paths.DefaultTailscaledSocket` of the Tailscale
 * repository: `/var/run/tailscale/tailscaled.sock` on Linux, `/var/run/tailscaled.socket` on macOS and the BSDs.
 * @param platform - `process.platform`.
 * @returns the path, or undefined on a platform whose daemon listens on a named pipe instead.
 */
export function tailscaledSocketPath(platform: string = process.platform): string | undefined {
  if (platform === 'linux') return '/var/run/tailscale/tailscaled.sock'
  if (platform === 'win32') return undefined
  return '/var/run/tailscaled.socket'
}

/**
 * Whether an address is one the tailnet hands out: `100.64.0.0/10` for IPv4 and `fd7a:115c:a1e0::/48` for IPv6.
 * @param address - the address, as text.
 * @returns whether it is a tailnet address.
 */
export function isTailnetAddress(address: string): boolean {
  if (address.includes(':')) return /^fd7a:115c:a1e0:/i.test(address)
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const [first, second] = parts.map(part => Number(part))
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false
  return first === 100 && second !== undefined && second >= 64 && second <= 127
}

/** One local API answer: its status and its body. */
interface LocalApiAnswer {
  readonly status: number
  readonly body: string
}

/**
 * Ask the local API one question over `tailscaled`'s Unix socket.
 * @param socketPath - the socket's path.
 * @param path - the local API path, with its query.
 * @param timeoutMs - the longest the call may take.
 * @returns the answer, or the refusal that stopped it.
 */
function askLocalApi(socketPath: string, path: string, timeoutMs: number): Promise<{ readonly answer: LocalApiAnswer } | { readonly refusal: TailnetPeerRefusal; readonly detail: string }> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: { readonly answer: LocalApiAnswer } | { readonly refusal: TailnetPeerRefusal; readonly detail: string }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const call = request({ socketPath, path, method: 'GET', timeout: timeoutMs, headers: { host: 'local-tailscaled.sock' } }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > LOCAL_API_OUTPUT_LIMIT_BYTES) {
          call.destroy()
          settle({ refusal: 'daemon-down', detail: 'tailscaled answered more than this home reads' })
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => { settle({ answer: { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') } }) })
      response.on('error', () => { settle({ refusal: 'daemon-down', detail: 'tailscaled closed the answer' }) })
    })
    call.on('timeout', () => { call.destroy(); settle({ refusal: 'daemon-down', detail: `tailscaled did not answer within ${String(timeoutMs)} ms` }) })
    call.on('error', (error: NodeJS.ErrnoException) => {
      // A socket that is not there is Tailscale not running, which is a different refusal from a daemon that is there
      // and silent: the first says to install or start Tailscale, the second says to look at it.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') settle({ refusal: 'socket-absent', detail: 'Tailscale is not running on this computer' })
      else if (error.code === 'ECONNREFUSED') settle({ refusal: 'daemon-down', detail: 'tailscaled is not accepting connections' })
      else settle({ refusal: 'daemon-down', detail: `tailscaled could not be asked: ${error.code ?? error.message}` })
    })
    call.end()
  })
}

/**
 * Read one field of a JSON object, or undefined.
 * @param value - the value.
 * @param key - the field's name.
 * @returns the field, or undefined when the value is not an object or has no such field.
 */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * Read a string field of a JSON object, or the empty string.
 * @param value - the value.
 * @param key - the field's name.
 * @returns the field, or the empty string.
 */
function textOf(value: unknown, key: string): string {
  const field = fieldOf(value, key)
  return typeof field === 'string' ? field : ''
}

/**
 * Whether a node's key expiry has passed, which is a device that has left the tailnet.
 * @param expiry - the `KeyExpiry` field, as `tailscaled` prints it.
 * @param now - the clock, in milliseconds since the epoch.
 * @returns whether it has passed; a zero expiry never does.
 */
function hasExpired(expiry: string, now: number): boolean {
  if (expiry === '') return false
  const at = Date.parse(expiry)
  // A zero time is Go's "no expiry", which is a device that stays; an unreadable one is refused as expired.
  if (Number.isNaN(at)) return true
  return at > 0 && at <= now
}

/**
 * Ask Tailscale's local API who a connection's peer is.
 *
 * The address is the one `tailscaled` wrote into `X-Forwarded-For`, and it is only a claim until the daemon answers:
 * the daemon looks the address up in its own netmap and names the device and its user. Every failure is a refusal.
 * @param address - the peer's address, as `tailscaled` forwarded it.
 * @param options - the socket path, the platform, the clock and the call's budget.
 * @param options.socketPath - `tailscaled`'s socket; {@link tailscaledSocketPath} of the platform by default.
 * @param options.platform - `process.platform`, which decides the socket's path when none is given.
 * @param options.now - the clock, in milliseconds since the epoch.
 * @param options.timeoutMs - the longest the call may take.
 * @returns the peer, or the refusal that says why no peer could be named.
 */
export async function checkTailnetPeer(address: string, options: { readonly socketPath?: string | undefined; readonly platform?: string; readonly now?: () => number; readonly timeoutMs?: number } = {}): Promise<TailnetPeerCheck> {
  const socketPath = options.socketPath ?? tailscaledSocketPath(options.platform)
  if (socketPath === undefined) return { kind: 'refused', refusal: 'socket-absent', detail: 'Tailscale keeps no local API socket on this platform' }
  if (!isTailnetAddress(address)) return { kind: 'refused', refusal: 'not-a-tailnet-address', detail: `${address} is not a tailnet address` }
  const asked = await askLocalApi(socketPath, `/localapi/v0/whois?addr=${encodeURIComponent(address)}`, options.timeoutMs ?? LOCAL_API_TIMEOUT_MS)
  if ('refusal' in asked) return { kind: 'refused', refusal: asked.refusal, detail: asked.detail }
  // 404 is the daemon saying it knows no such device; 403 is a caller it does not let read, which is no answer either.
  if (asked.answer.status === 404) return { kind: 'refused', refusal: 'unknown-peer', detail: `Tailscale knows no device at ${address}` }
  if (asked.answer.status !== 200) return { kind: 'refused', refusal: 'daemon-down', detail: `tailscaled answered ${String(asked.answer.status)}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(asked.answer.body)
  } catch (_notJson: unknown) {
    // An answer that is not the whois JSON is a daemon this home cannot read, which names no peer.
    return { kind: 'refused', refusal: 'daemon-down', detail: 'tailscaled answered something that is not the whois JSON' }
  }
  const node = fieldOf(parsed, 'Node')
  const user = fieldOf(parsed, 'UserProfile')
  const nodeId = fieldOf(node, 'ID')
  const name = textOf(node, 'Name').replace(/\.$/, '')
  const login = textOf(user, 'LoginName')
  if (node === undefined || user === undefined || name === '' || login === '') {
    return { kind: 'refused', refusal: 'daemon-down', detail: 'tailscaled named no device or no user for the address' }
  }
  if (hasExpired(textOf(node, 'KeyExpiry'), (options.now ?? Date.now)())) {
    return { kind: 'refused', refusal: 'device-removed', detail: `${name} has left the tailnet` }
  }
  return {
    kind: 'peer',
    peer: { nodeId: String(nodeId ?? ''), stableId: textOf(node, 'StableID'), name, login, displayName: textOf(user, 'DisplayName') },
  }
}