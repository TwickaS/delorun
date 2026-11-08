/**
 * The release-log bundle of contract C18 (`delorun-<version>.manifest.log.json`) and the client's offline verification
 * of it, in the contract's five steps and against the keys of the client's own trusted root:
 *
 * 1. the bundle covers the manifest file the client verified under contract C2, by SHA-256;
 * 2. the entry body is a Rekor v2 `hashedrekord` `0.0.2` whose SHA-512 digest is the manifest file's, whose key details
 *    are `PKIX_ED25519_PH`, and whose Ed25519ph signature verifies with a targets key valid for the release;
 * 3. the leaf hash, the inclusion proof and the tree size reproduce the bundle's root hash;
 * 4. the checkpoint names the trusted root's log origin with the proof's size and root hash, and its log signature
 *    verifies with the log key the root carries;
 * 5. at least the root's threshold of distinct listed witnesses cosigned that checkpoint.
 *
 * The log key and the witness keys are taken only from the trusted root (R6): a bundle cannot hand this client a key to
 * trust. A bundle without a valid witness cosignature fails step 5 whatever its log signature says (R2).
 *
 * @module @delo/release-verify/bundle
 */
import { createHash } from 'node:crypto'
import {
  MAX_PROOF_HASHES,
  RELEASE_LOG_BUNDLE_SCHEMA,
  RELEASE_LOG_BUNDLE_SIZE_LIMIT,
  type ReleaseLogBundle,
} from '@delo/contract-release-log'
import type { RootMetadata, Sha256Hex } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { refuse, ReleaseLogRefusalError, type ReleaseLogRefusal } from './errors.ts'
import { readEntryBody, verifyEntryIdentity } from './entry.ts'
import { parseStrictJson } from './json.ts'
import { leafHash, rootFromInclusionProof } from './merkle.ts'
import { parseCheckpoint, parseVerifierKey, splitNote, verifySignature, type Checkpoint } from './note.ts'

/** A lowercase hex SHA-256 digest. */
const hex = z.string().regex(/^[0-9a-f]{64}$/u)

/** A bundle's schema; unknown fields fail it, as every reader of a signed file refuses them. */
export const BundleSchema = z.strictObject({
  schema: z.literal(RELEASE_LOG_BUNDLE_SCHEMA),
  manifest: z.strictObject({ name: z.string().min(1), sha256: hex }),
  entry: z.strictObject({ logIndex: z.number().int().min(0), integratedTime: z.number().int().min(0), body: z.string().min(1) }),
  inclusion: z.strictObject({ logIndex: z.number().int().min(0), treeSize: z.number().int().min(1), rootHash: hex, hashes: z.array(hex).max(MAX_PROOF_HASHES) }),
  checkpoint: z.string().min(1),
})

/** A bundle that verified, with what the online check starts from. */
export interface VerifiedBundle {
  /** The bundle's own tree size. */
  readonly treeSize: number
  /** The bundle's root hash. */
  readonly rootHash: Buffer
  /** The newest cosigning time of a listed witness that verified, in Unix seconds. */
  readonly cosigned: number
  /** The checkpoint that verified. */
  readonly checkpoint: Checkpoint
}

/**
 * Read a bundle file.
 * @param bytes - the file's bytes.
 * @returns the bundle.
 * @throws ReleaseLogRefusalError `bundle-too-large` above {@link RELEASE_LOG_BUNDLE_SIZE_LIMIT} and `bundle-malformed`
 * when the file is not strict JSON or does not match {@link BundleSchema}.
 */
export function readBundle(bytes: Uint8Array): ReleaseLogBundle {
  const value = parseStrictJson(bytes, RELEASE_LOG_BUNDLE_SIZE_LIMIT, 'bundle-too-large', 'bundle-malformed')
  const parsed = BundleSchema.safeParse(value)
  if (!parsed.success) throw refuse('bundle-malformed', `the bundle does not match its schema: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  // The schema proves the digest is 64 lowercase hex digits, which is what the branded field holds.
  return { ...parsed.data, manifest: { name: parsed.data.manifest.name, sha256: brandString<Sha256Hex>(parsed.data.manifest.sha256) } }
}

/**
 * Decode the entry body's base64.
 * @param text - the bundle's `entry.body`.
 * @returns the body's bytes.
 * @throws ReleaseLogRefusalError `entry-malformed` when the text is not standard base64 with padding, or holds no
 * bytes.
 */
function entryBodyBytes(text: string): Buffer {
  const bytes = Buffer.from(text, 'base64')
  if (bytes.byteLength === 0 || bytes.toString('base64') !== text) throw refuse('entry-malformed', 'the log entry body is not standard base64')
  return bytes
}

/**
 * Verify a bundle offline against the client's trusted root (contract C18, `Verifying a bundle`).
 * @param root - the trusted root metadata; it alone names the log and the witnesses.
 * @param version - the release's version, which decides the targets keys that may have signed the entry.
 * @param manifest - the manifest file's bytes, verified under contract C2.
 * @param bundle - the bundle.
 * @returns what verified.
 * @throws ReleaseLogRefusalError naming the step that refused.
 */
export function verifyBundle(root: RootMetadata, version: string, manifest: Uint8Array, bundle: ReleaseLogBundle): VerifiedBundle {
  const sha256 = createHash('sha256').update(manifest).digest('hex')
  if (bundle.manifest.sha256 !== sha256) throw refuse('manifest-digest-mismatch', `the bundle covers manifest ${bundle.manifest.sha256}, not ${sha256}`)
  const body = entryBodyBytes(bundle.entry.body)
  const entry = readEntryBody(body)
  verifyEntryIdentity(root, version, manifest, entry)
  const computed = rootFromInclusionProof(bundle.inclusion.logIndex, bundle.inclusion.treeSize, leafHash(body), bundle.inclusion.hashes.map(hash => Buffer.from(hash, 'hex')))
  if (bundle.inclusion.logIndex !== bundle.entry.logIndex || computed === undefined || computed.toString('hex') !== bundle.inclusion.rootHash) {
    throw refuse('inclusion-proof-invalid', 'the inclusion proof does not reproduce the bundle\'s root hash at the entry\'s index')
  }
  const note = splitNote(bundle.checkpoint)
  const checkpoint = parseCheckpoint(note.body)
  if (checkpoint.origin !== root.log.origin) throw refuse('log-origin-untrusted', `the checkpoint is for ${JSON.stringify(checkpoint.origin)}, not the trusted root's log ${JSON.stringify(root.log.origin)}`)
  if (checkpoint.size !== bundle.inclusion.treeSize || checkpoint.rootHash.toString('hex') !== bundle.inclusion.rootHash) {
    throw refuse('log-origin-untrusted', 'the checkpoint names another tree than the inclusion proof')
  }
  const log = parseVerifierKey(root.log.vkey)
  if (!note.signatures.some(line => verifySignature(log, note.body, line) === true)) throw refuse('log-signature-invalid', 'the checkpoint has no valid signature from the trusted root\'s log key')
  const cosigned = new Map<string, number>()
  for (const witness of root.witnesses.keys) {
    const verifier = parseVerifierKey(witness.vkey)
    for (const line of note.signatures) {
      const time = verifySignature(verifier, note.body, line)
      if (typeof time === 'number') cosigned.set(witness.vkey, Math.max(time, cosigned.get(witness.vkey) ?? 0))
    }
  }
  if (cosigned.size < root.witnesses.threshold) {
    throw refuse('witness-cosignature-missing', `the checkpoint has ${String(cosigned.size)} valid cosignatures from the root's witnesses; ${String(root.witnesses.threshold)} are required`)
  }
  return { treeSize: checkpoint.size, rootHash: checkpoint.rootHash, cosigned: Math.max(...cosigned.values()), checkpoint }
}

/** The outcome of an offline verification: what verified, or the refusal and its detail. */
export type BundleVerdict =
  | { readonly ok: true, readonly bundle: VerifiedBundle }
  | { readonly ok: false, readonly refusal: ReleaseLogRefusal, readonly detail: string }

/**
 * Verify a bundle file offline, as a verdict: the start check records a refusal instead of throwing it.
 * @param root - the trusted root metadata.
 * @param version - the release's version.
 * @param manifest - the manifest file's bytes.
 * @param bytes - the bundle file's bytes.
 * @returns the verdict.
 */
export function checkBundle(root: RootMetadata, version: string, manifest: Uint8Array, bytes: Uint8Array): BundleVerdict {
  try {
    return { ok: true, bundle: verifyBundle(root, version, manifest, readBundle(bytes)) }
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}
