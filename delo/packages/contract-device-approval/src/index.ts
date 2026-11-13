/**
 * Key types, owner claim, approval request and approval messages, the match code,
 * sign-in, the recovery kit, the desktop app's TLS key statement, alert kinds, error
 * codes and limits of device approval, as specified by
 * `delo/docs/contracts/c05-device-approval.md`. Every byte string is base64url without
 * padding, and every signed object is signed over its RFC 8785 serialisation without its
 * signature fields. This module holds readonly constants and types only.
 *
 * @module @delo/contract-device-approval
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delo/contract-admission'

/** Version of every message and stored file of this contract. */
export const DEVICE_APPROVAL_VERSION = 1 as const

/** Base64url text without padding. */
export type Base64Url = Branded<'Base64Url'>

/** SHA-256 of the 32-byte raw Ed25519 home public key, base64url. Not secret. */
export type HomeKeyId = Branded<'HomeKeyId'>

/** Id of one approval request: 16 random bytes, base64url. */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/** Algorithms of each key. */
export const KEY_ALGORITHMS = {
  /** The home key. */
  home: 'Ed25519',
  /** Browser and desktop device keys: ECDSA P-256 with SHA-256, non-extractable in browsers. */
  device: 'ECDSA-P256-SHA256',
  /** COSE algorithm ids accepted for passkeys: ES256, EdDSA and RS256. */
  passkeyCose: [-7, -8, -257],
} as const

/** Files under `~/.delo/secrets/home-auth/`, each mode 0600. */
export const HOME_AUTH_FILES = {
  homeKey: 'home-key.pem',
  owner: 'owner.json',
  devices: 'devices.json',
  passkeys: 'passkeys.json',
  ownerCode: 'owner-code.json',
  recovery: 'recovery.json',
  /** Whether a device opens a terminal without an unlock everywhere (C14, "Elevation"). */
  reachTerminal: 'reach-terminal.json',
} as const

/** IndexedDB database and store that hold a browser device key on its origin. */
export const BROWSER_DEVICE_KEY_STORE = { database: 'delo-device', store: 'keys' } as const

/** Device public key as a JWK. */
export interface DevicePublicKeyJwk {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: Base64Url
  readonly y: Base64Url
}

/** Body of `POST /auth/owner/claim` on the loopback listener. */
export interface OwnerClaim {
  readonly v: typeof DEVICE_APPROVAL_VERSION
  /** 26 characters of `A`–`Z` and `2`–`7`; case and spaces or hyphens are ignored on input. */
  readonly ownerCode: string
  readonly devicePublicKey: DevicePublicKeyJwk
  readonly label: string
}

/** Body of `POST /auth/device/request`. */
export interface ApprovalRequest {
  readonly v: typeof DEVICE_APPROVAL_VERSION
  readonly devicePublicKey: DevicePublicKeyJwk
  /** 16 random bytes. */
  readonly deviceNonce: Base64Url
  readonly label: string
  readonly platform: string
}

/** The home's `201` answer to an {@link ApprovalRequest}. */
export interface ApprovalRequestAccepted {
  readonly requestId: ApprovalRequestId
  /** 16 random bytes, presented as `Authorization: Delo-Request <secret>` to read the state. */
  readonly requestSecret: Base64Url
  /** 32-byte raw Ed25519 home public key. */
  readonly homePublicKey: Base64Url
  /** 16 random bytes. */
  readonly homeNonce: Base64Url
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/** States of an approval request. */
export const APPROVAL_REQUEST_STATES = ['pending', 'approved', 'cancelled', 'recovery-pending', 'expired'] as const

/** One state of {@link APPROVAL_REQUEST_STATES}. */
export type ApprovalRequestState = (typeof APPROVAL_REQUEST_STATES)[number]

/** Domain-separation label of the match code hash. */
export const MATCH_CODE_LABEL = 'delo-match-v1' as const

/** Decimal digits in a match code, shown as two groups of 4. */
export const MATCH_CODE_DIGITS = 8 as const

/** WebAuthn assertion fields carried by an approval or a session request. */
export interface WebAuthnAssertion {
  readonly credentialId: Base64Url
  readonly authenticatorData: Base64Url
  readonly clientDataJSON: Base64Url
  readonly signature: Base64Url
}

/** Body of `POST /auth/device/approve`, sent in the approving device's live session. */
export interface Approval {
  readonly v: typeof DEVICE_APPROVAL_VERSION
  readonly requestId: ApprovalRequestId
  readonly homeNonce: Base64Url
  readonly homeKeyId: HomeKeyId
  readonly deviceId: DeviceId
  readonly address: StudioAddress
  /** The 8 digits the person typed from the new device's screen. */
  readonly typedCode: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly approverDeviceId: DeviceId
  /** ECDSA P-256 signature by the approving device key. */
  readonly signature: Base64Url
  /** On a reach address with passkeys; its challenge is the approval hash. */
  readonly webauthn?: WebAuthnAssertion
  /** On a reach address without passkeys: an ID token whose `nonce` is the approval hash. */
  readonly oidcReauth?: string
}

/** The approver a local approval records: the person's own `delorun devices approve` or the loopback studio. */
export const LOCAL_APPROVER = 'local' as const

/**
 * The local approval form: approval at the home's own computer, through the home socket's `devices.approve` or the
 * loopback studio. It carries no session and no signature; the home socket's caller rule and the loopback arrival stand
 * in for them.
 */
export interface LocalApproval {
  readonly requestId: ApprovalRequestId
  /** The 8 digits the person typed from the new device's screen. */
  readonly typedCode: string
}

/** Domain-separation label of a sign-in signature. */
export const SIGN_IN_LABEL = 'delo-signin-v1' as const

/** Identity-factor proof carried by `POST /auth/session` when it creates a session. */
export type IdentityFactorProof =
  | { readonly kind: 'passkey'; readonly assertion: WebAuthnAssertion }
  | { readonly kind: 'oidc'; readonly ticket: Base64Url }
  | { readonly kind: 'tailnet' }

/** Body of `POST /auth/session`: creation carries `factor`, rotation carries `rotate`. */
export interface SessionRequest {
  readonly deviceId: DeviceId
  /** 32 bytes from `POST /auth/device/challenge`. */
  readonly challenge: Base64Url
  readonly signature: Base64Url
  readonly factor?: IdentityFactorProof
  /** The session token being rotated. */
  readonly rotate?: string
}

/** Prefix of a written recovery kit, followed by 52 base32 characters. */
export const RECOVERY_KIT_PREFIX = 'DELO-RK1-' as const

/** The desktop app's TLS key statement, signed by the home key. */
export interface TlsKeyStatement {
  readonly v: typeof DEVICE_APPROVAL_VERSION
  readonly address: StudioAddress
  /** SHA-256 of the leaf certificate's SubjectPublicKeyInfo. */
  readonly spkiSha256: Base64Url
  readonly issuedAt: number
  /** Ed25519 signature by the home key. */
  readonly signature: Base64Url
}

/** Alert kinds. */
export const ALERT_KINDS = [
  'unrequested-certificate',
  'second-tunnel-refused',
  'tunnel-rebound',
  'device-approved',
  'device-removed',
  'recovery-started',
  'recovery-cancelled',
  'recovery-completed',
  'reset',
] as const

/** One kind of {@link ALERT_KINDS}. */
export type AlertKind = (typeof ALERT_KINDS)[number]

/** Alert kinds shown as blocking; every other kind is a notice. */
export const BLOCKING_ALERT_KINDS = ['unrequested-certificate', 'second-tunnel-refused', 'recovery-started'] as const

/** Severity of an alert. */
export type AlertSeverity = 'blocking' | 'notice'

/** One alert file, `~/.delo/alerts/<id>.json`, mode 0600. It holds no secret. */
export interface AlertFile {
  readonly v: typeof DEVICE_APPROVAL_VERSION
  /** 16 random bytes as 32 lowercase hexadecimal digits. */
  readonly id: string
  readonly kind: AlertKind
  readonly severity: AlertSeverity
  readonly raisedAt: number
  readonly homeKeyId: HomeKeyId
  /** Details of the kind. A reader shows an unknown kind as blocking with this raw value. */
  readonly subject: Readonly<Record<string, unknown>>
  /** Ed25519 signature by the home key. */
  readonly signature: Base64Url
}

/** The secret file that holds the alert webhook URL. */
export const ALERT_WEBHOOK_URL_FILE = '~/.delo/secrets/alerts/webhook-url' as const

/** Header carrying the alert signature on a webhook delivery. */
export const ALERT_SIGNATURE_HEADER = 'Delo-Alert-Signature' as const

/** Environment variables an alert command receives, besides `PATH` and `HOME`. */
export const ALERT_COMMAND_ENV = ['DELO_ALERT_ID', 'DELO_ALERT_KIND'] as const

const MINUTE_MS = 60 * 1000

/** Limits of this contract. */
export const DEVICE_APPROVAL_LIMITS = {
  /** Random bytes of an owner code: 128 bits. */
  ownerCodeBytes: 16,
  /** Base32 characters of an owner code. */
  ownerCodeChars: 26,
  ownerCodeExpiryMs: 10 * MINUTE_MS,
  ownerClaimAttemptsPerMinutePerSource: 10,
  approvalRequestExpiryMs: 5 * MINUTE_MS,
  /**
   * How long an approval window stays open on a route whose identity factor is `tailnet-membership`; it closes at the
   * first approval. Outside a window a request is refused with `APPROVALS_CLOSED`.
   */
  approvalWindowMs: 5 * MINUTE_MS,
  pendingRequestsPerHome: 5,
  approvalRequestsPerMinutePerSource: 10,
  requestStateReadIntervalMs: 2000,
  wrongTypedCodesPerRequest: 3,
  approvalClockSkewMs: MINUTE_MS,
  reauthenticationMaxAgeMs: 2 * MINUTE_MS,
  nonceBytes: 16,
  challengeBytes: 32,
  challengeExpiryMs: MINUTE_MS,
  unusedChallengesPerDevice: 5,
  /** Random bytes of a recovery kit: 256 bits. */
  recoveryKitBytes: 32,
  recoveryCancelDelayMs: 72 * 60 * MINUTE_MS,
  labelMaxChars: 64,
  platformMaxChars: 64,
  alertCommandTimeoutMs: 30 * 1000,
  webhookTimeoutMs: 10 * 1000,
  /** Delays before each of the 3 webhook retries. */
  webhookRetryDelaysMs: [1 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS],
} as const

/** Error codes. */
export const DEVICE_APPROVAL_ERROR_CODES = [
  'NO_OWNER',
  'ALREADY_OWNED',
  'OWNER_CODE_INVALID',
  'OWNER_CLAIM_RATE_LIMITED',
  'APPROVAL_PENDING_LIMIT',
  'APPROVAL_RATE_LIMITED',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_IN_SESSION',
  'APPROVAL_SIGNATURE_INVALID',
  'APPROVAL_USER_VERIFICATION_REQUIRED',
  'APPROVAL_CODE_MISMATCH',
  'DEVICE_NOT_TRUSTED',
  'CHALLENGE_INVALID',
  'RECOVERY_NEEDS_FACTOR',
  'RECOVERY_KIT_INVALID',
  'HOME_RUNNING',
  'TLS_PIN_MISMATCH',
  'HOME_KEY_MISMATCH',
  'APPROVALS_CLOSED',
] as const

/** One code of {@link DEVICE_APPROVAL_ERROR_CODES}. */
export type DeviceApprovalErrorCode = (typeof DEVICE_APPROVAL_ERROR_CODES)[number]
