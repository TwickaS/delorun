/**
 * Listener ids, the Authenticator's admission results, the pre-login allowlist, the
 * refusal codes, the session cookie and the session limits of a home's admission, as
 * specified by `delorun/docs/contracts/c04-admission.md`. This module holds readonly
 * constants and types only.
 *
 * @module @delorun/contract-admission
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Listener ids. `loopback` is upstream's listener; every other id is a reach listener. */
export const LISTENER_IDS = [
  'loopback',
  'reach-tailscale-private',
  'reach-tailscale-funnel',
  'reach-self-hosted-relay',
] as const

/** One listener id of {@link LISTENER_IDS}. */
export type ListenerId = (typeof LISTENER_IDS)[number]

/** A reach listener id: every {@link ListenerId} except `loopback`. */
export type ReachListenerId = Exclude<ListenerId, 'loopback'>

/** Scheme a listener declares. It is the scheme the browser sees, not the socket's protocol. */
export type DeclaredScheme = 'http' | 'https'

/**
 * Id of one trusted device: the RFC 7638 SHA-256 thumbprint of its device public key,
 * base64url without padding. A device is approved for one studio address.
 */
export type DeviceId = Branded<'DeviceId'>

/** Id of one session record: the SHA-256 hash of its token, base64url without padding. Never the token. */
export type SessionId = Branded<'SessionId'>

/** A studio address as an origin, `https://<host>` or `https://<host>:<port>`, lower case. */
export type StudioAddress = Branded<'StudioAddress'>

/** The `Host` rule a listener applies before admission. */
export type HostRule =
  /** Upstream's fence: a loopback name or the bind address. */
  | { readonly kind: 'upstream-fence' }
  /** `Host` equals the address's host, with its port when it is not 443. */
  | { readonly kind: 'equals-address'; readonly address: StudioAddress }
  /** `Host` equals the bound name and the TLS connection's SNI. */
  | { readonly kind: 'equals-bound-name-and-sni'; readonly address: StudioAddress }

/** An exact method and path that a reach listener serves before sign-in. */
export interface PreLoginRoute {
  readonly method: 'GET' | 'POST'
  /** Exact path; `<…>` marks one path segment that the owning route parses. */
  readonly path: string
}

/** The policy of one listener, which the dispatcher reads when the listener starts. */
export interface ListenerPolicy {
  readonly listener: ListenerId
  readonly scheme: DeclaredScheme
  readonly hostRule: HostRule
  /** Whether upstream's launch token and `/connect` are accepted. True only for `loopback`. */
  readonly acceptsLaunchToken: boolean
  /** Routes served before sign-in. Empty for `loopback`, which keeps upstream's routes. */
  readonly preLogin: readonly PreLoginRoute[]
}

/** The pre-login routes `@delorun/home-auth` owns on every reach listener. */
export const HOME_AUTH_PRE_LOGIN_ROUTES = [
  { method: 'GET', path: '/auth/sign-in' },
  { method: 'GET', path: '/auth/assets/<asset>' },
  { method: 'POST', path: '/auth/device/request' },
  { method: 'GET', path: '/auth/device/request/<request id>' },
  { method: 'POST', path: '/auth/device/challenge' },
  { method: 'POST', path: '/auth/session' },
  { method: 'POST', path: '/auth/passkey/options' },
  { method: 'GET', path: '/auth/oidc/start' },
  { method: 'GET', path: '/auth/oidc/callback' },
  { method: 'POST', path: '/auth/recovery' },
  { method: 'POST', path: '/auth/owner/claim' },
] as const satisfies readonly PreLoginRoute[]

/** Refusal codes. Each response body is `{"error":"<code>"}`. */
export const ADMISSION_REFUSAL_CODES = [
  'HOST_MISMATCH',
  'SNI_MISMATCH',
  'ORIGIN_MISMATCH',
  'LAUNCH_TOKEN_REFUSED',
  'CONNECT_REFUSED',
  'UPSTREAM_COOKIE_REFUSED',
  'NOT_SIGNED_IN',
  'SESSION_EXPIRED',
  'ROTATION_REQUIRED',
  'OWNER_CLAIM_LOOPBACK_ONLY',
] as const

/** One refusal code of {@link ADMISSION_REFUSAL_CODES}. */
export type AdmissionRefusalCode = (typeof ADMISSION_REFUSAL_CODES)[number]

/** HTTP status of each refusal code. */
export const ADMISSION_REFUSAL_STATUS = {
  HOST_MISMATCH: 421,
  SNI_MISMATCH: 421,
  ORIGIN_MISMATCH: 403,
  LAUNCH_TOKEN_REFUSED: 401,
  CONNECT_REFUSED: 401,
  UPSTREAM_COOKIE_REFUSED: 401,
  NOT_SIGNED_IN: 401,
  SESSION_EXPIRED: 401,
  ROTATION_REQUIRED: 401,
  OWNER_CLAIM_LOOPBACK_ONLY: 403,
} as const satisfies Record<AdmissionRefusalCode, 401 | 403 | 421>

/** Load failure raised when a profile row sets a reach listener's `host` or `port`. */
export const REACH_LISTENER_HOST_OVERRIDE = 'REACH_LISTENER_HOST_OVERRIDE' as const

/**
 * Result of `Authenticator.admit`. `peer` is typed by the consumer as upstream's
 * `PeerScope`; this package names it by its type parameter to stay free of upstream imports.
 */
export type Admission<Peer> =
  | {
    readonly kind: 'admitted'
    readonly peer: Peer
    readonly deviceId: DeviceId
    readonly sessionId: SessionId
    /** A rolled or rotated cookie, as a complete `Set-Cookie` value, for the dispatcher to add. */
    readonly setCookie?: string
  }
  | { readonly kind: 'pre-login'; readonly route: PreLoginRoute }
  | {
    readonly kind: 'refused'
    readonly status: 401 | 403 | 421
    readonly code: AdmissionRefusalCode
  }

/** Event upstream's connection emits, synchronously and before the response is written, for each loopback credential it mints. */
export const LOOPBACK_MINT_EVENT = 'authenticator/minted' as const

/** A loopback credential upstream's connection minted, as {@link LOOPBACK_MINT_EVENT} carries it. It never holds the credential's value. */
export interface LoopbackCredentialMint {
  /** `browser` for the launch-token exchange's cookie, `api` for the `/connect` cookie. */
  readonly kind: 'browser' | 'api'
  /** SHA-256 of the credential value, base64url without padding: the key `@delorun/home-auth` records it under. */
  readonly hash: string
  /** The audience the credential is bound to: the request's authority, as an `https:` origin on a TLS listener. */
  readonly authority: string
  /** Issue time, in milliseconds since the epoch. */
  readonly issuedAt: number
  /** Absolute expiry, in milliseconds since the epoch. */
  readonly expiresAt: number
  /** The API Peer id an `api` credential admits. */
  readonly peer?: string
}

/** Events that rotate every session of the home. */
export const ROTATION_TRIGGERS = [
  'device-approved',
  'device-removed',
  'sign-in-factor-changed',
  'reach-provider-changed',
] as const

/** One rotation trigger of {@link ROTATION_TRIGGERS}. */
export type RotationTrigger = (typeof ROTATION_TRIGGERS)[number]

/** Name of the reach session cookie. Host-only, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`. */
export const REACH_SESSION_COOKIE = '__Host-delorun-session' as const

/** Prefix of upstream's loopback cookies, refused on every reach listener. */
export const UPSTREAM_COOKIE_PREFIX = 'dsh-auth-' as const

/** Bytes of randomness in a reach session token. */
export const SESSION_TOKEN_BYTES = 32 as const

/** Bytes of randomness in a Content Security Policy nonce, new for every page response. */
export const CSP_NONCE_BYTES = 16 as const

/**
 * The directives of every reach response's Content Security Policy, in header
 * order, joined with `; `. `<nonce>` stands for the response's nonce. No
 * directive allows `'unsafe-eval'`.
 */
export const REACH_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'nonce-<nonce>'",
  "style-src-elem 'self' 'nonce-<nonce>'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  'trusted-types default delorun-plugin-loader delorun-blob-worker',
] as const

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Session lifetimes per listener kind, in milliseconds. */
export const SESSION_LIMITS = {
  loopback: {
    /** Idle limit since last use: 7 days. */
    idleMs: 7 * DAY_MS,
    /** Absolute limit since minting: 30 days. */
    absoluteMs: 30 * DAY_MS,
  },
  reach: {
    /** Idle limit since last use: 12 hours. */
    idleMs: 12 * HOUR_MS,
    /** Absolute limit since creation: 14 days. */
    absoluteMs: 14 * DAY_MS,
    /** Use after which the next admitted request receives a new token: 24 hours. */
    rollAfterMs: 24 * HOUR_MS,
    /** Time a rolled token stays valid for requests in flight: 30 seconds. */
    rollGraceMs: 30 * 1000,
  },
  enrolment: {
    /** Absolute limit of an enrolment session, which only the identity contract's enrolment routes admit: 10 minutes. */
    absoluteMs: 10 * 60 * 1000,
  },
} as const

/** Upstream `cookieMaxAgeDays` value in Delorun's profiles, equal to the loopback absolute limit. */
export const LOOPBACK_COOKIE_MAX_AGE_DAYS = 30 as const

/** Longest time between a session store change and its persistence, in milliseconds. */
export const SESSION_STORE_PERSIST_MS = 5000 as const

/** Format version of `~/.delorun/secrets/home-auth/sessions.json`. */
export const SESSION_STORE_VERSION = 1 as const

/** Address of the loopback listener in Delorun's profiles. */
export const LOOPBACK_LISTENER_ADDRESS = { host: '127.0.0.1', port: 3080 } as const

/** Bind host of every TCP reach listener. Its port is assigned by the operating system. */
export const REACH_LISTENER_BIND_HOST = '127.0.0.1' as const

/** Names of the two Trusted Types policies a reach listener allows. */
export const TRUSTED_TYPES_POLICIES = ['default', 'delorun-plugin-loader'] as const

/** Path prefix of the client plugin bundles that the script URL allowlist admits. */
export const PLUGIN_SCRIPT_PATH_PREFIX = '/plugins/' as const
