/**
 * The typed failure every home-auth check raises: contract C5's error code, the HTTP status the route answers with,
 * and the sentence a person reads.
 *
 * A refusal is a value of a contract's code set, so a caller can branch on it without reading a message. This package's
 * own codes cover what no contract names: `BAD_REQUEST` for a malformed message or a wrong method, `STORE_INVALID` for a
 * store file that cannot be read as this package's JSON, and the two resource limits of a home's own records,
 * `DEVICE_LIMIT_REACHED` and `SESSION_LIMIT_REACHED`, which are answered with `429` as C5's limits are, and
 * `CHALLENGE_RATE_LIMITED` for a source or device that asks for sign-in challenges faster than the configured rate, and
 * `ELEVATION_REQUIRED` for a locked device that calls a route needing an unlock.
 *
 * @module @delorun/home-auth/errors
 */
import { ADMISSION_REFUSAL_CODES, ADMISSION_REFUSAL_STATUS, type AdmissionRefusalCode } from '@delorun/contract-admission'
import type { DeviceApprovalErrorCode } from '@delorun/contract-device-approval'
import type { IdentityErrorCode } from '@delorun/contract-oidc-passkeys'

/** Codes this package answers with that neither contract names. */
export const HOME_AUTH_LOCAL_CODES = [
  'BAD_REQUEST',
  'METHOD_NOT_ALLOWED',
  'STORE_INVALID',
  'DEVICE_LIMIT_REACHED',
  'SESSION_LIMIT_REACHED',
  'CHALLENGE_RATE_LIMITED',
  'ELEVATION_REQUIRED',
] as const

/** One code of {@link HOME_AUTH_LOCAL_CODES}. */
export type HomeAuthLocalCode = (typeof HOME_AUTH_LOCAL_CODES)[number]

/** Every code a home-auth refusal carries. */
export type HomeAuthErrorCode =
  | DeviceApprovalErrorCode
  | AdmissionRefusalCode
  | HomeAuthLocalCode
  | Extract<IdentityErrorCode, 'TAILNET_IDENTITY_UNAVAILABLE' | 'LOOPBACK_REQUIRED' | 'PIN_INVALID' | 'PIN_WEAK' | 'PIN_MODE_OFF' | 'PIN_NOT_ALLOWED_ON_ADDRESS' | 'PIN_UNLOCKS_PAUSED' | 'UNLOCK_INVALID' | 'PASSKEY_UNAVAILABLE' | 'PASSKEY_ASSERTION_INVALID' | 'PASSKEY_USER_VERIFICATION_REQUIRED' | 'PASSKEY_COUNTER_REGRESSED'>

/**
 * The HTTP status of each code this package answers over HTTP. C5's table gives the first group, C4's refusal table the
 * four arrival and claim refusals, and this package's own codes the rest. Codes C5 reserves for the command line and the
 * desktop app are absent because no route raises them. C14 gives `TAILNET_IDENTITY_UNAVAILABLE` and `LOOPBACK_REQUIRED`.
 */
export const HOME_AUTH_HTTP_STATUS = {
  NO_OWNER: 403,
  ALREADY_OWNED: 409,
  OWNER_CODE_INVALID: 403,
  OWNER_CLAIM_RATE_LIMITED: 429,
  APPROVAL_PENDING_LIMIT: 429,
  APPROVAL_RATE_LIMITED: 429,
  APPROVAL_EXPIRED: 410,
  APPROVAL_NOT_IN_SESSION: 401,
  APPROVAL_SIGNATURE_INVALID: 403,
  APPROVAL_USER_VERIFICATION_REQUIRED: 403,
  APPROVAL_CODE_MISMATCH: 403,
  DEVICE_NOT_TRUSTED: 401,
  CHALLENGE_INVALID: 401,
  RECOVERY_NEEDS_FACTOR: 403,
  RECOVERY_KIT_INVALID: 403,
  APPROVALS_CLOSED: 403,
  TAILNET_IDENTITY_UNAVAILABLE: 403,
  LOOPBACK_REQUIRED: 403,
  PIN_INVALID: 403,
  PIN_WEAK: 400,
  PIN_MODE_OFF: 409,
  PIN_NOT_ALLOWED_ON_ADDRESS: 403,
  PIN_UNLOCKS_PAUSED: 429,
  UNLOCK_INVALID: 401,
  PASSKEY_UNAVAILABLE: 404,
  PASSKEY_ASSERTION_INVALID: 403,
  PASSKEY_USER_VERIFICATION_REQUIRED: 403,
  PASSKEY_COUNTER_REGRESSED: 403,
  NOT_SIGNED_IN: ADMISSION_REFUSAL_STATUS.NOT_SIGNED_IN,
  SESSION_EXPIRED: ADMISSION_REFUSAL_STATUS.SESSION_EXPIRED,
  ROTATION_REQUIRED: ADMISSION_REFUSAL_STATUS.ROTATION_REQUIRED,
  OWNER_CLAIM_LOOPBACK_ONLY: ADMISSION_REFUSAL_STATUS.OWNER_CLAIM_LOOPBACK_ONLY,
  HOST_MISMATCH: ADMISSION_REFUSAL_STATUS.HOST_MISMATCH,
  ORIGIN_MISMATCH: ADMISSION_REFUSAL_STATUS.ORIGIN_MISMATCH,
  BAD_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  STORE_INVALID: 500,
  DEVICE_LIMIT_REACHED: 429,
  SESSION_LIMIT_REACHED: 429,
  CHALLENGE_RATE_LIMITED: 429,
  ELEVATION_REQUIRED: 403,
} as const satisfies Partial<Record<HomeAuthErrorCode, number>>

/** {@link HOME_AUTH_HTTP_STATUS} as a lookup over every code, so a code with no status reads as `undefined`. */
const STATUS_OF: Partial<Record<HomeAuthErrorCode, number>> = HOME_AUTH_HTTP_STATUS

/** A refusal or failure of the home's sign-in. */
export class HomeAuthError extends Error {
  /** The contract code, or this package's own code for a malformed message. */
  readonly code: HomeAuthErrorCode
  /** The fields the refusal is about, such as the device id that is not trusted; they never hold a secret. */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - the contract code, or this package's own code for a malformed message.
   * @param message - the sentence a person reads, in sentence case, naming no secret and no path.
   * @param details - the fields the refusal is about, such as the device id that is not trusted; they never hold a secret.
   */
  constructor(
    code: HomeAuthErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`)
    this.code = code
    this.details = details
    this.detail = message
    this.name = 'HomeAuthError'
  }

  /** The sentence without the code's prefix, which is what a refusal body carries. */
  readonly detail: string

  /** The HTTP status a route answers this refusal with. */
  get status(): number {
    return STATUS_OF[this.code] ?? 500
  }
}

/**
 * The body a refusal answers with: the code a caller branches on and the sentence a person reads.
 * @param code - the refusal code.
 * @param message - the sentence.
 * @param fields - structured fields that sit beside the code and the sentence; never a secret.
 * @returns the JSON body text.
 */
export function refusalBody(code: HomeAuthErrorCode, message: string, fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ error: code, message, ...fields })
}

/** The codes whose `details` are answered as structured fields: the PIN refusals a client reads without parsing the sentence. */
export const STRUCTURED_REFUSALS: ReadonlySet<HomeAuthErrorCode> = new Set<HomeAuthErrorCode>(['PIN_INVALID', 'PIN_UNLOCKS_PAUSED', 'PASSKEY_ASSERTION_INVALID'])

/** Compile-time: the two refusals C4 adds to this package's answers are mapped, so a route never answers an unmapped code. */
export const CLAIM_REFUSAL_STATUS = {
  OWNER_CLAIM_LOOPBACK_ONLY: ADMISSION_REFUSAL_STATUS.OWNER_CLAIM_LOOPBACK_ONLY,
} as const satisfies Partial<Record<AdmissionRefusalCode, number>>

/** C4's refusal codes, re-exported so a caller of this package branches on one set. */
export { ADMISSION_REFUSAL_CODES }
