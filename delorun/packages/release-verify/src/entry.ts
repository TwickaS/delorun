/**
 * The Rekor v2 entry of contract C18 as a client reads it: a `hashedrekord` `0.0.2` entry over the manifest file. Its key
 * details must be an entry key type the trusted root lists in `logEntryKeys` and this client implements, its public key
 * byte for byte a listed key of that type valid for the release, its digest the type's digest of the manifest file, and
 * its signature valid under that listed key — the identity check of contract C18 step 2. A root without `logEntryKeys`
 * trusts no entry. Any other kind, API version, digest algorithm or key type is refused, and so is a valid signature
 * made by a key the trusted root does not list.
 *
 * @module @delorun/release-verify/entry
 */
import { RELEASE_LOG_ENTRY_API_VERSION, RELEASE_LOG_ENTRY_TYPE } from '@delorun/contract-release-log'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { entryDigest, entryDigestAlgorithm, listedEntryKey, verifyLogEntry } from '@delorun/release-formats/log/entry-keys'
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

/** A parsed entry body, before any root decides whether its type and key are trusted. */
export interface ReadEntry {
  /** The entry's key details, the entry key type it claims. */
  readonly keyDetails: string
  /** The digest algorithm the entry claims. */
  readonly algorithm: string
  /** The verifier's DER (PKIX SubjectPublicKeyInfo) public key. */
  readonly publicKey: Buffer
  /** The entry's signature over the manifest file. */
  readonly signature: Buffer
  /** The digest the entry claims for the manifest file, base64. */
  readonly digest: string
}

/**
 * Parse a bundle's entry body.
 * @param bytes - the decoded body.
 * @returns the entry; its key details, digest algorithm and key are checked against a root by {@link verifyEntryIdentity}.
 * @throws ReleaseLogRefusalError `entry-malformed` when the body is not a Rekor v2 `hashedrekord` entry body, and
 * `entry-type-refused` when it is another kind or API version.
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
  return {
    keyDetails: signature.verifier.keyDetails,
    algorithm: data.algorithm,
    publicKey: Buffer.from(signature.verifier.publicKey.rawBytes, 'base64'),
    signature: Buffer.from(signature.content, 'base64'),
    digest: data.digest,
  }
}

/**
 * Refuse a release version that is not a semantic version: a retired key's last release is compared with it, and a
 * comparison of a version this client cannot read would raise instead of refusing.
 * @param version - the release's version, from its signed manifest.
 * @throws ReleaseLogRefusalError `entry-key-untrusted` when the version is not a semantic version, because no log-entry
 * key's validity for that release can be shown.
 */
export function requireReleaseVersion(version: string): void {
  if (semver.valid(version) === null) {
    throw refuse('entry-key-untrusted', `release version ${JSON.stringify(version)} is not a semantic version, so no log-entry key can be shown valid for it`)
  }
}

/**
 * Verify that the entry is the manifest's, made by a log-entry key the trusted root lists for the release (contract C18
 * step 2).
 * @param root - the trusted root.
 * @param version - the release's version, from its signed manifest; never from the log entry or the bundle.
 * @param manifest - the manifest file's bytes.
 * @param entry - the parsed entry.
 * @returns the id of the listed key that signed the entry, the lowercase hex SHA-256 of its DER.
 * @throws ReleaseLogRefusalError `entry-key-untrusted` when the root lists no `logEntryKeys` or the verifier key is no
 * listed key valid for the release, `entry-type-refused` when the entry's key type or digest algorithm is not one the
 * root lists, `manifest-digest-mismatch` when the entry's digest is not the manifest's, and `entry-signature-invalid`
 * when the signature does not verify.
 */
export function verifyEntryIdentity(root: RootMetadata, version: string, manifest: Uint8Array, entry: ReadEntry): string {
  requireReleaseVersion(version)
  if (root.logEntryKeys === undefined) throw refuse('entry-key-untrusted', `root ${String(root.version)} lists no logEntryKeys, so it trusts no log entry`)
  const listed = listedEntryKey(root.logEntryKeys, version, entry.keyDetails, entry.publicKey)
  if (!listed.ok) throw refuse(listed.reason === 'type-refused' ? 'entry-type-refused' : 'entry-key-untrusted', listed.detail)
  const algorithm = entryDigestAlgorithm(listed.keyDetails)
  if (entry.algorithm !== algorithm) throw refuse('entry-type-refused', `the log entry's digest algorithm is ${entry.algorithm}, not ${algorithm}, which ${listed.keyDetails} carries`)
  if (entry.digest !== entryDigest(listed.keyDetails, manifest)) throw refuse('manifest-digest-mismatch', `the log entry is not a ${algorithm} hashedrekord of the manifest file`)
  if (!verifyLogEntry(listed.keyDetails, listed.key, manifest, entry.signature)) {
    throw refuse('entry-signature-invalid', `the log entry's ${listed.keyDetails} signature over the manifest does not verify with log-entry key ${listed.id}`)
  }
  return listed.id
}
