/**
 * The release-log bundle of contract C18 (`delorun-<version>.manifest.log.json`) and its offline verification: the
 * manifest digest, the Rekor v2 `hashedrekord` entry and its targets Ed25519ph signature, the RFC 6962 inclusion
 * proof, the checkpoint's
 * log signature, and at least the root metadata's threshold of cosignatures from listed witnesses. A bundle whose
 * checkpoint carries no valid listed cosignature fails, whatever its log signature says.
 *
 * @module @delo/release-formats/log/bundle
 */
import { createHash, createPublicKey } from 'node:crypto'
import { RELEASE_LOG_BUNDLE_SCHEMA, RELEASE_LOG_BUNDLE_SIZE_LIMIT, RELEASE_LOG_ENTRY_DIGEST_ALGORITHM, RELEASE_LOG_ENTRY_KEY_DETAILS, MAX_PROOF_HASHES, WITNESS_THRESHOLD, type ReleaseLogBundle, type ReleaseLogFailure } from '@delo/contract-release-log'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import semver from 'semver'
import { z } from 'zod'
import { keyIdOf, rawPublicKey } from '../sign/envelope.ts'
import { parseStrictJson } from '../sign/json.ts'
import { targetsKeysFor } from '../sign/verify.ts'
import { EntryBodySchema, verifyEd25519ph } from './entry.ts'
import { leafHash, rootFromInclusionProof } from './merkle.ts'
import { parseCheckpoint, parseVerifier, splitNote, verifySignature } from './note.ts'

/** A verifiable failure, with C18's reason code. */
export class LogVerificationError extends Error {
  override readonly name = 'LogVerificationError'

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
 * @param version - the release.
 * @returns `delorun-<version>.manifest.entry.json`.
 */
export function logEntryName(version: string): string {
  return `delorun-${version}.manifest.entry.json`
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

/**
 * Verify a bundle offline, in contract C18's five steps.
 *
 * The three refusals this verifier shares with `@delo/release-verify`, which is the client's own strict verifier: the
 * bundle must name the release's manifest file `delorun-<version>.manifest.json`, the release version must be a
 * semantic version before any targets key is compared with it, and the witness threshold has the contract's floor of
 * one, so a root that carries no threshold still needs a listed witness's cosignature.
 * @param root - the client's trusted root.
 * @param manifest - the manifest file's bytes, already verified under contract C2.
 * @param version - the manifest's release version.
 * @param bundle - the bundle.
 * @returns the checkpoint facts.
 * @throws LogVerificationError naming the failed step's reason code.
 */
export function verifyBundle(root: RootMetadata, manifest: Uint8Array, version: string, bundle: ReleaseLogBundle): VerifiedBundle {
  if (semver.valid(version) === null) {
    // Contract C18 has no code of its own for a version no key can be shown valid for; it is a step 2 failure.
    throw new LogVerificationError('entry-signature-invalid', `release version ${JSON.stringify(version)} is not a semantic version, so no targets key can be shown valid for it`)
  }
  // Contract C2 names the release's manifest file, so a bundle naming another file covers another manifest whatever
  // digest it carries.
  const name = `delorun-${version}.manifest.json`
  if (bundle.manifest.name !== name) {
    throw new LogVerificationError('manifest-digest-mismatch', `the bundle names ${JSON.stringify(bundle.manifest.name)}, not the release's manifest file ${JSON.stringify(name)}`)
  }
  const digest = createHash('sha256').update(manifest).digest('hex')
  if (bundle.manifest.sha256 !== digest) throw new LogVerificationError('manifest-digest-mismatch', `the bundle covers manifest ${bundle.manifest.sha256}, not ${digest}`)
  const body = Buffer.from(bundle.entry.body, 'base64')
  let decoded: unknown
  try {
    decoded = JSON.parse(body.toString('utf8'))
  } catch (error) {
    // A SyntaxError: a body that is not JSON fails the schema check below, which reports it.
    decoded = error
  }
  const parsed = EntryBodySchema.safeParse(decoded)
  const sha512 = createHash('sha512').update(manifest).digest('base64')
  if (!parsed.success || parsed.data.spec.hashedRekordV002.data.algorithm !== RELEASE_LOG_ENTRY_DIGEST_ALGORITHM || parsed.data.spec.hashedRekordV002.data.digest !== sha512) {
    throw new LogVerificationError('manifest-digest-mismatch', 'the log entry is not a Rekor v2 hashedrekord of the manifest\'s SHA-512 digest')
  }
  const { signature } = parsed.data.spec.hashedRekordV002
  if (signature.verifier.keyDetails !== RELEASE_LOG_ENTRY_KEY_DETAILS) {
    throw new LogVerificationError('entry-signature-invalid', `the log entry's key details are ${signature.verifier.keyDetails}, not ${RELEASE_LOG_ENTRY_KEY_DETAILS}`)
  }
  let signerId: string
  let unreadable = ''
  try {
    signerId = keyIdOf(rawPublicKey(createPublicKey({ key: Buffer.from(signature.verifier.publicKey.rawBytes, 'base64'), format: 'der', type: 'spki' })))
  } catch (error) {
    // A key-parsing error: an unreadable public key matches no targets key, and the refusal below names why.
    signerId = ''
    unreadable = error instanceof Error ? error.message : String(error)
  }
  const targets = targetsKeysFor(root, version).find(key => key.keyid === signerId)
  if (targets === undefined || !verifyEd25519ph(targets.key, manifest, Buffer.from(signature.content, 'base64'))) {
    throw new LogVerificationError('entry-signature-invalid', unreadable === ''
      ? 'the log entry has no Ed25519ph signature over the manifest by a targets key valid for the release'
      : `the log entry has no Ed25519ph signature over the manifest by a targets key valid for the release: its verifier key does not parse (${unreadable})`)
  }
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
  if (checkpoint.origin !== root.log.origin || checkpoint.size !== bundle.inclusion.treeSize || checkpoint.rootHash.toString('hex') !== bundle.inclusion.rootHash) {
    throw new LogVerificationError('log-signature-invalid', 'the checkpoint does not name the log\'s origin, the proof\'s tree size and its root hash')
  }
  const log = parseVerifier(root.log.vkey)
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
