/**
 * The log-entry key types of contract C18 and the rule that names the key a release's log entry must verify with.
 *
 * A root that carries `logEntryKeys` lists each key trusted to sign log entries with the entry key type it signs under
 * (contract C2). An entry verifies only when its `keyDetails` is a type this client implements, the root lists a key of
 * that type whose DER public key is byte for byte the entry's, that key is valid for the release (`active`, or
 * `retired` at or above the release's version), the entry's digest is the type's digest of the signed file, and the
 * signature verifies with the listed key. The log accepting an entry proves none of these. A root without the list
 * trusts no log entry, so no release verifies under it; the field is optional only so that a root chain can still walk
 * through `1.root.json`, which predates it.
 *
 * The trusted logs follow the same rule: a root's `logs` lists every log whose checkpoints verify a bundle, `log` among
 * them, and a root without it trusts no log.
 *
 * @module @delorun/release-formats/log/entry-keys
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { LOG_ENTRY_KEY_TYPES, type LogEntryDigestAlgorithm, type LogEntryKeyDetails } from '@delorun/contract-release-log'
import type { ListedLog, LogEntryKey, RootMetadata } from '@delorun/contract-release-manifest'
import { ed25519ph } from '@noble/curves/ed25519.js'
import semver from 'semver'

/**
 * Whether an entry key type is one this client implements.
 * @param value - a `keyDetails` value.
 * @returns `true` for `PKIX_ED25519_PH` and `PKIX_ECDSA_P256_SHA_256`.
 */
export function isLogEntryKeyDetails(value: string): value is LogEntryKeyDetails {
  return Object.hasOwn(LOG_ENTRY_KEY_TYPES, value)
}

/**
 * The digest algorithm an entry of a type carries.
 * @param keyDetails - the entry key type.
 * @returns `SHA2_512` for Ed25519ph, `SHA2_256` for ECDSA P-256.
 */
export function entryDigestAlgorithm(keyDetails: LogEntryKeyDetails): LogEntryDigestAlgorithm {
  return LOG_ENTRY_KEY_TYPES[keyDetails].digestAlgorithm
}

/**
 * The digest an entry of a type claims for a signed file.
 * @param keyDetails - the entry key type.
 * @param message - the signed file's bytes.
 * @returns the base64 digest.
 */
export function entryDigest(keyDetails: LogEntryKeyDetails, message: Uint8Array): string {
  return createHash(entryDigestAlgorithm(keyDetails) === 'SHA2_512' ? 'sha512' : 'sha256').update(message).digest('base64')
}

/** The DER SubjectPublicKeyInfo header of an Ed25519 key, before its 32 raw bytes. */
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex')

/** The DER SubjectPublicKeyInfo header of a P-256 key with an uncompressed point, through the point's `04` byte. */
const P256_UNCOMPRESSED_SPKI_HEADER = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex')

/** The order of the P-256 group: an ECDSA P-256 signature's `r` and `s` lie in [1, n - 1]. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

/**
 * A DER public key read as the key kind an entry key type needs, in its one canonical encoding.
 * @param keyDetails - the entry key type.
 * @param der - the PKIX SubjectPublicKeyInfo bytes.
 * @returns the key, or `undefined` when the bytes are not a public key of that kind in that encoding: an Ed25519 key
 *   of 44 bytes for Ed25519ph; for ECDSA P-256, a P-256 (`prime256v1`) EC key of 91 bytes whose point is uncompressed,
 *   so the compressed-point encoding of a listed key is not that key's bytes and is refused. The bytes must also be
 *   exactly what the key exports again.
 */
export function entryPublicKey(keyDetails: LogEntryKeyDetails, der: Uint8Array): KeyObject | undefined {
  const bytes = Buffer.from(der)
  const header = keyDetails === 'PKIX_ED25519_PH' ? ED25519_SPKI_HEADER : P256_UNCOMPRESSED_SPKI_HEADER
  const length = keyDetails === 'PKIX_ED25519_PH' ? ED25519_SPKI_HEADER.length + 32 : P256_UNCOMPRESSED_SPKI_HEADER.length + 64
  if (bytes.length !== length || !bytes.subarray(0, header.length).equals(header)) return undefined
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' })
  } catch (_notAKey) {
    // Bytes that are not a DER public key match no type.
    return undefined
  }
  if (!key.export({ format: 'der', type: 'spki' }).equals(bytes)) return undefined
  if (keyDetails === 'PKIX_ED25519_PH') return key.asymmetricKeyType === 'ed25519' ? key : undefined
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : undefined
}

/**
 * One DER INTEGER of an ECDSA signature, in its minimal encoding.
 * @param bytes - the signature.
 * @param at - where the INTEGER's tag is.
 * @returns its value and where it ends, or `undefined` when it is not a minimal, non-negative DER INTEGER of at most
 *   33 content bytes.
 */
function derInteger(bytes: Uint8Array, at: number): { readonly value: bigint, readonly end: number } | undefined {
  const length = bytes[at + 1]
  if (bytes[at] !== 0x02 || length === undefined || length < 1 || length > 33) return undefined
  const start = at + 2
  const end = start + length
  if (end > bytes.length) return undefined
  const first = bytes[start]!
  // A negative value, or a leading zero byte that the next byte does not need, is not the minimal encoding.
  if ((first & 0x80) !== 0 || (first === 0 && length > 1 && (bytes[start + 1]! & 0x80) === 0)) return undefined
  return { value: BigInt(`0x${Buffer.from(bytes.subarray(start, end)).toString('hex')}`), end }
}

/**
 * Whether a signature is an ECDSA P-256 signature in strict ASN.1 DER: a SEQUENCE with a one-byte length that covers
 * exactly the rest of the bytes, holding exactly two minimal INTEGERs `r` and `s`, each in [1, n - 1]. A raw 64-byte
 * `r || s` signature, BER, trailing bytes and out-of-range values are refused here, whatever the crypto library would
 * accept.
 * @param signature - the entry's signature.
 * @returns whether it is in that form.
 */
export function isStrictEcdsaP256Signature(signature: Uint8Array): boolean {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) return false
  const r = derInteger(signature, 2)
  if (r === undefined) return false
  const s = derInteger(signature, r.end)
  if (s === undefined || s.end !== signature.length) return false
  return r.value > 0n && r.value < P256_ORDER && s.value > 0n && s.value < P256_ORDER
}

/**
 * The 32 raw bytes of an Ed25519 public key.
 * @param key - the public key.
 * @returns the raw key.
 */
function rawEd25519(key: KeyObject): Buffer {
  const x = key.export({ format: 'jwk' }).x
  if (x === undefined) throw new Error('the Ed25519 key has no raw value')
  return Buffer.from(x, 'base64url')
}

/**
 * Sign a file as an entry of a type signs it.
 * @param keyDetails - the entry key type.
 * @param key - the private key, of the type's kind.
 * @param message - the file's bytes.
 * @returns the signature: Ed25519ph with an empty context, or ECDSA P-256 over SHA-256 in ASN.1 DER.
 * @throws Error when the key is not a private key of the type's kind.
 */
export function signLogEntry(keyDetails: LogEntryKeyDetails, key: KeyObject, message: Uint8Array): Buffer {
  if (entryPublicKey(keyDetails, createPublicKey(key).export({ format: 'der', type: 'spki' })) === undefined) {
    throw new Error(`the key is not a ${keyDetails} key`)
  }
  if (keyDetails === 'PKIX_ED25519_PH') {
    const seed = key.export({ format: 'jwk' }).d
    if (seed === undefined) throw new Error('Ed25519ph signing needs a private key')
    return Buffer.from(ed25519ph.sign(message, Buffer.from(seed, 'base64url')))
  }
  return sign('sha256', message, { key, dsaEncoding: 'der' })
}

/**
 * Verify an entry's signature over a file with the type's algorithm.
 * @param keyDetails - the entry key type.
 * @param key - the public key, as {@link entryPublicKey} read it.
 * @param message - the signed file's bytes.
 * @param signature - the entry's signature.
 * @returns whether it verifies: Ed25519ph with canonical encodings and the cofactorless equation (not ZIP-215), or
 *   ECDSA P-256 in strict DER ({@link isStrictEcdsaP256Signature}) over SHA-256 of the file's bytes, which this
 *   function hashes itself, so a signature over a digest of the file, such as one over its SHA-256 as the message, does
 *   not verify. A signature that does not decode does not verify.
 */
export function verifyLogEntry(keyDetails: LogEntryKeyDetails, key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (keyDetails === 'PKIX_ED25519_PH') return ed25519ph.verify(signature, message, rawEd25519(key), { zip215: false })
    if (!isStrictEcdsaP256Signature(signature)) return false
    return verify('sha256', message, { key, dsaEncoding: 'der' }, signature)
  } catch (_undecodable) {
    // A signature that does not decode is one that does not verify.
    return false
  }
}

/** The listed key an entry verifies with, or why the root trusts none. */
export type ListedEntryKey =
  | { readonly ok: true, readonly keyDetails: LogEntryKeyDetails, readonly key: KeyObject, readonly id: string }
  | { readonly ok: false, readonly reason: 'type-refused' | 'key-untrusted', readonly detail: string }

/**
 * Whether a listed log-entry key is valid for a release: `active`, or `retired` with a last release at or above it.
 * @param key - the listed key.
 * @param version - the release's version, a semantic version.
 * @returns whether it may verify the release's entry.
 */
function validFor(key: LogEntryKey, version: string): boolean {
  if (key.status === 'active') return true
  if (key.status !== 'retired' || key.lastRelease === undefined || semver.valid(key.lastRelease) === null) return false
  return semver.lte(version, key.lastRelease)
}

/**
 * A log-entry key's id: the lowercase hex SHA-256 of its DER public key, as refusals name it and as the
 * production-keys registry lists a production log-entry key.
 * @param key - the key, private or public.
 * @returns the id.
 */
export function entryKeyId(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  return createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex')
}

/**
 * The key of a root's `logEntryKeys` that an entry must verify with.
 * @param keys - the root's `logEntryKeys`.
 * @param version - the release's version, already checked to be a semantic version.
 * @param keyDetails - the entry's `keyDetails`.
 * @param der - the entry's DER public key.
 * @returns the key with its id (the lowercase hex SHA-256 of its DER), or `type-refused` when this client does not
 *   implement the type or the root lists no key of it, and `key-untrusted` when no listed key of the type is the
 *   entry's, the matching key is revoked or retired before the release, or it does not read as a key of its type.
 */
export function listedEntryKey(keys: readonly LogEntryKey[], version: string, keyDetails: string, der: Uint8Array): ListedEntryKey {
  if (!isLogEntryKeyDetails(keyDetails)) return { ok: false, reason: 'type-refused', detail: `the log entry's key details are ${keyDetails}, a type this client does not verify` }
  const ofType = keys.filter(key => key.keyDetails === keyDetails)
  if (ofType.length === 0) return { ok: false, reason: 'type-refused', detail: `the log entry's key details are ${keyDetails}, which the trusted root does not list` }
  const id = createHash('sha256').update(der).digest('hex')
  const listed = ofType.find(key => Buffer.from(key.public, 'base64').equals(Buffer.from(der)))
  if (listed === undefined) return { ok: false, reason: 'key-untrusted', detail: `the log entry is signed by ${keyDetails} key ${id}, which the trusted root does not list` }
  if (!validFor(listed, version)) return { ok: false, reason: 'key-untrusted', detail: `${keyDetails} log-entry key ${id} is ${listed.status} and verifies no entry of release ${version}` }
  const key = entryPublicKey(keyDetails, der)
  if (key === undefined) return { ok: false, reason: 'key-untrusted', detail: `${keyDetails} log-entry key ${id} is not a public key of that type` }
  return { ok: true, keyDetails, key, id }
}

/**
 * Every log a root trusts for a bundle's checkpoint.
 * @param root - the trusted root.
 * @returns the root's `logs`; none when it carries no `logs`.
 */
export function trustedLogs(root: Pick<RootMetadata, 'logs'>): readonly ListedLog[] {
  return root.logs ?? []
}

/**
 * The log a root trusts under a checkpoint origin.
 * @param root - the trusted root.
 * @param origin - the checkpoint's origin line.
 * @returns the log, or `undefined` when the root trusts no log of that origin.
 */
export function trustedLog(root: Pick<RootMetadata, 'logs'>, origin: string): ListedLog | undefined {
  return trustedLogs(root).find(log => log.origin === origin)
}

/**
 * Why a listed log may not hold a release's bundle, if it may not: a log with a `lastRelease` takes no later release,
 * so only the root's current log takes new releases.
 * @param log - the listed log.
 * @param version - the release's version, a semantic version read from the signed manifest.
 * @returns the reason, or `undefined` when the log may hold the release.
 */
export function logRefusesRelease(log: ListedLog, version: string): string | undefined {
  if (log.lastRelease === undefined || semver.lte(version, log.lastRelease)) return undefined
  return `the checkpoint is for ${JSON.stringify(log.origin)}, which the trusted root lists only for releases up to ${log.lastRelease}, and this release is ${version}`
}

/** A private key that signs log entries, with the entry key type it signs under. */
export interface LogEntrySigner {
  /** The entry key type. */
  readonly keyDetails: LogEntryKeyDetails
  /** The private key. */
  readonly key: KeyObject
}

/**
 * The signers a release may log with, in the order to try them: the root's listed `active` keys in the root's order,
 * each that one of the held private keys belongs to.
 * @param root - the trusted root the release verifies under.
 * @param held - the private keys the signing machine holds.
 * @returns the signers, in order; empty when the root lists no `logEntryKeys` or none of the held keys is an active
 *   listed key.
 */
export function entrySigners(root: Pick<RootMetadata, 'logEntryKeys'>, held: readonly LogEntrySigner[]): readonly LogEntrySigner[] {
  const derOf = (key: KeyObject): Buffer => createPublicKey(key).export({ format: 'der', type: 'spki' })
  const order: LogEntrySigner[] = []
  for (const listed of root.logEntryKeys ?? []) {
    if (listed.status !== 'active') continue
    const signer = held.find(candidate => candidate.keyDetails === listed.keyDetails && derOf(candidate.key).equals(Buffer.from(listed.public, 'base64')))
    if (signer !== undefined && !order.includes(signer)) order.push(signer)
  }
  return order
}
