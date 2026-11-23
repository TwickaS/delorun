/**
 * The online half of contract C18's release-log check (`Consistency with the current log`): fetch the log's latest
 * checkpoint with its witness cosignatures, verify the log's signature, refuse a listed witness's cosignature that is
 * present and does not verify, then verify an RFC 6962 consistency proof from the bundle's or the stored checkpoint to the latest one.
 *
 * The rule that sorts every outcome: an answer before any signed data is `unchecked`, and once the checkpoint's log
 * signature verifies, anything that does not hold together is `failed`. So no answer, a timeout, a `5xx`, a `404` or
 * `410` for the checkpoint, and a body that is not a checkpoint the root's log signed (a proxy's page, another log's
 * note) leave the release `unchecked`; a rollback against the stored checkpoint, a proof that does not verify, a tile
 * the signed size says exists answering `404`, `410` or the wrong length, and an invalid cosignature fail it. A
 * checkpoint the witnesses have not cosigned, whose cosignatures are dated more than
 * {@link COSIGNATURE_CLOCK_SKEW_SECONDS} after the client's clock, or whose newest cosignature is older than 24 hours, leaves the
 * release `unchecked` after the rollback and consistency checks, so leaving the cosignature out avoids neither.
 *
 * The whole check runs under one deadline of {@link ONLINE_CHECK_DEADLINE_SECONDS}; when it passes the release is
 * `unchecked`. A failure of this client's own code is not read as an unreachable log: it is thrown as
 * {@link ReleaseLogInternalError}.
 *
 * This module holds no network code. A caller passes a {@link ReleaseLogTransport}: `transport.ts` builds one over an
 * injected `fetch`, and a test drives every answer from recorded fixtures. The root is a precondition: the caller
 * reads it under contract C2 first.
 *
 * @module @delorun/release-verify/online
 */
import { MAX_PROOF_HASHES, MAX_WITNESSED_CHECKPOINT_AGE_SECONDS, WITNESS_THRESHOLD } from '@delorun/contract-release-log'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { advanceCheckpoint, storedCheckpoint, type StoredCheckpoint } from './checkpoint.ts'
import { refuse, ReleaseLogRefusalError, type ReleaseLogRefusal } from './errors.ts'
import { verifyConsistencyProof } from './merkle.ts'
import { parseCheckpoint, splitNote, trustedLogKeys, verifySignature } from './note.ts'
import type { VerifiedBundle } from './bundle.ts'

/** The log's latest checkpoint and its consistency proofs, as the online check asks for them. */
export interface ReleaseLogTransport {
  /**
   * The log's latest checkpoint: a signed note with the log's signature and the witness cosignatures.
   * @param signal - the check's deadline; a transport stops when it aborts.
   * @returns the note text.
   * @throws LogUnreachableError when the log does not answer with a checkpoint.
   */
  latestCheckpoint(signal: AbortSignal): Promise<string>
  /**
   * The RFC 6962 consistency proof from one tree size to another.
   * @param firstSize - the older tree's size.
   * @param secondSize - the newer tree's size, which a checkpoint the log signed names.
   * @param signal - the check's deadline; a transport stops when it aborts.
   * @returns the proof's hashes, as lowercase hex.
   * @throws LogUnreachableError when the log does not answer; LogContradictionError when it answers wrongly.
   */
  consistencyProof(firstSize: number, secondSize: number, signal: AbortSignal): Promise<readonly string[]>
}

/**
 * How far ahead of the client's clock a witness cosignature may be dated: 5 minutes. A witness cosigns a checkpoint it
 * has seen, never one it will see, so a later date means this machine's clock runs slow or the witness's runs fast; the
 * check does not count such a cosignature and leaves the release `unchecked`. The allowance absorbs small clock differences.
 */
export const COSIGNATURE_CLOCK_SKEW_SECONDS = 300

/** The deadline of one whole online check, every request and redirect included (contract C18). */
export const ONLINE_CHECK_DEADLINE_SECONDS = 90

/** What a transport throws when the log does not answer: a socket error, a timeout, a status that is neither success nor a refusal of the address. */
export class LogUnreachableError extends Error {
  override readonly name = 'LogUnreachableError'
}

/**
 * What a transport throws when the log answers wrongly: a `404` or `410`, an answer larger than its format allows, a
 * tile of the wrong length, a redirect to another host. Before the checkpoint's signature verified it is no more than
 * an answer that is not a checkpoint, so the release stays `unchecked`; for a tile of a signed tree it is `failed`.
 */
export class LogContradictionError extends Error {
  override readonly name = 'LogContradictionError'
}

/** A failure of this client's own code during the online check, which no log answer explains; it fails the check visibly. */
export class ReleaseLogInternalError extends Error {
  override readonly name = 'ReleaseLogInternalError'
}

/** A stored checkpoint of the installer's earlier record format: a tree size and a root hash, with no signed note. */
export interface LegacyCheckpoint {
  /** The tree size the earlier install verified. */
  readonly treeSize: number
  /** Its root hash, lowercase hex. */
  readonly rootHash: string
}

/** What the online check needs. */
export interface OnlineCheckInput {
  /** The trusted root; it alone names the log and the witnesses. */
  readonly root: RootMetadata
  /** What the offline verification accepted. */
  readonly bundle: VerifiedBundle
  /** The checkpoint the client stored, when it holds one. */
  readonly stored: StoredCheckpoint | undefined
  /** A stored checkpoint of the earlier record format, kept as a floor only when the log proves it. */
  readonly legacy?: LegacyCheckpoint
  /** The transport to the log. */
  readonly transport: ReleaseLogTransport
  /** The client's clock, in Unix seconds. */
  readonly now: number
  /** The deadline of the whole check; {@link ONLINE_CHECK_DEADLINE_SECONDS} from now by default. */
  readonly signal?: AbortSignal
}

/** The outcome of the online check. */
export type OnlineVerdict =
  /** The consistency proof verified and the latest checkpoint is the one to store. */
  | { readonly ok: true, readonly checkpoint: StoredCheckpoint, readonly notices: readonly string[] }
  /**
   * Not a failure: the log gave no checkpoint its key signed (`unreachable`), its witnesses have not cosigned it
   * (`unwitnessed`), or the newest cosignature is too old (`stale`).
   */
  | { readonly ok: false, readonly kind: 'unreachable' | 'unwitnessed' | 'stale', readonly detail: string, readonly notices: readonly string[] }
  /** A verifiable failure, once the checkpoint's log signature verified. */
  | { readonly ok: false, readonly kind: 'failed', readonly refusal: ReleaseLogRefusal, readonly detail: string, readonly notices: readonly string[] }

/**
 * The time a message names, as RFC 3339 UTC.
 * @param seconds - Unix seconds.
 * @returns the time text.
 */
function utcText(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
}

/** The latest checkpoint, once the root's log signed it. */
interface Signed {
  /** The note's body. */
  readonly body: string
  /** Its tree size. */
  readonly size: number
  /** Its root hash. */
  readonly rootHash: Buffer
  /** Its signature lines. */
  readonly lines: ReturnType<typeof splitNote>['signatures']
}

/**
 * The latest checkpoint, when it is one the trusted root's log signed.
 * @param root - the trusted root.
 * @param note - what the log answered.
 * @returns the checkpoint, or the reason it is no signed checkpoint.
 * @throws ReleaseLogRefusalError `log-origin-untrusted` when the root's own keys do not read.
 */
function signedCheckpoint(root: RootMetadata, note: string): Signed | string {
  const keys = trustedLogKeys(root)
  let split: ReturnType<typeof splitNote>
  let checkpoint: ReturnType<typeof parseCheckpoint>
  try {
    split = splitNote(note)
    checkpoint = parseCheckpoint(split.body)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return `the log's answer is not a checkpoint (${error.detail})`
    throw error
  }
  if (checkpoint.origin !== root.log.origin) return `the log's answer is a checkpoint of ${JSON.stringify(checkpoint.origin)}, not of the trusted root's log ${JSON.stringify(root.log.origin)}`
  if (!split.signatures.some(line => verifySignature(keys.log, split.body, line) === true)) return 'the log\'s answer carries no valid signature from the trusted root\'s log key'
  return { body: split.body, size: checkpoint.size, rootHash: checkpoint.rootHash, lines: split.signatures }
}

/** The witnesses that cosigned a signed checkpoint. */
interface Cosigners {
  /** Distinct listed witnesses, by raw key, with a valid cosignature that is not dated beyond the clock skew. */
  readonly count: number
  /** The newest counted cosigning time, or `undefined` when none cosigned. */
  readonly newest: number | undefined
  /** One reason per witness whose only valid cosignatures are dated beyond the clock skew, which the check does not count. */
  readonly ahead: readonly string[]
}

/**
 * The listed witnesses' cosignatures of a signed checkpoint. A witness with no line is absent, which is not an error;
 * one whose lines are present and none verifies is refused. A valid cosignature dated more than
 * {@link COSIGNATURE_CLOCK_SKEW_SECONDS} after `now` is not counted and is reported in `ahead`: it cannot be told from
 * this machine's clock running slow, so it leaves the release `unchecked` rather than `failed`.
 * @param root - the trusted root.
 * @param latest - the signed checkpoint.
 * @param now - the client's clock.
 * @returns the cosigners.
 * @throws ReleaseLogRefusalError `witness-cosignature-missing` naming each witness whose cosignature does not verify.
 */
function cosignersOf(root: RootMetadata, latest: Signed, now: number): Cosigners {
  const times = new Map<string, number>()
  const problems: string[] = []
  const ahead: string[] = []
  for (const verifier of trustedLogKeys(root).witnesses) {
    const present = latest.lines.filter(line => line.name === verifier.name && line.keyHash.equals(verifier.keyHash))
    if (present.length === 0) continue
    const verified = present.map(line => verifySignature(verifier, latest.body, line)).filter((time): time is number => typeof time === 'number')
    if (verified.length === 0) {
      problems.push(`the cosignature of witness ${verifier.name} does not verify`)
      continue
    }
    const counted = verified.filter(time => time <= now + COSIGNATURE_CLOCK_SKEW_SECONDS)
    if (counted.length === 0) {
      ahead.push(`the cosignature of witness ${verifier.name} is dated ${utcText(Math.max(...verified))}, more than ${String(COSIGNATURE_CLOCK_SKEW_SECONDS)} seconds after this machine's clock, which reads ${utcText(now)}`)
      continue
    }
    times.set(verifier.raw.toString('hex'), Math.max(...counted))
  }
  if (problems.length > 0) throw refuse('witness-cosignature-missing', problems.join('; '))
  return { count: times.size, newest: times.size === 0 ? undefined : Math.max(...times.values()), ahead }
}

/**
 * Whether a stored checkpoint record is one the trusted root's log signed: its note names the root's log origin and the
 * record's own tree, and carries a valid signature from the root's log key.
 * @param root - the trusted root.
 * @param stored - the stored record.
 * @returns `true` when the record's note is the log's signed checkpoint of the tree the record names.
 */
export function storedCheckpointSigned(root: RootMetadata, stored: StoredCheckpoint): boolean {
  if (stored.origin !== root.log.origin) return false
  const signed = signedCheckpoint(root, stored.checkpoint)
  return typeof signed !== 'string' && signed.size === stored.treeSize && signed.rootHash.toString('hex') === stored.rootHash
}

/**
 * The reason a transport failure gives.
 * @param error - the failure.
 * @returns its message.
 */
function reasonOf(error: Error): string {
  return error.message
}

/**
 * Run one transport call under the check's deadline, sorting what it throws: a deadline that passed and
 * {@link LogUnreachableError} come back as the reason the log was unreachable, {@link LogContradictionError} as itself,
 * and anything else as {@link ReleaseLogInternalError}.
 * @param call - the call.
 * @param signal - the deadline.
 * @returns the call's answer, or the failure.
 * @throws ReleaseLogInternalError for a failure that is not the log's.
 */
async function guarded<T>(call: () => Promise<T>, signal: AbortSignal): Promise<{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: LogUnreachableError | LogContradictionError }> {
  const expired = (): LogUnreachableError => new LogUnreachableError(`the online check passed its deadline of ${String(ONLINE_CHECK_DEADLINE_SECONDS)} seconds`)
  if (signal.aborted) return { ok: false, error: expired() }
  let stop: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    stop = () => { reject(expired()) }
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return { ok: true, value: await Promise.race([call(), deadline]) }
  } catch (error) {
    if (error instanceof LogUnreachableError || error instanceof LogContradictionError) return { ok: false, error }
    throw new ReleaseLogInternalError(`the online check failed in this client: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    signal.removeEventListener('abort', stop!)
  }
}

/**
 * Run the online check.
 * @param input - the root, the verified bundle, the stored checkpoints, the transport, the clock and the deadline.
 * @returns the verdict; `unreachable`, `unwitnessed` and `stale` leave the release `unchecked`.
 * @throws ReleaseLogInternalError when this client's own code fails during the check.
 */
export async function checkOnline(input: OnlineCheckInput): Promise<OnlineVerdict> {
  const signal = input.signal ?? AbortSignal.timeout(ONLINE_CHECK_DEADLINE_SECONDS * 1000)
  const notices: string[] = []
  // A bundle that verified in an earlier log the root lists is not checked against the current log, which holds no
  // entry of it: the release stays `unchecked` until it updates to a release logged in the current log.
  if (input.bundle.checkpoint.origin !== input.root.log.origin) {
    return { ok: false, kind: 'unreachable', detail: `the release is logged in ${JSON.stringify(input.bundle.checkpoint.origin)}, an earlier log the trusted root lists, and the online check reads only the current log ${JSON.stringify(input.root.log.origin)}`, notices }
  }
  const answer = await guarded(() => input.transport.latestCheckpoint(signal), signal)
  if (!answer.ok) return { ok: false, kind: 'unreachable', detail: `the release log gave no checkpoint (${reasonOf(answer.error)})`, notices }
  const note = answer.value
  let latest: Signed | string
  try {
    latest = signedCheckpoint(input.root, note)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, kind: 'failed', refusal: error.refusal, detail: error.detail, notices }
    throw error
  }
  if (typeof latest === 'string') return { ok: false, kind: 'unreachable', detail: latest, notices }
  let cosigners: Cosigners
  try {
    cosigners = cosignersOf(input.root, latest, input.now)
  } catch (error) {
    if (error instanceof ReleaseLogRefusalError) return { ok: false, kind: 'failed', refusal: error.refusal, detail: error.detail, notices }
    throw error
  }
  const proofOf = async (fromSize: number, fromRoot: Buffer): Promise<OnlineVerdict | 'verified'> => {
    const proof = await guarded(() => input.transport.consistencyProof(fromSize, latest.size, signal), signal)
    if (!proof.ok) {
      if (proof.error instanceof LogContradictionError) return { ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: proof.error.message, notices }
      return { ok: false, kind: 'unreachable', detail: `the log's consistency proof could not be read (${reasonOf(proof.error)})`, notices }
    }
    const hashes = proof.value.map(hash => Buffer.from(hash, 'hex'))
    if (hashes.length > MAX_PROOF_HASHES) return { ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: `the consistency proof has ${String(hashes.length)} hashes, above the limit of ${String(MAX_PROOF_HASHES)}`, notices }
    if (!verifyConsistencyProof(fromSize, fromRoot, latest.size, latest.rootHash, hashes)) {
      return { ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: `the consistency proof from tree size ${String(fromSize)} to ${String(latest.size)} does not verify`, notices }
    }
    return 'verified'
  }
  // A stored record counts only when the trusted root's log signed it: a record no trusted key signed sets no floor.
  const stored = input.stored !== undefined && storedCheckpointSigned(input.root, input.stored) ? input.stored : undefined
  if (input.stored !== undefined && stored === undefined) notices.push(`the stored checkpoint of tree size ${String(input.stored.treeSize)} is not one the trusted root's log signed, so it sets no floor and is replaced`)
  // The floor is the larger of the bundle's verified tree and the signed stored record; a record below the bundle's
  // tree would let the log serve a tree the bundle already proved larger and the record move backwards (R7).
  let fromSize = input.bundle.treeSize
  let fromRoot = input.bundle.rootHash
  if (stored !== undefined && stored.treeSize >= fromSize) {
    fromSize = stored.treeSize
    fromRoot = Buffer.from(stored.rootHash, 'hex')
  }
  if (latest.size < fromSize) {
    const below = stored !== undefined && stored.treeSize >= input.bundle.treeSize ? 'the checkpoint the client stored' : 'the bundle\'s verified tree'
    return { ok: false, kind: 'failed', refusal: 'checkpoint-rolled-back', detail: `the latest checkpoint is tree size ${String(latest.size)}, below ${below} at ${String(fromSize)}`, notices }
  }
  // A stored record below the bundle's tree is no floor, but it still has to be a prefix of the log's latest tree: a
  // log that forked after the stored size would otherwise go unnoticed, since the bundle's tree is the only one proved.
  if (stored !== undefined && stored.treeSize > 0 && stored.treeSize < input.bundle.treeSize) {
    const prefix = await proofOf(stored.treeSize, Buffer.from(stored.rootHash, 'hex'))
    if (prefix !== 'verified') return prefix
  }
  // A record of the installer's earlier format carries no signature: it is kept as the floor only when the log proves
  // the tree it names a prefix of the latest one, and replaced with a notice otherwise.
  if (input.legacy !== undefined && input.legacy.treeSize > fromSize) {
    const legacyRoot = Buffer.from(input.legacy.rootHash, 'hex')
    const legacy = input.legacy.treeSize > latest.size ? 'beyond' : await proofOf(input.legacy.treeSize, legacyRoot)
    if (legacy === 'verified') {
      fromSize = input.legacy.treeSize
      fromRoot = legacyRoot
    } else if (legacy === 'beyond' || (!legacy.ok && legacy.kind === 'failed')) {
      notices.push(`the checkpoint an earlier install stored, tree size ${String(input.legacy.treeSize)}, could not be proved against the log's latest checkpoint, so it sets no floor and is replaced`)
    } else {
      return legacy
    }
  }
  const verdict = await proofOf(fromSize, fromRoot)
  if (verdict !== 'verified') return verdict
  // The contract fixes the client's witness threshold at 1, so a root that carries none still needs one cosignature.
  const threshold = Math.max(input.root.witnesses.threshold, WITNESS_THRESHOLD)
  if (cosigners.newest === undefined || cosigners.count < threshold) {
    const counted = `the latest checkpoint has ${String(cosigners.count)} of the ${String(threshold)} witness cosignatures a check needs`
    return { ok: false, kind: 'unwitnessed', detail: cosigners.ahead.length === 0 ? counted : `${counted}; ${cosigners.ahead.join('; ')}`, notices }
  }
  const age = input.now - cosigners.newest
  if (age > MAX_WITNESSED_CHECKPOINT_AGE_SECONDS) {
    return { ok: false, kind: 'stale', detail: `the newest witness cosignature is ${String(age)} seconds old, over the ${String(MAX_WITNESSED_CHECKPOINT_AGE_SECONDS)}-second limit`, notices }
  }
  // The checks above leave no tree below the stored one and no other root at its size, so this advance never refuses.
  return { ok: true, checkpoint: advanceCheckpoint(stored, storedCheckpoint(input.root.log.origin, latest.size, latest.rootHash, note, input.now)), notices }
}
