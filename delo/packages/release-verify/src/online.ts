/**
 * The online half of contract C18's release-log check (`Consistency with the current log`): fetch the log's latest
 * checkpoint with its witness cosignatures from the witness network's checkpoint distributor, require a valid log
 * signature, the root's threshold of listed cosignatures and a cosigning time within 24 hours, then fetch an RFC 6962
 * consistency proof from the bundle's or the stored checkpoint to that one and verify it. Reaching neither the
 * distributor nor the log is not a failure: the release stays `unchecked` and the check runs again at the next
 * connection. A signature, a cosignature, a rollback or a proof that does not verify is `failed`.
 *
 * This module holds no network code. A caller passes a {@link ReleaseLogTransport}, so a test drives every answer from
 * recorded fixtures and the launcher passes its own transport, which contract C18's owner gates.
 *
 * The root is a precondition, as it is in `bundle.ts`: the caller reads it under contract C2 first, which checks its
 * signature, its `expires` against the clock, and that the log verifier key's name is the log origin.
 *
 * @module @delo/release-verify/online
 */
import { MAX_PROOF_HASHES, MAX_WITNESSED_CHECKPOINT_AGE_SECONDS, WITNESS_THRESHOLD } from '@delo/contract-release-log'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { advanceCheckpoint, storedCheckpoint, type StoredCheckpoint } from './checkpoint.ts'
import { refuse, ReleaseLogRefusalError, type ReleaseLogRefusal } from './errors.ts'
import { verifyConsistencyProof } from './merkle.ts'
import { parseCheckpoint, parseVerifierKey, splitNote, verifySignature } from './note.ts'
import type { VerifiedBundle } from './bundle.ts'

/** The log's latest checkpoint and its consistency proofs, as the online check asks for them. */
export interface ReleaseLogTransport {
  /**
   * The log's latest checkpoint, as the checkpoint distributor serves it: a signed note with the log's signature and
   * the witness cosignatures.
   * @returns the note text.
   */
  latestCheckpoint(): Promise<string>
  /**
   * The RFC 6962 consistency proof from one tree size to another, from the log.
   * @param firstSize - the older tree's size.
   * @param secondSize - the newer tree's size.
   * @returns the proof's hashes, as lowercase hex.
   */
  consistencyProof(firstSize: number, secondSize: number): Promise<readonly string[]>
}

/**
 * What a transport throws when the distributor or the log cannot be reached: a socket error, a timeout, a response that
 * is not served. The check then stays `unchecked`, which contract C18 states is not a failure.
 */
export class LogUnreachableError extends Error {
  override readonly name = 'LogUnreachableError'
}

/** What the online check needs. */
export interface OnlineCheckInput {
  /** The trusted root; it alone names the log and the witnesses. */
  readonly root: RootMetadata
  /** What the offline verification accepted. */
  readonly bundle: VerifiedBundle
  /** The checkpoint the client stored, when it holds one. */
  readonly stored: StoredCheckpoint | undefined
  /** The transport to the distributor and the log. */
  readonly transport: ReleaseLogTransport
  /** The client's clock, in Unix seconds. */
  readonly now: number
}

/** The outcome of the online check. */
export type OnlineVerdict =
  /** The consistency proof verified and the latest checkpoint is the one to store. */
  | { readonly ok: true, readonly checkpoint: StoredCheckpoint }
  /** The distributor or the log was not reachable, or the newest witnessed checkpoint is too old: not a failure. */
  | { readonly ok: false, readonly kind: 'unreachable' | 'stale', readonly detail: string }
  /** A verifiable failure: a signature, a cosignature, a rollback or the proof. */
  | { readonly ok: false, readonly kind: 'failed', readonly refusal: ReleaseLogRefusal, readonly detail: string }

/**
 * The latest checkpoint's verified facts: which witnesses cosigned it and when the newest did.
 * @param root - the trusted root.
 * @param note - the signed note the distributor served.
 * @returns the note's body, its tree size and root hash, and the newest cosigning time.
 * @throws ReleaseLogRefusalError `checkpoint-malformed`, `log-origin-untrusted`, `log-signature-invalid` or
 * `witness-cosignature-missing` when the latest checkpoint does not verify against the trusted root.
 */
function readLatest(root: RootMetadata, note: string): { readonly size: number, readonly rootHash: Buffer, readonly cosigned: number } {
  const split = splitNote(note)
  const checkpoint = parseCheckpoint(split.body)
  if (checkpoint.origin !== root.log.origin) throw refuse('log-origin-untrusted', `the latest checkpoint is for ${JSON.stringify(checkpoint.origin)}, not the trusted root's log ${JSON.stringify(root.log.origin)}`)
  const log = parseVerifierKey(root.log.vkey)
  if (!split.signatures.some(line => verifySignature(log, split.body, line) === true)) throw refuse('log-signature-invalid', 'the latest checkpoint has no valid signature from the trusted root\'s log key')
  const cosigned = new Map<string, number>()
  for (const witness of root.witnesses.keys) {
    const verifier = parseVerifierKey(witness.vkey)
    for (const line of split.signatures) {
      const time = verifySignature(verifier, split.body, line)
      if (typeof time === 'number') cosigned.set(witness.vkey, Math.max(time, cosigned.get(witness.vkey) ?? 0))
    }
  }
  // The contract fixes the client's witness threshold at 1, so a root that carries none requires one cosignature
  // anyway: a threshold of 0 would accept a checkpoint no listed witness ever saw.
  const threshold = Math.max(root.witnesses.threshold, WITNESS_THRESHOLD)
  // `Math.max` of no values is `-Infinity`, which the age check below would read as a cosignature infinitely old; a
  // checkpoint with no valid cosignature is one refusal, taken before any newest cosigning time.
  if (cosigned.size === 0 || cosigned.size < threshold) {
    throw refuse('witness-cosignature-missing', `the latest checkpoint has ${String(cosigned.size)} valid cosignatures from the root's witnesses; ${String(threshold)} are required`)
  }
  return { size: checkpoint.size, rootHash: checkpoint.rootHash, cosigned: Math.max(...cosigned.values()) }
}

/**
 * Run the online check.
 * @param input - the root, the verified bundle, the stored checkpoint, the transport and the clock.
 * @returns the verdict; `unreachable` and `stale` leave the release `unchecked`.
 */
export async function checkOnline(input: OnlineCheckInput): Promise<OnlineVerdict> {
  let note: string
  try {
    note = await input.transport.latestCheckpoint()
  } catch (error) {
    return { ok: false, kind: 'unreachable', detail: `the checkpoint distributor could not be reached (${reasonOf(error)})` }
  }
  let latest: { readonly size: number, readonly rootHash: Buffer, readonly cosigned: number }
  try {
    latest = readLatest(input.root, note)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, kind: 'failed', refusal: error.refusal, detail: error.detail }
    throw error
  }
  const age = input.now - latest.cosigned
  if (age > MAX_WITNESSED_CHECKPOINT_AGE_SECONDS) {
    return { ok: false, kind: 'stale', detail: `the newest witness cosignature is ${String(age)} seconds old, over the ${String(MAX_WITNESSED_CHECKPOINT_AGE_SECONDS)}-second limit` }
  }
  // The stored record may only raise the rollback floor. A record below the bundle's verified tree would let the log
  // serve a tree the bundle already proved larger and the record move backwards (R7), so it is not the tree to prove
  // consistency from: the bundle's verified tree is the floor, and the record counts only when it is at or above it.
  const from = input.stored !== undefined && input.stored.treeSize >= input.bundle.treeSize ? input.stored : undefined
  const fromSize = from?.treeSize ?? input.bundle.treeSize
  const fromRoot = from === undefined ? input.bundle.rootHash : Buffer.from(from.rootHash, 'hex')
  if (latest.size < fromSize) {
    const below = from === undefined ? 'the bundle\'s verified tree' : 'the checkpoint the client stored'
    return { ok: false, kind: 'failed', refusal: 'checkpoint-rolled-back', detail: `the latest checkpoint is tree size ${String(latest.size)}, below ${below} at ${String(fromSize)}` }
  }
  let proof: readonly string[]
  try {
    proof = await input.transport.consistencyProof(fromSize, latest.size)
  } catch (error) {
    return { ok: false, kind: 'unreachable', detail: `the log's consistency proof could not be fetched (${reasonOf(error)})` }
  }
  const hashes = proof.map(hash => Buffer.from(hash, 'hex'))
  if (hashes.length > MAX_PROOF_HASHES) return { ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: `the consistency proof has ${String(hashes.length)} hashes, above the limit of ${String(MAX_PROOF_HASHES)}` }
  if (!verifyConsistencyProof(fromSize, fromRoot, latest.size, latest.rootHash, hashes)) {
    return { ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: `the consistency proof from tree size ${String(fromSize)} to ${String(latest.size)} does not verify` }
  }
  const next = storedCheckpoint(input.root.log.origin, latest.size, latest.rootHash, note, input.now)
  try {
    return { ok: true, checkpoint: advanceCheckpoint(input.stored, next) }
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, kind: 'failed', refusal: error.refusal, detail: error.detail }
    throw error
  }
}

/**
 * The reason a transport failure gives, in words that may reach a warning.
 * @param error - the failure.
 * @returns its message, or a plain one when it has none.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'no reason given'
}
