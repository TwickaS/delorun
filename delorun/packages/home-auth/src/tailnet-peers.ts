/**
 * The corroborated tailnet peers of the connections this home is serving (A666, A667).
 *
 * Admission is synchronous, so it cannot wait for Tailscale's local API. This cache is what it reads: {@link peerOf}
 * answers from memory, and {@link refresh} asks the daemon and remembers the answer. A miss is not a refusal of the
 * connection — it is the absence of the tailnet-peer grant, so the connection keeps today's behaviour — and it starts a
 * refresh, so the next request from that address is corroborated. A refusal is remembered too, so a forged address is
 * not asked about on every request.
 *
 * **What a remembered peer proves.** The daemon corroborated the address against its own netmap, so an address that is
 * not a device of the tailnet is refused. It does not prove the request came from that device: the fixed listener port
 * on `127.0.0.1` is reachable by every process of the person's user, and such a process can send the forwarded header
 * itself. That user can already reach the studio on the loopback listener, so this widens no boundary, but a peer is
 * corroborated and never cryptographically proven.
 *
 * @module @delorun/home-auth/tailnet-peers
 */

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

/** What a tailnet peer check found. */
export type TailnetPeerCheck =
  | { readonly kind: 'peer'; readonly peer: TailnetPeer }
  | { readonly kind: 'refused'; readonly refusal: TailnetPeerRefusal; readonly detail: string }

/** How long one corroborated address is remembered, in milliseconds. */
export const PEER_CACHE_TTL_MS = 30_000

/** One remembered answer. */
interface CachedPeer {
  readonly peer: TailnetPeer | undefined
  readonly at: number
}

/** The corroborated peers, by forwarded address. */
export class TailnetPeerCache {
  private readonly entries = new Map<string, CachedPeer>()
  private readonly pending = new Set<string>()
  private readonly check: (address: string) => Promise<TailnetPeerCheck>
  private readonly now: () => number
  private readonly ttlMs: number

  /**
   * @param check - the local API check, which the reach provider supplies.
   * @param now - the clock, in milliseconds since the epoch.
   * @param ttlMs - how long one answer is remembered.
   */
  constructor(check: (address: string) => Promise<TailnetPeerCheck>, now: () => number = Date.now, ttlMs: number = PEER_CACHE_TTL_MS) {
    this.check = check
    this.now = now
    this.ttlMs = ttlMs
  }

  /**
   * The peer an address was last corroborated as, from memory alone.
   * @param address - the address `tailscaled` forwarded.
   * @returns the peer, or undefined when it was not corroborated, the answer expired, or none was asked for yet.
   */
  peerOf(address: string): TailnetPeer | undefined {
    const entry = this.entries.get(address)
    if (entry === undefined) return undefined
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(address)
      return undefined
    }
    return entry.peer
  }

  /**
   * Ask the daemon about an address and remember the answer, unless a call for it is already running.
   * @param address - the address `tailscaled` forwarded.
   * @returns once the answer is remembered; a check that throws remembers no peer.
   */
  async refresh(address: string): Promise<void> {
    if (this.pending.has(address)) return
    this.pending.add(address)
    try {
      const check = await this.check(address)
      this.entries.set(address, { peer: check.kind === 'peer' ? check.peer : undefined, at: this.now() })
    } catch (_unasked: unknown) {
      // A check that threw corroborated nothing, which is the same as a refusal: no peer is remembered.
      this.entries.set(address, { peer: undefined, at: this.now() })
    } finally {
      this.pending.delete(address)
    }
  }

  /** Forget every remembered answer. */
  clear(): void {
    this.entries.clear()
  }
}
