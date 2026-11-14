/**
 * The relay's assertion about the peer of a browser connection. One browser connection's
 * address and port are what the relay's own socket reports for it, passed to the home
 * unchanged; nothing on the home can check them, so every value carries `verified: false`
 * and an `OPEN` frame has no field that claims otherwise (C6, "What this does not prove").
 *
 * @module @delorun/relay/peer
 */
import type { OpenPayload } from '@delorun/contract-relay-protocol'

/** The peer facts of one browser connection, as the relay asserts them. */
export interface PeerAssertion {
  /** The browser connection's address as the relay's socket reports it. */
  readonly clientAddress: string
  /** The browser connection's port as the relay's socket reports it. */
  readonly clientPort: number
  /** Always false: the relay asserts these facts and the home cannot verify them. */
  readonly verified: false
}

/** What the transport reports about a connection's peer. */
export interface ObservedPeer {
  /** The address, or `undefined` when the transport reports none (an in-memory or Unix socket). */
  readonly address: string | undefined
  /** The port, or `undefined` when the transport reports none. */
  readonly port: number | undefined
}

/** Address a peer fact carries when the transport reports none. */
export const UNKNOWN_CLIENT_ADDRESS = 'unknown'

/**
 * The relay's assertion for one observed browser connection.
 * @param observed - the address and port the transport reports for the connection.
 * @returns the assertion, marked unverified and never widened with another claim.
 */
export function peerAssertion(observed: ObservedPeer): PeerAssertion {
  return {
    clientAddress: observed.address === undefined || observed.address.length === 0 ? UNKNOWN_CLIENT_ADDRESS : observed.address,
    clientPort: observed.port === undefined || observed.port < 0 || observed.port > 65_535 ? 0 : observed.port,
    verified: false,
  }
}

/**
 * The `OPEN` payload of a peer assertion: exactly the three fields C6 defines, so no field of
 * the frame claims a verification the relay cannot give.
 * @param sni - the name of the ClientHello that opened the stream.
 * @param peer - the assertion.
 * @returns the payload.
 */
export function openPayload(sni: string, peer: PeerAssertion): OpenPayload {
  return { sni, clientAddress: peer.clientAddress, clientPort: peer.clientPort }
}
