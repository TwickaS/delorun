/**
 * The self-hosted relay data plane of contract C6 (`delo/docs/contracts/c06-relay-protocol.md`):
 * the configuration and bindings, the tunnel token issuer, the home-key handshake, the frame
 * codec with flow control, the SNI reader that routes a browser connection to the one home that
 * registered that name, and C20's `relay` log. The Node transport — TCP, TLS termination for the
 * tunnel host and the WebSocket upgrade — is the `@delo/relay/node` entry, so a spec or a
 * fixture drives the whole data plane through in-memory connections.
 *
 * @module @delo/relay
 */
export { ClientHelloReader, isHostName, type ClientHelloRead } from './client-hello.ts'
export { DEFAULT_STATE_DIR, loadRelayConfig, loadTokenKey, parseRelayConfig, RELAY_CONFIG_PATH, type LoadConfigOptions, type RelayBindingView, type RelaySettings } from './config.ts'
export { closeCodeOf, httpStatusOf, isRelayError, RelayError, type RelayCloseErrorCode, type RelayErrorCode, type RelayHttpErrorCode } from './errors.ts'
export { encodeClose, encodeControl, encodeCredit, encodeData, encodeFrame, encodeOpen, parseFrame, type Frame, type HomeControlMessage, type StreamCloseReason } from './frames.ts'
export { fromBase64Url, keyIdOf, publicKeyFromRaw, rawPublicKey, toBase64Url, verifyBytes } from './keys.ts'
export { openRelayLog, silentRelayLog, type OpenRelayLogOptions, type RelayLog, type RelayLogHandle } from './log.ts'
export { openPayload, peerAssertion, UNKNOWN_CLIENT_ADDRESS, type ObservedPeer, type PeerAssertion } from './peer.ts'
export { presentedToken, RelayCore, tokenRefusal, type BrowserVerdict, type RelayCoreOptions, type TunnelAcceptance, type TunnelUpgrade } from './relay.ts'
export { Stream, type StreamOptions } from './stream.ts'
export { proofMessage, Tunnel, type ReadyLimits, type TunnelOptions } from './tunnel.ts'
export { systemTimers, type BrowserConnection, type TimerSeam, type TunnelSocket } from './transport.ts'
