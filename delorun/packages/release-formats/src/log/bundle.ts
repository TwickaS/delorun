/**
 * The release-log bundle of contract C18 (`delorun-<version>.manifest.log.json`) and its offline verification: the
 * manifest digest, the Rekor v2 `hashedrekord` entry and its signature by a log-entry key the root lists, the RFC 6962
 * inclusion proof, the checkpoint of a log the root lists with that log's signature, and at least the root metadata's
 * threshold of cosignatures from listed witnesses. A bundle whose
 * checkpoint carries no valid listed cosignature fails, whatever its log signature says.
 *
 * @module @delorun/release-formats/log/bundle
 */
import { createHash } from 'node:crypto'
import { RELEASE_LOG_BUNDLE_SCHEMA, RELEASE_LOG_BUNDLE_SIZE_LIMIT, MAX_PROOF_HASHES, WITNESS_THRESHOLD, type ReleaseLogBundle, type ReleaseLogFailure } from '@delorun/contract-release-log'
import type { LogEntryKey, RootMetadata } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import semver from 'semver'
import { z } from 'zod'
import { parseStrictJson } from '../sign/json.ts'
import { EntryBodySchema, type ParsedEntryBody } from './entry.ts'
import { entryDigest, entryDigestAlgorithm, listedEntryKey, logRefusesRelease, trustedLog, verifyLogEntry } from './entry-keys.ts'
import { leafHash, rootFromInclusionProof } from './merkle.ts'
import { parseCheckpoint, parseVerifier, splitNote, verifySignature } from './note.ts'

/** A verifiable failure, with C18's reason code. */
export class LogVerificationError extends Error {
  override readonly name = 'LogVerificationError'

  /** The reason code. */
  readonly failure: ReleaseLogFailure

  /**
   * @param failure - the reason code.
   * @param message - what failed.
   */
  constructor(failure: ReleaseLogFailure, message: string) {
    super(message)
    this.failure = failure
  }
}

const hex = z.string().regex(/^[0-9a-f]{64}$/u)

/** The bundle's schema; unknown fields fail it. */
export const BundleSchema = z.strictObject({
  schema: z.literal(RELEASE_LOG_BUNDLE_SCHEMA),
  manifest: z.strictObject({ name: z.string().min(1), sha256: hex.transform(value => brandString<ReleaseLogBundle['manifest']['sha256']>(value)) }),
  entry: z.strictObject({ logIndex: z.number().int().min(0), integratedTime: z.number().int().min(0), body: z.string().min(1) }),
  inclusion: z.strictObject({ logIndex: z.number().int().min(0), treeSize: z.number().int().min(1), rootHash: hex, hashes: z.array(hex).max(MAX_PROOF_HASHES) }),
  checkpoint: z.string().min(1),
})

/**
 * The name of the file that carries a manifest's log entry request from the signing machine to the release workflow.
 * The signing command writes one request per log-entry key it may sign with, in the order the logging step tries them.
 * @param version - the release.
 * @param position - the request's position in that order, from 0.
 * @returns `delorun-<version>.manifest.entry.json` for the first, `delorun-<version>.manifest.entry.<position + 1>.json`
 *   for each later one.
 */
export function logEntryName(version: string, position = 0): string {
  return `delorun-${version}.manifest.entry${position === 0 ? '' : `.${String(position + 1)}`}.json`
}

/**
 * The name of a release's packs file.
 * @param version - the release.
 * @returns `delorun-<version>.packs.json`.
 */
export function packsName(version: string): string {
  return `delorun-${version}.packs.json`
}

/**
 * The name of the file that carries the packs file's log entry request to the release workflow, one per log-entry key
 * as {@link logEntryName} names the manifest's.
 * @param version - the release.
 * @param position - the request's position in the order the logging step tries them, from 0.
 * @returns `delorun-<version>.packs.entry.json` for the first, `delorun-<version>.packs.entry.<position + 1>.json` for
 *   each later one.
 */
export function packsEntryName(version: string, position = 0): string {
  return `delorun-${version}.packs.entry${position === 0 ? '' : `.${String(position + 1)}`}.json`
}

/**
 * The name of the packs file's release-log bundle.
 * @param version - the release.
 * @returns `delorun-<version>.packs.log.json`.
 */
export function packsLogName(version: string): string {
  return `delorun-${version}.packs.log.json`
}

/**
 * Read a bundle file.
 * @param bytes - the file's bytes.
 * @returns the bundle.
 * @throws Error when it exceeds 64 KiB, is not strict JSON or does not match the schema.
 */
export function readBundle(bytes: Uint8Array): ReleaseLogBundle {
  const parsed = BundleSchema.safeParse(parseStrictJson(bytes, RELEASE_LOG_BUNDLE_SIZE_LIMIT))
  if (!parsed.success) throw new Error(`release-log bundle: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  return parsed.data
}

/** A bundle that verified offline. */
export interface VerifiedBundle {
  /** The checkpoint's tree size and root, the client's starting point for the online consistency check. */
  readonly treeSize: number
  readonly rootHash: Buffer
  /** The newest verified cosigning time, in Unix seconds. */
  readonly cosigned: number
}

/** An entry body's digest and signature, as they parsed. */
type EntryParts = ParsedEntryBody['spec']['hashedRekordV002']

/**
 * Contract C18 step 2 under a root with `logEntryKeys`: the entry's type is listed and implemented, its key is a listed
 * key of that type valid for the release, its digest is the type's digest of the signed file, and its signature
 * verifies with the listed key.
 * @param keys - the root's `logEntryKeys`.
 * @param manifest - the signed file's bytes.
 * @param version - the release version.
 * @param data - the entry's digest.
 * @param signature - the entry's signature and verifier.
 * @throws LogVerificationError `manifest-digest-mismatch` or `entry-signature-invalid`.
 */
function verifyListedEntry(keys: readonly LogEntryKey[], manifest: Uint8Array, version: string, data: EntryParts['data'], signature: EntryParts['signature']): void {
  const listed = listedEntryKey(keys, version, signature.verifier.keyDetails, Buffer.from(signature.verifier.publicKey.rawBytes, 'base64'))
  if (!listed.ok) throw new LogVerificationError('entry-signature-invalid', listed.detail)
  if (data.algorithm !== entryDigestAlgorithm(listed.keyDetails) || data.digest !== entryDigest(listed.keyDetails, manifest)) {
    throw new LogVerificationError('manifest-digest-mismatch', `the log entry is not a Rekor v2 hashedrekord of the manifest's ${entryDigestAlgorithm(listed.keyDetails)} digest`)
  }
  if (!verifyLogEntry(listed.keyDetails, listed.key, manifest, Buffer.from(signature.content, 'base64'))) {
    throw new LogVerificationError('entry-signature-invalid', `the log entry's ${listed.keyDetails} signature over the manifest does not verify with log-entry key ${listed.id}`)
  }
}

/**
 * Contract C18 step 2 on an entry body alone: the body is a Rekor v2 `hashedrekord` of the signed file, signed by a key
 * the root trusts for the release's log entry. The signing tool runs it on its own request's body before submitting.
 * @param root - the trusted root.
 * @param manifest - the signed file's bytes.
 * @param version - the release version, a semantic version.
 * @param body - the entry body's bytes.
 * @throws LogVerificationError `manifest-digest-mismatch` or `entry-signature-invalid`.
 */
export function verifyEntryBody(root: RootMetadata, manifest: Uint8Array, version: string, body: Uint8Array): void {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(body).toString('utf8'))
  } catch (error) {
    // A SyntaxError: a body that is not JSON fails the schema check below, which reports it.
    decoded = error
  }
  const parsed = EntryBodySchema.safeParse(decoded)
  if (!parsed.success) throw new LogVerificationError('manifest-digest-mismatch', 'the log entry is not a Rekor v2 hashedrekord of the manifest')
  const { data, signature } = parsed.data.spec.hashedRekordV002
  if (root.logEntryKeys === undefined) throw new LogVerificationError('entry-signature-invalid', `root ${String(root.version)} lists no logEntryKeys, so it trusts no log entry`)
  verifyListedEntry(root.logEntryKeys, manifest, version, data, signature)
}

/**
 * Verify a bundle offline, in contract C18's five steps.
 *
 * The three refusals this verifier shares with `@delorun/release-verify`, which is the client's own strict verifier: the
 * bundle must name the release's manifest file `delorun-<version>.manifest.json`, the release version must be a
 * semantic version before any log-entry key is compared with it, and the witness threshold has the contract's floor of
 * one, so a root that carries no threshold still needs a listed witness's cosignature.
 * @param root - the client's trusted root.
 * @param manifest - the manifest file's bytes, already verified under contract C2.
 * @param version - the manifest's release version.
 * @param bundle - the bundle.
 * @param document - which signed release file the bundle covers: the manifest, or the packs file whose bundle is
 *   `delorun-<version>.packs.log.json`.
 * @returns the checkpoint facts.
 * @throws LogVerificationError naming the failed step's reason code.
 */
export function verifyBundle(root: RootMetadata, manifest: Uint8Array, version: string, bundle: ReleaseLogBundle, document: 'manifest' | 'packs' = 'manifest'): VerifiedBundle {
  if (semver.valid(version) === null) {
    // Contract C18 has no code of its own for a version no key can be shown valid for; it is a step 2 failure.
    throw new LogVerificationError('entry-signature-invalid', `release version ${JSON.stringify(version)} is not a semantic version, so no log-entry key can be shown valid for it`)
  }
  // Contract C2 names the release's manifest and packs files, so a bundle naming another file covers another document
  // whatever digest it carries.
  const name = `delorun-${version}.${document}.json`
  if (bundle.manifest.name !== name) {
    throw new LogVerificationError('manifest-digest-mismatch', `the bundle names ${JSON.stringify(bundle.manifest.name)}, not the release's ${document} file ${JSON.stringify(name)}`)
  }
  const digest = createHash('sha256').update(manifest).digest('hex')
  if (bundle.manifest.sha256 !== digest) throw new LogVerificationError('manifest-digest-mismatch', `the bundle covers manifest ${bundle.manifest.sha256}, not ${digest}`)
  const body = Buffer.from(bundle.entry.body, 'base64')
  verifyEntryBody(root, manifest, version, body)
  const computed = rootFromInclusionProof(bundle.inclusion.logIndex, bundle.inclusion.treeSize, leafHash(body), bundle.inclusion.hashes.map((hash: string) => Buffer.from(hash, 'hex')))
  if (bundle.inclusion.logIndex !== bundle.entry.logIndex || computed === undefined || computed.toString('hex') !== bundle.inclusion.rootHash) {
    throw new LogVerificationError('inclusion-proof-invalid', 'the inclusion proof does not reproduce the bundle\'s root hash')
  }
  let note: ReturnType<typeof splitNote>
  let checkpoint: ReturnType<typeof parseCheckpoint>
  try {
    note = splitNote(bundle.checkpoint)
    checkpoint = parseCheckpoint(note.body)
  } catch (error) {
    throw new LogVerificationError('log-signature-invalid', `the checkpoint does not parse: ${(error as Error).message}`)
  }
  const trusted = trustedLog(root, checkpoint.origin)
  if (trusted === undefined || checkpoint.size !== bundle.inclusion.treeSize || checkpoint.rootHash.toString('hex') !== bundle.inclusion.rootHash) {
    throw new LogVerificationError('log-signature-invalid', 'the checkpoint does not name a log the root trusts, the proof\'s tree size and its root hash')
  }
  const closed = logRefusesRelease(trusted, version)
  if (closed !== undefined) throw new LogVerificationError('log-signature-invalid', closed)
  const log = parseVerifier(trusted.vkey)
  if (!note.signatures.some(line => verifySignature(log, note.body, line) === true)) throw new LogVerificationError('log-signature-invalid', 'the checkpoint has no valid signature from the log\'s key')
  const cosigned = new Map<string, number>()
  for (const witness of root.witnesses.keys) {
    const verifier = parseVerifier(witness.vkey)
    for (const line of note.signatures) {
      const time = verifySignature(verifier, note.body, line)
      if (typeof time === 'number') cosigned.set(witness.vkey, Math.max(time, cosigned.get(witness.vkey) ?? 0))
    }
  }
  // The contract fixes the client's witness threshold at one, so a root that carries none requires one cosignature
  // anyway: a threshold of zero would accept a checkpoint no listed witness ever saw. `Math.max` of no values is
  // `-Infinity`, so a checkpoint with no valid cosignature is refused before any newest cosigning time is read.
  const threshold = Math.max(root.witnesses.threshold, WITNESS_THRESHOLD)
  if (cosigned.size === 0 || cosigned.size < threshold) {
    throw new LogVerificationError('witness-cosignature-missing', `the checkpoint has ${String(cosigned.size)} valid cosignatures from listed witnesses; ${String(threshold)} are required`)
  }
  return { treeSize: checkpoint.size, rootHash: checkpoint.rootHash, cosigned: Math.max(...cosigned.values()) }
}
