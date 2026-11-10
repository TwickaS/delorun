/**
 * The records `~/.delo/secrets/home-auth/` holds for a home's owner and its trusted devices, the message fields a claim
 * carries, and the derivation of a device id, as contract C5 specifies them.
 *
 * A device id is the RFC 7638 thumbprint of its public key: the SHA-256 digest of the key's required members in
 * lexicographic order, base64url without padding. A record holds no secret — the credential that proves a device's
 * session is kept as a digest in the session store, never here.
 *
 * @module @delo/home-auth/records
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delo/contract-admission'
import { DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION, LOCAL_APPROVER, type Base64Url, type DevicePublicKeyJwk } from '@delo/contract-device-approval'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime } from './files.ts'
import { hashSecret } from './secret.ts'

/** A 32-byte value written as base64url without padding: 43 characters. */
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/

/** The owner record: `~/.delo/secrets/home-auth/owner.json`, mode 0600. */
export interface OwnerRecord {
  /** The format version, C5's `v`. */
  readonly v: typeof DEVICE_APPROVAL_VERSION
  /** When the home was claimed, in milliseconds since the epoch. */
  readonly claimedAt: number
  /**
   * The device that claimed the home, or `local` for C5's local claim: the person at the home's own computer opening the
   * first approval window, with no device of the studio's.
   */
  readonly firstDeviceId: DeviceId | typeof LOCAL_APPROVER
  /** The owner's pinned identity factors ([C14](../../../docs/contracts/c14-oidc-passkeys.md#owner-subject)); empty until one is enrolled. */
  readonly identities: readonly string[]
}

/** One trusted device's record in `~/.delo/secrets/home-auth/devices.json`, mode 0600. */
export interface DeviceRecord {
  /** The format version, C5's `v`. */
  readonly v: typeof DEVICE_APPROVAL_VERSION
  /** The RFC 7638 thumbprint of {@link publicKey}. */
  readonly id: DeviceId
  /** The device public key, as the device sent it. */
  readonly publicKey: DevicePublicKeyJwk
  /** The studio address the device is bound to; a key approved for one address is refused on another. */
  readonly address: StudioAddress
  /** The name the person gave the device, 1 to 64 characters. */
  readonly label: string
  /** The browser and operating system the page read, at most 64 characters; empty for a claim. */
  readonly platform: string
  /** When the device became trusted, in milliseconds since the epoch. */
  readonly approvedAt: number
  /**
   * The device that approved it; `local` for an approval at the home's own computer (C5's local approval); null for the
   * device that claimed the home.
   */
  readonly approvedBy: DeviceId | typeof LOCAL_APPROVER | null
  /** When it last signed in, or null before its first sign-in. */
  readonly lastSignInAt: number | null
}

/**
 * The RFC 7638 thumbprint of a device public key, which is the device's id.
 * @param publicKey - the key, with its required members already validated.
 * @returns the thumbprint as base64url without padding.
 */
export function deviceIdOf(publicKey: DevicePublicKeyJwk): DeviceId {
  // Both values are base64url, so they need no JSON escaping: the canonical form is this exact text.
  const canonical = `{"crv":"${publicKey.crv}","kty":"${publicKey.kty}","x":"${publicKey.x}","y":"${publicKey.y}"}`
  return brandString<DeviceId>(hashSecret(canonical))
}

/**
 * Validate a device public key as C5 carries it: a JWK of `kty` `EC`, `crv` `P-256`, with 32-byte coordinates.
 * @param value - the value from a message or a record.
 * @param code - the refusal code to raise; `BAD_REQUEST` for a message, `STORE_INVALID` for a file.
 * @returns the key.
 * @throws {HomeAuthError} the given code when the value is not such a key.
 */
export function devicePublicKeyOf(value: unknown, code: 'BAD_REQUEST' | 'STORE_INVALID'): DevicePublicKeyJwk {
  if (!isRecord(value) || value.kty !== 'EC' || value.crv !== 'P-256') {
    throw new HomeAuthError(code, 'a device public key is an EC P-256 JWK')
  }
  const { x, y } = value
  if (typeof x !== 'string' || typeof y !== 'string' || !BASE64URL_32.test(x) || !BASE64URL_32.test(y)) {
    throw new HomeAuthError(code, 'a device public key carries 32-byte x and y coordinates as base64url')
  }
  return { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(x), y: brandString<Base64Url>(y) }
}

/**
 * Read an owner record file's value.
 * @param value - the parsed file, or undefined when the file does not exist.
 * @returns the record, or undefined for a home with no owner.
 * @throws {HomeAuthError} `STORE_INVALID` when the file holds anything but a version 1 owner record.
 */
export function ownerRecordOf(value: unknown): OwnerRecord | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.v !== DEVICE_APPROVAL_VERSION) {
    throw new HomeAuthError('STORE_INVALID', 'owner.json is not a version 1 owner record')
  }
  if (!isTime(value.claimedAt)) throw new HomeAuthError('STORE_INVALID', 'owner.json has no claim time')
  const { firstDeviceId, identities } = value
  if (typeof firstDeviceId !== 'string' || firstDeviceId === '') {
    throw new HomeAuthError('STORE_INVALID', 'owner.json names no first device')
  }
  if (!Array.isArray(identities) || identities.some(identity => typeof identity !== 'string')) {
    throw new HomeAuthError('STORE_INVALID', 'owner.json holds no list of pinned identities')
  }
  return {
    v: DEVICE_APPROVAL_VERSION,
    claimedAt: value.claimedAt,
    firstDeviceId: firstDeviceId === LOCAL_APPROVER ? LOCAL_APPROVER : brandString<DeviceId>(firstDeviceId),
    identities,
  }
}

/**
 * Read a devices record file's value.
 * @param value - the parsed file, or undefined when the file does not exist.
 * @returns the records, in file order; empty for a home with no devices.
 * @throws {HomeAuthError} `STORE_INVALID` when the file holds anything but version 1 device records.
 */
export function deviceRecordsOf(value: unknown): readonly DeviceRecord[] {
  if (value === undefined) return []
  if (!isRecord(value) || value.v !== DEVICE_APPROVAL_VERSION || !Array.isArray(value.devices)) {
    throw new HomeAuthError('STORE_INVALID', 'devices.json is not a version 1 device list')
  }
  return value.devices.map((entry: unknown) => deviceRecordOf(entry))
}

/**
 * Read one device record.
 * @param value - the value from a devices file.
 * @returns the record.
 * @throws {HomeAuthError} `STORE_INVALID` when the value is not a version 1 device record.
 */
function deviceRecordOf(value: unknown): DeviceRecord {
  if (!isRecord(value) || value.v !== DEVICE_APPROVAL_VERSION) {
    throw new HomeAuthError('STORE_INVALID', 'devices.json holds an entry that is not a version 1 device record')
  }
  const { id, address, label, platform, approvedAt, approvedBy, lastSignInAt } = value
  if (typeof id !== 'string' || id === '') throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device with no id')
  if (typeof address !== 'string' || address === '') throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device with no address')
  if (typeof label !== 'string' || label === '') throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device with no label')
  if (typeof platform !== 'string') throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device with no platform')
  if (!isTime(approvedAt)) throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device with no approval time')
  if (approvedBy !== null && (typeof approvedBy !== 'string' || approvedBy === '')) {
    throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device whose approving device is neither an id nor null')
  }
  if (lastSignInAt !== null && !isTime(lastSignInAt)) {
    throw new HomeAuthError('STORE_INVALID', 'devices.json holds a device whose last sign-in is neither a time nor null')
  }
  return {
    v: DEVICE_APPROVAL_VERSION,
    id: brandString<DeviceId>(id),
    publicKey: devicePublicKeyOf(value.publicKey, 'STORE_INVALID'),
    address: brandString<StudioAddress>(address),
    label,
    platform,
    approvedAt,
    approvedBy: approvedBy === null ? null : approvedBy === LOCAL_APPROVER ? LOCAL_APPROVER : brandString<DeviceId>(approvedBy),
    lastSignInAt,
  }
}

/**
 * Read a claim or approval request's label: 1 to 64 characters after trimming, which is C5's limit.
 * @param value - the label from the message.
 * @returns the label.
 * @throws {HomeAuthError} `BAD_REQUEST` when the label is missing, blank or longer than the limit.
 */
export function claimLabelOf(value: unknown): string {
  if (typeof value !== 'string') throw new HomeAuthError('BAD_REQUEST', 'a device carries its label')
  const label = value.trim()
  if (label === '' || label.length > DEVICE_APPROVAL_LIMITS.labelMaxChars) {
    throw new HomeAuthError('BAD_REQUEST', `a device label is 1 to ${String(DEVICE_APPROVAL_LIMITS.labelMaxChars)} characters`)
  }
  return label
}
