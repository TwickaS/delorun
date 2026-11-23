/**
 * Relying-party rules per reach address, passkey options, the OpenID Connect flow and
 * its parameters, required claims, allowed algorithms, enrolment routes, error codes and
 * limits of the identity factors, as specified by
 * `delorun/docs/contracts/c14-oidc-passkeys.md`. This module holds readonly constants and
 * types only.
 *
 * @module @delorun/contract-oidc-passkeys
 */
import type { ReachOptionId } from '@delorun/contract-reach-providers'

/**
 * Identity factors. `tailnet` exists only under the reach contract's socket variant. `tailnet-membership` carries no
 * proof: it states that the request came through the serve target of a provider that declares it, and only
 * {@link TAILNET_MEMBERSHIP_OPTIONS} may.
 */
export const IDENTITY_FACTORS = ['passkey', 'oidc', 'tailnet', 'tailnet-membership'] as const

/** One factor of {@link IDENTITY_FACTORS}. */
export type IdentityFactor = (typeof IDENTITY_FACTORS)[number]

/** The reach options whose provider may declare `tailnet-membership`; every other address refuses it. */
export const TAILNET_MEMBERSHIP_OPTIONS = ['tailscale-private'] as const satisfies readonly ReachOptionId[]

/**
 * Actions the home refuses with `LOOPBACK_REQUIRED` to a session whose factor is `tailnet-membership`. Each is granted
 * only at the home's own computer: a loopback studio session or the person's own `delorun` command. `real-browser`, a
 * chat's use of the person's own browser, is the one exception: a device that holds a running unlock grants it too.
 */
export const LOOPBACK_REQUIRED_ACTIONS = [
  'full-access-escalation',
  'full-access-consent',
  'workspace-management',
  'external-agent',
  'device-approve',
  'device-remove',
  'approval-window',
  'reset',
  'recovery-kit',
  'factor-enrol',
  'reach-settings',
  'elevation-approve',
  'elevation-revoke',
  'pin-mode-change',
  'real-browser',
] as const

/** One action of {@link LOOPBACK_REQUIRED_ACTIONS}. */
export type LoopbackRequiredAction = (typeof LOOPBACK_REQUIRED_ACTIONS)[number]

/**
 * Passkey availability per reach option under the current contract. `ts.net` addresses
 * have no passkeys until a recorded spike result adopts their host as relying-party ID.
 */
export const PASSKEYS_AVAILABLE = {
  'tailscale-private': false,
  'tailscale-funnel': false,
  'self-hosted-relay': true,
} as const satisfies Record<ReachOptionId, boolean>

/** How the relying-party ID of an address is chosen where passkeys are available: its host exactly, never a parent. */
export const RELYING_PARTY_ID_RULE = 'address-host' as const

/** Relying-party name shown by authenticators. */
export const RELYING_PARTY_NAME = 'Delorun' as const

/** Path of the redirect URI of the person's provider, after `https://<address>`. */
export const OIDC_CALLBACK_PATH = '/auth/oidc/callback' as const

/** Path of the Delorun issuer's redirect URI, a fast-follow. */
export const DELORUN_CALLBACK_PATH = '/auth/oidc/callback/delorun' as const

/** Routes an enrolment session is admitted to. */
export const ENROLMENT_ROUTES = [
  { method: 'POST', path: '/auth/passkey/register/options' },
  { method: 'POST', path: '/auth/passkey/register' },
  { method: 'GET', path: '/auth/oidc/start' },
  { method: 'GET', path: '/auth/oidc/callback' },
] as const

/** COSE algorithms offered and accepted for passkeys, in preference order: EdDSA, ES256, RS256. */
export const PASSKEY_COSE_ALGORITHMS = [-8, -7, -257] as const

/** Fixed parts of the passkey registration options. */
export const PASSKEY_REGISTRATION = {
  userName: 'owner',
  residentKey: 'required',
  userVerification: 'required',
  attestation: 'none',
  timeoutMs: 300_000,
  /** Random bytes of the owner handle, fixed per home. */
  ownerHandleBytes: 32,
} as const

/** Purposes of an OpenID Connect flow. */
export const OIDC_FLOW_PURPOSES = ['enrol', 'sign-in', 'recovery', 'reauth'] as const

/** One purpose of {@link OIDC_FLOW_PURPOSES}. */
export type OidcFlowPurpose = (typeof OIDC_FLOW_PURPOSES)[number]

/** Cookie that binds a flow to the browser that started it. */
export const OIDC_FLOW_COOKIE = '__Host-delorun-oidc' as const

/** Fixed authorization request parameters. `reauth` adds {@link OIDC_REAUTH_PARAMETERS}. */
export const OIDC_AUTHORIZATION_PARAMETERS = {
  response_type: 'code',
  scope: 'openid',
  code_challenge_method: 'S256',
} as const

/** Parameters a `reauth` flow adds. */
export const OIDC_REAUTH_PARAMETERS = { prompt: 'login', max_age: '0' } as const

/** Token endpoint authentication method. */
export const OIDC_CLIENT_AUTH_METHOD = 'client_secret_basic' as const

/** Fields of an RFC 7591 dynamic registration request. */
export const OIDC_DYNAMIC_REGISTRATION = {
  client_name: 'Delorun',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'client_secret_basic',
  application_type: 'web',
} as const

/** ID token signing algorithms the home accepts. `none` and `HS*` are refused. */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const

/** Claims every ID token must carry. `reauth` also requires `auth_time`. */
export const REQUIRED_ID_TOKEN_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'] as const

/** The client registration file under `~/.delorun/secrets/home-auth/`, mode 0600. */
export const OIDC_CLIENT_FILE = 'oidc-client.json' as const

/** The pinned owner identity at the person's provider. */
export interface PinnedOwnerIdentity {
  readonly issuer: string
  readonly subject: string
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS

/**
 * Elevation, "sudo mode", an unlock in the studio's words: a device the home approved may ask, from its own studio, to
 * take for a short time the rare sensitive actions a device is refused without one (settings writes, slash commands,
 * plugin changes, terminals, the folder picker, new folders and dynamic plugin code), and the person approves it at the
 * computer by typing the code the device shows (C14, "Elevation"). One elevation lasts the minutes of the reach row it arrived on, from 1
 * to `maxMinutes`.
 */
export const ELEVATION_LIMITS = {
  /** The reach row's minutes when it names none. */
  defaultMinutes: 15,
  /** The most minutes a reach row may set; a larger value is refused where the row is read. */
  maxMinutes: 60,
  /** How long a request waits for the person at the computer. */
  requestLifetimeMs: 5 * MINUTE_MS,
  /** How many requests one home holds at once. */
  pendingPerHome: 5,
  /** How many wrong codes one request takes; the last cancels it. */
  wrongCodesPerRequest: 3,
  /** Random bytes of a request id and of an elevation id. */
  idBytes: 16,
} as const

/**
 * Why an elevation ended, which the home logs with it:
 * - `expired`: its minutes ran out.
 * - `revoked-at-computer`: the person ended it at the computer.
 * - `locked-from-device`: the person locked it from the device's own studio.
 * - `replaced`: the person approved a new request from the same device on the same listener.
 * - `session-ended`: the session that asked ended, by its limits, a sign-out or a rotation.
 * - `device-removed`: the device was removed.
 * - `listener-stopped`: remote access stopped serving the listener.
 * - `home-stopped`: the Host stopped.
 * - `grace-ended`: the device finished its first-run setup, which ends the unlock a new device starts with.
 */
export const ELEVATION_END_REASONS = [
  'expired',
  'revoked-at-computer',
  'locked-from-device',
  'replaced',
  'session-ended',
  'device-removed',
  'listener-stopped',
  'home-stopped',
  'pin-changed',
  'pin-mode-off',
  'token-refused',
  'grace-ended',
] as const

/** One reason of {@link ELEVATION_END_REASONS}. */
export type ElevationEndReason = (typeof ELEVATION_END_REASONS)[number]

/**
 * What a device's own studio shows about elevation: nothing, a request waiting with the code to read out at the
 * computer, or an elevation and its end, in milliseconds since the epoch. `unlockMinutes` is how long an unlock on
 * the device's listener lasts once the computer approves one: a setting, not a secret, so it shows before any unlock.
 * An `elevated` state with `reason: 'approval-grace'` is the unlock a newly approved device starts with on its first sign-in.
 * A home that predates the field omits it.
 */
export type ElevationState =
  | { readonly kind: 'none'; readonly unlockMinutes?: number }
  | { readonly kind: 'pending'; readonly requestId: string; readonly code: string; readonly expiresAt: number; readonly unlockMinutes?: number }
  | { readonly kind: 'elevated'; readonly elevationId: string; readonly endsAt: number; readonly reason?: 'approval-grace' }

/** Limits of this contract. */
export const IDENTITY_LIMITS = {
  /** Random bytes of `state`, `nonce` and `code_verifier`. */
  flowRandomBytes: 32,
  flowLifetimeMs: 10 * MINUTE_MS,
  pendingFlowsPerHome: 20,
  ticketBytes: 32,
  ticketLifetimeMs: 60 * SECOND_MS,
  passkeyChallengeBytes: 32,
  passkeyChallengeLifetimeMs: 5 * MINUTE_MS,
  enrolmentSessionMs: 10 * MINUTE_MS,
  idTokenClockSkewMs: 60 * SECOND_MS,
  idTokenMaxAgeMs: 10 * MINUTE_MS,
  reauthMaxAgeMs: 120 * SECOND_MS,
  /** Size limit of the key set and of the metadata document. */
  documentBytes: 65_536,
  fetchTimeoutMs: 10 * SECOND_MS,
  refreshIntervalMs: 24 * 60 * MINUTE_MS,
  unknownKidRefreshIntervalMs: 5 * MINUTE_MS,
  /** Delorun issuer, a fast-follow: a key is published this long before first use and kept this long after last use. */
  delorunKeyOverlapMs: 24 * 60 * MINUTE_MS,
} as const

/** Error codes. */
export const IDENTITY_ERROR_CODES = [
  'OIDC_DISCOVERY_FAILED',
  'OIDC_PKCE_UNSUPPORTED',
  'OIDC_ALGORITHM_UNSUPPORTED',
  'OIDC_STATE_INVALID',
  'OIDC_ISSUER_MISMATCH',
  'OIDC_AUDIENCE_MISMATCH',
  'OIDC_NONCE_MISMATCH',
  'OIDC_TOKEN_EXPIRED',
  'OIDC_UNKNOWN_KEY',
  'OIDC_SIGNATURE_INVALID',
  'OIDC_SUBJECT_MISMATCH',
  'OIDC_REAUTH_TOO_OLD',
  'OIDC_PROVIDER_ERROR',
  'PASSKEY_UNAVAILABLE',
  'PASSKEY_ASSERTION_INVALID',
  'PASSKEY_USER_VERIFICATION_REQUIRED',
  'PASSKEY_COUNTER_REGRESSED',
  'TAILNET_IDENTITY_UNAVAILABLE',
  'LOOPBACK_REQUIRED',
  'PIN_INVALID',
  'PIN_WEAK',
  'PIN_MODE_OFF',
  'PIN_NOT_ALLOWED_ON_ADDRESS',
  'PIN_UNLOCKS_PAUSED',
  'UNLOCK_INVALID',
] as const

/** One code of {@link IDENTITY_ERROR_CODES}. */
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number]

/** Evidence a spike report records before passkeys become available on `ts.net` addresses. */
export interface TsNetRelyingPartySpikeEvidence {
  readonly publicSuffixListed: boolean
  readonly publicSuffixListVersion: string
  readonly privateAddressRelyingPartyId: string
  readonly funnelAddressRelyingPartyId: string
  readonly browsers: readonly {
    readonly browser: 'Chromium' | 'Firefox' | 'Safari'
    readonly version: string
    readonly os: string
    readonly authenticator: 'platform' | 'security-key'
    readonly registers: boolean
    readonly asserts: boolean
  }[]
  /** Whether a passkey registered on the private origin asserts on the Funnel origin of the same machine. */
  readonly crossOriginSameHostAsserts: boolean
}

/**
 * PIN mode (C14, "PIN mode"): the rules for the secret and the limits that keep a stolen device from guessing it.
 * Every value is a security invariant except `defaultIdleMinutes`, which the person sets between 1 and `maxIdleMinutes`.
 */
export const PIN_MODE_LIMITS = {
  /** The fewest digits of a PIN. */
  minPinDigits: 6,
  /** The fewest characters of a passcode, which is any secret that is not all digits. */
  minPasscodeChars: 10,
  /** The most characters of either, after NFC normalisation. */
  maxSecretChars: 128,
  /** Wrong tries one device may make before the home removes it. */
  deviceWrongTries: 5,
  /** Wrong tries across the home within `homeWindowMs` that pause PIN unlocks until the computer resumes them. */
  homeWrongTries: 10,
  /** The window the home-wide count covers: 24 hours. */
  homeWindowMs: 24 * 60 * MINUTE_MS,
  /** The idle minutes of an unlock when the person sets none. */
  defaultIdleMinutes: 15,
  /** The most idle minutes the person may set. */
  maxIdleMinutes: 60,
  /** The longest an unlock lasts however active the page is: 12 hours. */
  absoluteCapMs: 12 * 60 * MINUTE_MS,
  /** Random bytes of a page-unlock token. */
  tokenBytes: 32,
  /** Random bytes of an unlock id. */
  idBytes: 16,
  /** The most scrypt derivations running at once. */
  concurrentHashes: 2,
  /** scrypt parameters a new PIN is hashed with; the record stores the parameters it used. */
  scrypt: { N: 131072, r: 8, p: 1, keyBytes: 32, saltBytes: 16, maxmemBytes: 256 * 1024 * 1024 },
} as const

/** What kind of secret the person set: all digits is a `pin`, anything else a `passcode`. */
export type PinKind = 'pin' | 'passcode'

/** What a device's own studio learns of PIN mode without unlocking: whether it is on and what it takes. */
export type PinModeState =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly secret: PinKind; readonly idleMinutes: number; readonly lockWhenHidden: boolean; readonly paused: boolean; readonly unlock: { readonly unlockId: string; readonly endsAt: number; readonly idleEndsAt: number } | null }
