/**
 * Contract C18's online check, "Consistency with the current log": the launcher fetches the log's latest checkpoint
 * with its witness cosignatures, requires a valid log signature and at least the root's witness threshold of listed
 * cosignatures no older than 24 hours, verifies an RFC 6962 consistency proof from the checkpoint it verified before
 * (the bundle's, or the stored one) to the latest, and stores the latest. An unreachable log or distributor leaves
 * the release `unchecked`, which is not a failure; a bad signature, a missing cosignature, a proof that does not
 * verify or a checkpoint smaller than the stored one is `failed`. An install needs `verified`, so both other states
 * refuse it and the running version stays.
 *
 * @module @delo/install/log
 */
import { MAX_WITNESSED_CHECKPOINT_AGE_SECONDS, type ReleaseLogCheck, type ReleaseLogFailure } from '@delo/contract-release-log'
import type { RootMetadata, SemanticVersion } from '@delo/contract-release-manifest'
import { verifyConsistency } from '@delo/release/log/merkle'
import { parseCheckpoint, parseVerifier, splitNote, verifySignature, type Checkpoint, type NoteSignature } from '@delo/release/log/note'
import type { Downloader } from './download.ts'
import { InstallError } from './errors.ts'
import type { StoredCheckpoint } from './state.ts'

/** The largest checkpoint note read: a body and one signature line per witness. */
export const CHECKPOINT_MAX_BYTES = 64 * 1024

/** Bytes of one hash in a proof. */
const HASH_SIZE = 32

/**
 * The log and the witness network's checkpoint distributor, as the online check asks them. Both answers are the
 * deployment's; the root metadata names the log's origin and key and the witness keys, never a URL.
 */
export interface LogService {
  /**
   * The log's latest checkpoint, in C2SP signed-note form, with its witness cosignature lines.
   * @returns the note text.
   * @throws when the log or the distributor does not answer.
   */
  checkpoint(): Promise<string>

  /**
   * The RFC 6962 consistency proof showing the tree of `first` is a prefix of the tree of `second`.
   * @param first - the older tree size.
   * @param second - the newer tree size, at least `first`.
   * @returns the proof's hashes, oldest subtree first.
   * @throws when the log does not answer.
   */
  consistency(first: number, second: number): Promise<readonly Uint8Array[]>
}

/** What one online check found. */
export interface OnlineCheckResult {
  /** Contract C18's check record for the release. */
  readonly check: ReleaseLogCheck
  /** The latest checkpoint, to store, when the check verified. */
  readonly checkpoint?: StoredCheckpoint
}

/**
 * The record of a check that did not run, which is not a failure.
 * @param release - the release.
 * @param now - the client's clock in Unix seconds.
 * @returns the record, in the `unchecked` state.
 */
function unchecked(release: SemanticVersion, now: number): ReleaseLogCheck {
  return { release, state: 'unchecked', lastAttempt: now }
}

/**
 * The record of a verifiable failure.
 * @param release - the release.
 * @param failure - contract C18's reason code.
 * @param now - the client's clock in Unix seconds.
 * @returns the record, in the `failed` state.
 */
function failed(release: SemanticVersion, failure: ReleaseLogFailure, now: number): ReleaseLogCheck {
  return { release, state: 'failed', failure, lastAttempt: now }
}

/** The listed witnesses that cosigned a checkpoint, and the newest time they give it. */
interface Cosignatures {
  /** How many distinct listed witnesses cosigned. */
  readonly count: number
  /** The newest cosigning time in Unix seconds, or `undefined` when none cosigned. */
  readonly time: number | undefined
}

/**
 * Count the checkpoint's cosignatures from the root's listed witnesses; a key the root does not list counts for
 * nothing (contract C18, `c18-unlisted-witness-refused`).
 * @param root - the trusted root, which lists the witnesses.
 * @param body - the checkpoint body the signatures cover.
 * @param signatures - the note's signature lines.
 * @returns the count and the newest cosigning time.
 */
function cosignatures(root: RootMetadata, body: string, signatures: readonly NoteSignature[]): Cosignatures {
  const times = new Map<string, number>()
  for (const witness of root.witnesses.keys) {
    const verifier = parseVerifier(witness.vkey)
    for (const line of signatures) {
      const time = verifySignature(verifier, body, line)
      if (typeof time === 'number') times.set(witness.vkey, Math.max(time, times.get(witness.vkey) ?? 0))
    }
  }
  return { count: times.size, time: times.size === 0 ? undefined : Math.max(...times.values()) }
}

/** What one online check is given. */
export interface OnlineCheckRequest {
  /** The trusted root, which names the log and the witnesses. */
  readonly root: RootMetadata
  /** The release being installed. */
  readonly release: SemanticVersion
  /** The checkpoint the verified bundle carries. */
  readonly log: { readonly treeSize: number, readonly rootHash: Uint8Array }
  /** The newest checkpoint verified before, when the client stored one. */
  readonly stored?: StoredCheckpoint
  /** The log and the distributor. */
  readonly service: LogService
  /** The client's clock in Unix seconds. */
  readonly now: number
}

/**
 * Run contract C18's online check.
 * @param request - the root, the release, the bundle's checkpoint, the stored one, the service and the clock.
 * @returns the record, and the checkpoint to store when the check verified; an unreachable log gives `unchecked` and a
 *   verifiable failure gives `failed`, so the caller applies {@link requireVerifiedLog} to refuse an install.
 */
export async function runOnlineCheck(request: OnlineCheckRequest): Promise<OnlineCheckResult> {
  const { root, release, now } = request
  let note: string
  try {
    note = await request.service.checkpoint()
  } catch {
    return { check: unchecked(release, now) }
  }
  if (Buffer.byteLength(note) > CHECKPOINT_MAX_BYTES) return { check: failed(release, 'log-signature-invalid', now) }
  let body: string
  let signatures: NoteSignature[]
  let latest: Checkpoint
  try {
    const split = splitNote(note)
    body = split.body
    signatures = split.signatures
    latest = parseCheckpoint(body)
  } catch {
    return { check: failed(release, 'log-signature-invalid', now) }
  }
  if (latest.origin !== root.log.origin) return { check: failed(release, 'log-signature-invalid', now) }
  const log = parseVerifier(root.log.vkey)
  if (!signatures.some(line => verifySignature(log, body, line) === true)) return { check: failed(release, 'log-signature-invalid', now) }
  const cosigned = cosignatures(root, body, signatures)
  if (cosigned.count < root.witnesses.threshold) return { check: failed(release, 'witness-cosignature-missing', now) }
  if (cosigned.time !== undefined && now - cosigned.time > MAX_WITNESSED_CHECKPOINT_AGE_SECONDS) return { check: unchecked(release, now) }
  const stored = request.stored
  const from = Math.max(request.log.treeSize, stored?.treeSize ?? 0)
  const fromRoot = stored !== undefined && stored.treeSize >= request.log.treeSize ? Buffer.from(stored.rootHash, 'hex') : Buffer.from(request.log.rootHash)
  if (latest.size < from) return { check: failed(release, 'checkpoint-rolled-back', now) }
  let proof: readonly Uint8Array[]
  try {
    proof = await request.service.consistency(from, latest.size)
  } catch {
    return { check: unchecked(release, now) }
  }
  if (!verifyConsistency(from, latest.size, fromRoot, latest.rootHash, proof)) {
    return { check: failed(release, 'consistency-proof-invalid', now) }
  }
  return {
    check: { release, state: 'verified', lastAttempt: now },
    checkpoint: { treeSize: latest.size, rootHash: latest.rootHash.toString('hex') },
  }
}

/**
 * Refuse an install whose online check did not verify (contract C18, R3).
 * @param result - what {@link runOnlineCheck} found.
 * @param source - the release the refusal names.
 * @throws {InstallError} `RELEASE_LOG_FAILED` for a verifiable failure, naming C18's reason code; `RELEASE_LOG_UNCHECKED`
 *   when the check could not run.
 */
export function requireVerifiedLog(result: OnlineCheckResult, source: string): void {
  const { check } = result
  if (check.state === 'verified') return
  if (check.state === 'failed') {
    throw new InstallError('RELEASE_LOG_FAILED', source, `the release log failed its check (${check.failure ?? 'unknown'}); nothing was installed`)
  }
  throw new InstallError('RELEASE_LOG_UNCHECKED', source, 'the release log could not be checked, and an install needs a passing online check; nothing was installed')
}

/** What a tlog-tiles log service needs. */
export interface TilesLogOptions {
  /** The log shard's tlog-tiles origin, without a trailing slash. */
  readonly origin: string
  /** The downloader, which applies contract C1's host rule to the log's answers too. */
  readonly downloader: Downloader
}

/**
 * A {@link LogService} over a log shard's C2SP `tlog-tiles` static API: `GET <origin>/checkpoint` for the signed
 * checkpoint and `GET <origin>/proof/consistency?first=<a>&second=<b>` for the proof, whose body is the older size as
 * eight big-endian bytes followed by the hashes, or the hashes alone.
 * @param options - the shard's origin and the downloader.
 * @returns the service.
 */
export function createTilesLogService(options: TilesLogOptions): LogService {
  const parts = (first: number, second: number): string => `proof/consistency?first=${String(first)}&second=${String(second)}`
  return {
    async checkpoint(): Promise<string> {
      const { bytes } = await options.downloader.bytes(`${options.origin}/checkpoint`, CHECKPOINT_MAX_BYTES)
      return bytes.toString('utf8')
    },
    async consistency(first: number, second: number): Promise<readonly Uint8Array[]> {
      const { bytes } = await options.downloader.bytes(`${options.origin}/${parts(first, second)}`, CHECKPOINT_MAX_BYTES)
      const offset = bytes.byteLength % HASH_SIZE === 8 && bytes.readBigUInt64BE(0) === BigInt(first) ? 8 : 0
      if ((bytes.byteLength - offset) % HASH_SIZE !== 0) {
        throw new InstallError('DOWNLOAD_FAILED', options.origin, `the consistency proof has ${String(bytes.byteLength)} bytes, which is not a list of ${String(HASH_SIZE)}-byte hashes`)
      }
      const hashes: Uint8Array[] = []
      for (let at = offset; at < bytes.byteLength; at += HASH_SIZE) hashes.push(bytes.subarray(at, at + HASH_SIZE))
      return hashes
    },
  }
}
