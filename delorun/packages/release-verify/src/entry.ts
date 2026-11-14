/**
 * The Rekor v2 entry of contract C18 as a client reads it: the entry body is a `hashedrekord` `0.0.2` whose digest is
 * the manifest file's SHA-512, whose key details are `PKIX_ED25519_PH`, and whose Ed25519ph signature over the manifest
 * file verifies with a targets key that is valid for the release. An entry of another kind, another API version,
 * another digest algorithm or a pure Ed25519 key is refused, and so is a valid signature made by a key the trusted
 * root does not list as a targets key for this release — the identity check of contract C18 step 2.
 *
 * @module @delorun/release-verify/entry
 */
import { createHash, createPublicKey } from 'node:crypto'
import {
  RELEASE_LOG_ENTRY_API_VERSION,
  RELEASE_LOG_ENTRY_DIGEST_ALGORITHM,
  RELEASE_LOG_ENTRY_KEY_DETAILS,
  RELEASE_LOG_ENTRY_TYPE,
  type HashedRekordBody,
} from '@delorun/contract-release-log'
import type { KeyId, PublicKey, RootMetadata } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ed25519ph } from '@noble/curves/ed25519.js'
import semver from 'semver'
import { z } from 'zod'
import { refuse } from './errors.ts'

/** The base64 a Rekor field carries: standard alphabet, with padding. */
const base64 = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u)

const Signature = z.strictObject({
  content: base64,
  verifier: z.strictObject({
    publicKey: z.strictObject({ rawBytes: base64 }),
    keyDetails: z.string(),
  }),
})

/** A Rekor v2 entry body; unknown fields fail it, as contract C2's readers refuse unknown fields. */
export const EntryBodySchema = z.strictObject({
  apiVersion: z.string(),
  kind: z.string(),
  spec: z.strictObject({
    hashedRekordV002: z.strictObject({
      data: z.strictObject({ algorithm: z.string(), digest: base64 }),
      signature: Signature,
    }),
  }),
})

/** A parsed entry body, with its verifier's raw public key. */
export interface ReadEntry {
  /** The body as it parsed. */
  readonly body: HashedRekordBody
  /** The verifier's 32-byte raw public key. */
  readonly rawKey: Buffer
  /** The entry's signature over the manifest file. */
  readonly signature: Buffer
  /** The digest the entry claims for the manifest file, base64. */
  readonly digest: string
}

/**
 * The raw 32 bytes of a DER-encoded PKIX Ed25519 public key.
 * @param der - the DER bytes.
 * @returns the raw public key.
 * @throws ReleaseLogRefusalError `entry-key-untrusted` when the bytes are not a PKIX Ed25519 public key.
 */
function rawKeyOf(der: Uint8Array): Buffer {
  let x: string | undefined
  try {
    const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    x = key.export({ format: 'jwk' }).x
  } catch {
    throw refuse('entry-key-untrusted', 'the entry names a public key that is not a PKIX Ed25519 key')
  }
  if (x === undefined) throw refuse('entry-key-untrusted', 'the entry names a public key without a raw Ed25519 value')
  return Buffer.from(x, 'base64url')
}

/**
 * A key's id: the lowercase hex SHA-256 of its 32-byte raw public key, as contract C2 names keys.
 * @param raw - the raw public key.
 * @returns the key id.
 */
export function keyIdOf(raw: Uint8Array): KeyId {
  return brandString<KeyId>(createHash('sha256').update(raw).digest('hex'))
}

/**
 * Parse a bundle's entry body.
 * @param bytes - the decoded body.
 * @returns the entry.
 * @throws ReleaseLogRefusalError `entry-malformed` when the body is not a Rekor v2 `hashedrekord` entry with a SHA-512
 * digest, and `entry-type-refused` when its key details are not `PKIX_ED25519_PH`.
 */
export function readEntryBody(bytes: Uint8Array): ReadEntry {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw refuse('entry-malformed', 'the log entry body is not JSON')
  }
  const parsed = EntryBodySchema.safeParse(decoded)
  if (!parsed.success) throw refuse('entry-malformed', 'the log entry body is not a Rekor v2 hashedrekord entry')
  const { data, signature } = parsed.data.spec.hashedRekordV002
  if (parsed.data.kind !== RELEASE_LOG_ENTRY_TYPE || parsed.data.apiVersion !== RELEASE_LOG_ENTRY_API_VERSION) {
    throw refuse('entry-type-refused', `the log entry is ${parsed.data.kind} ${parsed.data.apiVersion}, not ${RELEASE_LOG_ENTRY_TYPE} ${RELEASE_LOG_ENTRY_API_VERSION}`)
  }
  if (data.algorithm !== RELEASE_LOG_ENTRY_DIGEST_ALGORITHM) {
    throw refuse('entry-type-refused', `the log entry's digest algorithm is ${data.algorithm}, not ${RELEASE_LOG_ENTRY_DIGEST_ALGORITHM}`)
  }
  if (signature.verifier.keyDetails !== RELEASE_LOG_ENTRY_KEY_DETAILS) {
    throw refuse('entry-type-refused', `the log entry's key details are ${signature.verifier.keyDetails}, not ${RELEASE_LOG_ENTRY_KEY_DETAILS}`)
  }
  const body: HashedRekordBody = {
    apiVersion: RELEASE_LOG_ENTRY_API_VERSION,
    kind: RELEASE_LOG_ENTRY_TYPE,
    spec: {
      hashedRekordV002: {
        data: { algorithm: RELEASE_LOG_ENTRY_DIGEST_ALGORITHM, digest: data.digest },
        signature: {
          content: signature.content,
          verifier: { publicKey: { rawBytes: signature.verifier.publicKey.rawBytes }, keyDetails: RELEASE_LOG_ENTRY_KEY_DETAILS },
        },
      },
    },
  }
  return {
    body,
    rawKey: rawKeyOf(Buffer.from(signature.verifier.publicKey.rawBytes, 'base64')),
    signature: Buffer.from(signature.content, 'base64'),
    digest: data.digest,
  }
}

/**
 * Verify an Ed25519ph signature over a message, as RFC 8032 defines it with an empty context and canonical encodings.
 * @param rawKey - the 32-byte raw public key.
 * @param message - the message; Ed25519ph signs its SHA-512.
 * @param signature - the 64-byte signature.
 * @returns `true` when the signature verifies.
 */
export function verifyEd25519ph(rawKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519ph.verify(signature, message, rawKey, { zip215: false })
  } catch {
    // A signature that does not decode or does not verify is one refusal, not two.
    return false
  }
}

/**
 * Refuse a release version that is not a semantic version: a retired key's last release is compared with it, and a
 * comparison of a version this client cannot read would raise instead of refusing.
 * @param version - the release's version.
 * @throws ReleaseLogRefusalError `entry-key-untrusted` when the version is not a semantic version, because no targets
 * key's validity for that release can be shown.
 */
export function requireReleaseVersion(version: string): void {
  if (semver.valid(version) === null) {
    throw refuse('entry-key-untrusted', `release version ${JSON.stringify(version)} is not a semantic version, so no targets key can be shown valid for it`)
  }
}

/**
 * The targets keys that may verify a release: the active key, and each retired key whose last release is at or above
 * the release's version. A revoked key verifies nothing, so a release never verifies with it.
 *
 * A version that is not a semantic version, and a retired key whose last release is not one either, are refused rather
 * than compared: `semver.lte` raises a `TypeError` on either, which is no verdict a start can record, and a key whose
 * retirement point cannot be read is trusted for nothing.
 * @param root - the trusted root.
 * @param version - the release's version.
 * @returns the keys with their ids.
 * @throws ReleaseLogRefusalError `entry-key-untrusted` when the version or a retired key's last release is not a
 * semantic version, when a listed key is not a 32-byte base64 Ed25519 key, or when a key is listed under an id that is
 * not its own digest.
 */
export function targetsKeysFor(root: RootMetadata, version: string): readonly { readonly keyid: KeyId, readonly rawKey: Buffer }[] {
  requireReleaseVersion(version)
  const allowed = root.roles.targets.keys.filter((key) => {
    if (key.status === 'active') return true
    if (key.status !== 'retired' || key.lastRelease === undefined) return false
    if (semver.valid(key.lastRelease) === null) {
      throw refuse('entry-key-untrusted', `retired targets key ${key.keyid} names a last release ${JSON.stringify(key.lastRelease)} that is not a semantic version`)
    }
    return semver.lte(version, key.lastRelease)
  })
  return allowed.map((key) => {
    const entry: PublicKey | undefined = root.keys[key.keyid]
    if (entry === undefined) throw refuse('entry-key-untrusted', `the trusted root names targets key ${key.keyid} without listing it`)
    const raw = Buffer.from(entry.public, 'base64')
    if (raw.byteLength !== 32 || raw.toString('base64') !== entry.public) throw refuse('entry-key-untrusted', `targets key ${key.keyid} is not a 32-byte base64 Ed25519 key`)
    if (keyIdOf(raw) !== key.keyid) throw refuse('entry-key-untrusted', `targets key ${key.keyid} is listed under an id that is not the digest of its key`)
    return { keyid: key.keyid, rawKey: raw }
  })
}

/**
 * Verify that the entry is the manifest's, made by a targets key valid for the release (contract C18 step 2).
 * @param root - the trusted root.
 * @param version - the release's version.
 * @param manifest - the manifest file's bytes.
 * @param entry - the parsed entry.
 * @returns the id of the targets key that signed the entry.
 * @throws ReleaseLogRefusalError `manifest-digest-mismatch` when the entry's digest is not the manifest's SHA-512,
 * `entry-key-untrusted` when the verifier key is no targets key valid for the release, and `entry-signature-invalid`
 * when the Ed25519ph signature does not verify.
 */
export function verifyEntryIdentity(root: RootMetadata, version: string, manifest: Uint8Array, entry: ReadEntry): KeyId {
  const sha512 = createHash('sha512').update(manifest).digest('base64')
  if (entry.digest !== sha512) throw refuse('manifest-digest-mismatch', 'the log entry is not a SHA-512 hashedrekord of the manifest file')
  const keyid = keyIdOf(entry.rawKey)
  const targets = targetsKeysFor(root, version).find(key => key.keyid === keyid)
  if (targets === undefined) throw refuse('entry-key-untrusted', `the log entry is signed by key ${keyid}, which is no targets key valid for release ${version}`)
  if (!verifyEd25519ph(targets.rawKey, manifest, entry.signature)) {
    throw refuse('entry-signature-invalid', `the log entry's Ed25519ph signature over the manifest does not verify with targets key ${keyid}`)
  }
  return keyid
}
