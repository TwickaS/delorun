/**
 * Renewal of a sliding unlock by the person typing in an attached terminal. An unlock that ends closes the device's
 * reach connections, terminal streams included, and keystrokes are stream traffic rather than calls the reach policy
 * decides, so the terminal controller announces each typed write (`terminal-controller/typed`) and this renews the
 * Peer's device unlock, at most once an interval. Output, retention, resizes and protocol replies never reach it.
 *
 * @module @delorun/home-auth/typed-renewal
 */
import type { ReachListenerId } from '@delorun/contract-admission'

/** How often one device's typing renews its unlock at most, in milliseconds. */
export const TYPED_RENEWAL_INTERVAL_MS = 60_000

/** What {@link typedInputRenewal} reads and calls. */
export interface TypedRenewalOptions {
  /**
   * The device and listener a Peer speaks for.
   * @param peerId - the Peer id.
   * @returns them, or undefined for a Peer no reach listener admitted (the owner's, for one).
   */
  readonly reachPeer: (peerId: string) => { readonly deviceId: string; readonly listener: ReachListenerId } | undefined
  /**
   * Renew the device's computer-approved unlock on a listener, if it holds one.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  readonly touchDevice: (deviceId: string, listener: ReachListenerId) => void
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
}

/**
 * The listener of `terminal-controller/typed`.
 * @param options - the Peer lookup, the renewal and the clock.
 * @returns the listener, which renews a reach device's unlock at most once a {@link TYPED_RENEWAL_INTERVAL_MS}.
 */
export function typedInputRenewal(options: TypedRenewalOptions): (peer: { readonly id: string }) => void {
  const last = new Map<string, number>()
  return (peer) => {
    const reach = options.reachPeer(peer.id)
    if (reach === undefined) return
    const key = `${reach.listener}\u0000${reach.deviceId}`
    const at = options.now()
    const before = last.get(key)
    if (before !== undefined && at - before < TYPED_RENEWAL_INTERVAL_MS) return
    last.set(key, at)
    options.touchDevice(reach.deviceId, reach.listener)
  }
}
