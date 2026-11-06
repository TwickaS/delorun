/**
 * Relay configuration, tunnel token claims, handshake messages, frame types, close and
 * error codes, announcements, rebind statements and limits of the relay protocol, as
 * specified by `delo/docs/contracts/c06-relay-protocol.md`. Every byte string is
 * base64url without padding, and every signed object is signed over its RFC 8785
 * serialisation without its `signature` field. This module holds readonly constants and
 * types only.
 *
 * @module @delo/contract-relay-protocol
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Version of every signed object of the protocol. */
export const RELAY_PROTOCOL_VERSION = 1 as const

/** WebSocket subprotocol of a tunnel. */
export const RELAY_SUBPROTOCOL = 'delo-relay.v1' as const

/** Paths the relay serves on its tunnel host, and nowhere else. */
export const RELAY_PATHS = { tunnelToken: '/v1/tunnel-token', tunnel: '/v1/tunnel' } as const

/** Base64url text without padding. */
export type Base64Url = Branded<'Base64Url'>

/** Id of a relay: the SHA-256 hash of its token public key, base64url. */
export type RelayId = Branded<'RelayId'>

/** One binding of the self-hosted relay's configuration. */
export interface RelayBinding {
  /** Studio name, a DNS host name. */
  readonly name: string
  /** 32-byte raw Ed25519 home public key. */
  readonly homePublicKey: Base64Url
  readonly rebindStatement?: RebindStatement
  /** The operator replaces the binding without the previous key's signature. */
  readonly forceRebind?: true
}

/** The self-hosted relay's configuration file, `/etc/delo-relay/relay.yaml`. */
export interface RelayConfig {
  readonly tunnelHost: string
  readonly tunnelCertFile: string
  readonly tunnelKeyFile: string
  readonly bindings: readonly RelayBinding[]
  /** Directory of the token key and binding history. Default `/var/lib/delo-relay`. */
  readonly stateDir?: string
}

/** Body of `POST /v1/tunnel-token`, signed by the home key. */
export interface TunnelTokenRequest {
  readonly v: typeof RELAY_PROTOCOL_VERSION
  readonly name: string
  readonly homePublicKey: Base64Url
  /** Milliseconds since the epoch, within 60 seconds of the issuer's clock. */
  readonly timestamp: number
  readonly signature: Base64Url
}

/** Claims of a tunnel token, which the issuer's token key signs. */
export interface TunnelTokenClaims {
  readonly v: typeof RELAY_PROTOCOL_VERSION
  readonly iss: RelayId
  readonly name: string
  readonly homeKeyId: Base64Url
  /** 16 random bytes; the relay refuses a `jti` it has accepted. */
  readonly jti: Base64Url
  readonly iat: number
  /** `iat` plus {@link RELAY_LIMITS.tokenLifetimeMs}. */
  readonly exp: number
}

/** Domain-separation label of the tunnel proof. */
export const TUNNEL_PROOF_LABEL = 'delo-relay-tunnel-v1' as const

/** Text messages of the handshake. */
export type HandshakeMessage =
  | { readonly type: 'challenge'; readonly relayId: RelayId; readonly nonce: Base64Url }
  | { readonly type: 'proof'; readonly signature: Base64Url }
  | { readonly type: 'refused'; readonly code: 'TUNNEL_ALREADY_LIVE' }
  | { readonly type: 'ready'; readonly tunnelId: Base64Url; readonly limits: typeof RELAY_LIMITS }

/** Binary frame types after `ready`. Each frame is type (1 byte), stream id (4 bytes, big-endian), payload. */
export const FRAME_TYPES = {
  OPEN: 0x01,
  DATA: 0x02,
  CREDIT: 0x03,
  CLOSE: 0x04,
  CONTROL: 0x10,
} as const

/** Bytes before the payload of every frame. */
export const FRAME_HEADER_BYTES = 5 as const

/** Payload of an `OPEN` frame. `clientAddress` is the relay's unverified assertion. */
export interface OpenPayload {
  readonly sni: string
  readonly clientAddress: string
  readonly clientPort: number
}

/** Reasons a `CLOSE` frame carries. */
export const STREAM_CLOSE_REASONS = {
  normal: 0,
  refused: 1,
  limit: 2,
  protocolError: 3,
  timeout: 4,
} as const

/** Kinds of an announcement, matching alert kinds of the device approval contract. */
export type AnnouncementKind = 'second-tunnel-refused' | 'tunnel-rebound'

/** `CONTROL` message the relay sends on stream 0 of a name's live tunnel. */
export interface Announcement {
  readonly type: 'announce'
  readonly kind: AnnouncementKind
  readonly at: number
  /** The relay's unverified assertion. */
  readonly clientAddress: string
  /** The refused token's id, so a home recognises its own reconnect attempts. */
  readonly jti?: Base64Url
}

/** Statement the old home signs to rebind its name to a new home key. */
export interface RebindStatement {
  readonly v: typeof RELAY_PROTOCOL_VERSION
  readonly name: string
  readonly previousHomeKeyId: Base64Url
  readonly newHomePublicKey: Base64Url
  readonly issuedAt: number
  /** Ed25519 signature by the previous home key. */
  readonly signature: Base64Url
}

/** WebSocket close codes of a tunnel. */
export const TUNNEL_CLOSE_CODES = {
  PROTOCOL_ERROR: 4400,
  PROOF_INVALID: 4401,
  HANDSHAKE_TIMEOUT: 4408,
  TUNNEL_ALREADY_LIVE: 4409,
  REBOUND: 4410,
  FRAME_TOO_LARGE: 4413,
} as const

/** HTTP error codes of the token and tunnel paths, with their statuses. */
export const RELAY_HTTP_ERRORS = {
  TOKEN_REQUEST_INVALID: 400,
  TOKEN_REQUEST_STALE: 401,
  NAME_NOT_BOUND: 403,
  TUNNEL_TOKEN_INVALID: 401,
  TUNNEL_TOKEN_REPLAYED: 401,
} as const

const SECOND_MS = 1000

/** Limits of the protocol. A home refuses a `ready` whose limits exceed these. */
export const RELAY_LIMITS = {
  liveTunnelsPerName: 1,
  concurrentStreamsPerHome: 64,
  /** Buffer and initial credit per stream and direction: 1 MiB. */
  streamBufferBytes: 1024 * 1024,
  dataPayloadBytes: 65_536,
  openPayloadBytes: 1024,
  controlPayloadBytes: 16_384,
  clientHelloBytes: 16_384,
  clientHelloTimeoutMs: 10 * SECOND_MS,
  handshakeTimeoutMs: 10 * SECOND_MS,
  tokenLifetimeMs: 60 * SECOND_MS,
  tokenClockSkewMs: 60 * SECOND_MS,
  rebindDelayMs: 60 * SECOND_MS,
  pingIntervalMs: 15 * SECOND_MS,
  silenceLimitMs: 45 * SECOND_MS,
  reconnectInitialMs: 1 * SECOND_MS,
  reconnectMaxMs: 60 * SECOND_MS,
  /** Random bytes of the handshake nonce. */
  challengeNonceBytes: 32,
  /** Random bytes of a token id. */
  tokenIdBytes: 16,
} as const

/** Default Certificate Transparency source; `<domain>` is the registrable domain. */
export const DEFAULT_CT_SOURCE =
  'https://api.certspotter.com/v1/issuances?domain=<domain>&include_subdomains=true&expand=dns_names' as const

/** Interval between certificate queries, in milliseconds: 30 minutes. */
export const CT_QUERY_INTERVAL_MS = 30 * 60 * SECOND_MS
