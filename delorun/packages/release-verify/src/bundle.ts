/**
 * The release-log bundle of contract C18 (`delorun-<version>.manifest.log.json`) and the client's offline verification
 * of it, in the contract's five steps and against the keys of the client's own trusted root:
 *
 * 1. the bundle covers the manifest file the client verified under contract C2, by SHA-256;
 * 2. the entry body is a Rekor v2 `hashedrekord` `0.0.2` over the manifest file signed by a key the root trusts for
 *    the release's log entry: a listed log-entry key of a listed type under a root with `logEntryKeys`, an Ed25519ph
 *    signature by a targets key valid for the release under a root without it;
 * 3. the leaf hash, the inclusion proof and the tree size reproduce the bundle's root hash;
 * 4. the checkpoint names a log the root trusts (its `logs`, or `log` alone) with the proof's size and root hash, and
 *    its log signature verifies with the key the root lists for that log;
 * 5. at least the root's threshold of distinct listed witnesses cosigned that checkpoint.
 *
 * The log key and the witness keys are taken only from the trusted root (R6): a bundle cannot hand this client a key to
 * trust. A bundle without a valid witness cosignature fails step 5 whatever its log signature says (R2).
 *
 * The root is a precondition: this module trusts the root it is given, so the caller reads it under contract C2 first,
 * which checks its signature, its `expires` against the clock, and that the log verifier key's name is the log origin.
 * Nothing here can check those without the root's own signatures.
 *
 * @module @delorun/release-verify/bundle
 */
import { createHash } from 'node:crypto'
import {
  MAX_PROOF_HASHES,
  RELEASE_LOG_BUNDLE_SCHEMA,
  RELEASE_LOG_BUNDLE_SIZE_LIMIT,
  WITNESS_THRESHOLD,
  type ReleaseLogBundle,
} from '@delorun/contract-release-log'
import type { RootMetadata, Sha256Hex } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { refuse, ReleaseLogRefusalError, type ReleaseLogRefusal } from './errors.ts'
import { readEntryBody, requireReleaseVersion, verifyEntryIdentity } from './entry.ts'
import { parseStrictJson } from './json.ts'
import { leafHash, rootFromInclusionProof } from './merkle.ts'
import { parseCheckpoint, splitNote, trustedLogKeys, verifySignature, type Checkpoint } from './note.ts'
import { trustedLog } from '@delorun/release-formats/log/entry-keys'

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

/** The release file a bundle covers: the manifest, or the packs file (`delorun-<version>.packs.log.json`). */
export type SignedDocument = 'manifest' | 'packs'

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
 * @param manifest - the signed file's bytes, verified under contract C2 (the manifest, or the packs file).
 * @param document - which release file the bundle covers; the manifest by default.
 * @param bundle - the bundle.
 * @returns what verified.
 * @throws ReleaseLogRefusalError naming the step that refused: `entry-key-untrusted` when the version is not a semantic
 * version, `manifest-digest-mismatch` when the bundle names or covers another manifest file, and the step's own refusal.
 */
export function verifyBundle(root: RootMetadata, version: string, manifest: Uint8Array, bundle: ReleaseLogBundle, document: SignedDocument = 'manifest'): VerifiedBundle {
  requireReleaseVersion(version)
  // The bundle names the signed file it covers, so a bundle naming another file covers another document, whatever
  // digest it carries: contract C2 names the release's files `delorun-<version>.manifest.json` and `.packs.json`.
  const name = `delorun-${version}.${document}.json`
  if (bundle.manifest.name !== name) throw refuse('manifest-digest-mismatch', `the bundle names ${JSON.stringify(bundle.manifest.name)}, not the release's ${document} file ${JSON.stringify(name)}`)
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
  const log = trustedLog(root, checkpoint.origin)
  if (log === undefined) throw refuse('log-origin-untrusted', `the checkpoint is for ${JSON.stringify(checkpoint.origin)}, which is no log the trusted root lists (its log is ${JSON.stringify(root.log.origin)})`)
  if (checkpoint.size !== bundle.inclusion.treeSize || checkpoint.rootHash.toString('hex') !== bundle.inclusion.rootHash) {
    throw refuse('log-origin-untrusted', 'the checkpoint names another tree than the inclusion proof')
  }
  const keys = trustedLogKeys({ log, witnesses: root.witnesses })
  if (!note.signatures.some(line => verifySignature(keys.log, note.body, line) === true)) throw refuse('log-signature-invalid', 'the checkpoint has no valid signature from the key the trusted root lists for its log')
  const cosigned = new Map<string, number>()
  for (const verifier of keys.witnesses) {
    for (const line of note.signatures) {
      const time = verifySignature(verifier, note.body, line)
      if (typeof time === 'number') cosigned.set(verifier.raw.toString('hex'), Math.max(time, cosigned.get(verifier.raw.toString('hex')) ?? 0))
    }
  }
  // The contract fixes the client's witness threshold at 1, so a root that carries none requires one cosignature
  // anyway: a threshold of 0 would accept a checkpoint no listed witness ever saw.
  const threshold = Math.max(root.witnesses.threshold, WITNESS_THRESHOLD)
  // `Math.max` of no values is `-Infinity`, which the online check reads as a cosignature infinitely in the past; a
  // checkpoint with no valid cosignature is one refusal, taken before any newest cosigning time.
  if (cosigned.size === 0 || cosigned.size < threshold) {
    throw refuse('witness-cosignature-missing', `the checkpoint has ${String(cosigned.size)} valid cosignatures from the root's witnesses; ${String(threshold)} are required`)
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
 * @param manifest - the signed file's bytes (the manifest, or the packs file when `document` is `packs`).
 * @param bytes - the bundle file's bytes.
 * @returns the verdict.
 */
export function checkBundle(root: RootMetadata, version: string, manifest: Uint8Array, bytes: Uint8Array, document: SignedDocument = 'manifest'): BundleVerdict {
  try {
    return { ok: true, bundle: verifyBundle(root, version, manifest, readBundle(bytes), document) }
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/**
 * Verify the release-log bundle of a packs file, as a verdict: the same five steps over the packs file's bytes, with the
 * bundle required to name `delorun-<version>.packs.json`.
 * @param root - the trusted root metadata.
 * @param version - the release's version.
 * @param packs - the packs file's bytes.
 * @param bytes - the bundle file's bytes.
 * @returns the verdict.
 */
export function checkPacksBundle(root: RootMetadata, version: string, packs: Uint8Array, bytes: Uint8Array): BundleVerdict {
  return checkBundle(root, version, packs, bytes, 'packs')
}
