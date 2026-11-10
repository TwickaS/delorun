/**
 * Contract C18's online check, "Consistency with the current log": the launcher fetches the log's latest checkpoint
 * with its witness cosignatures, requires a valid log signature and at least the root's witness threshold of listed
 * cosignatures no older than 24 hours, verifies an RFC 6962 consistency proof from the checkpoint it verified before
 * (the bundle's, or the stored one) to the latest, and stores the latest. A log or distributor that does not answer, a
 * latest checkpoint that no listed witness has cosigned, and a newest cosignature older than 24 hours leave the release
 * `unchecked`, which is not a failure. A log or witness that answers and contradicts the release is `failed`: a bad
 * signature on the checkpoint, a cosignature from a listed witness that does not verify or is dated in the future, a
 * proof that does not verify, or a checkpoint smaller than the stored one. An install goes on from `unchecked` with a
 * warning and a record that the check did not run, and refuses a `failed` check (contract C18, "Behaviour per client").
 *
 * @module @delo/install/log
 */
import { MAX_WITNESSED_CHECKPOINT_AGE_SECONDS, type ReleaseLogCheck, type ReleaseLogFailure } from '@delo/contract-release-log'
import type { RootMetadata, SemanticVersion } from '@delo/contract-release-manifest'
import { verifyConsistency } from '@delo/release/log/merkle'
import { consistencyProofFromTiles, TileError } from '@delo/release/log/tiles'
import { parseCheckpoint, parseVerifier, splitNote, verifySignature, type Checkpoint, type NoteSignature } from '@delo/release/log/note'
import type { Downloader } from './download.ts'
import { InstallError, isInstallError, messageOf } from './errors.ts'
import type { StoredCheckpoint } from './state.ts'

/** The largest checkpoint note read: a body and one signature line per witness. */
export const CHECKPOINT_MAX_BYTES = 64 * 1024

/**
 * A log answer that does not hold together: a checkpoint the log does not serve at the address the client constructs, an
 * answer over its size limit or from a host outside the log's hosts, or a tile that the log's own checkpoint says exists
 * but the log does not serve or serves at the wrong length. It is the log (or the address it was given) that is wrong,
 * not the network, so the online check treats it as `failed`, never as `unchecked`.
 */
export class LogContradiction extends Error {
  override readonly name = 'LogContradiction'
}

/** How long the online check waits in all for one call of the log service, in milliseconds, before it counts the log as unreachable. */
export const LOG_CHECK_DEADLINE_MS = 90_000

/** How long one request to the log may take in all, in milliseconds (contract C18: 30 seconds). */
export const LOG_REQUEST_DEADLINE_MS = 30_000

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
  /** Why the check did not run, or what it found wrong when it failed. */
  readonly detail?: string
}

/**
 * The result of a check that did not run, which is not a failure.
 * @param release - the release.
 * @param now - the client's clock in Unix seconds.
 * @param detail - why the check could not run.
 * @returns the record, in the `unchecked` state, with the reason.
 */
function unchecked(release: SemanticVersion, now: number, detail: string): OnlineCheckResult {
  return { check: { release, state: 'unchecked', lastAttempt: now }, detail }
}

/**
 * The result of a verifiable failure.
 * @param release - the release.
 * @param failure - contract C18's reason code.
 * @param now - the client's clock in Unix seconds.
 * @param detail - what the log or witness answered that contradicts the release.
 * @returns the record, in the `failed` state, with what was found.
 */
function failed(release: SemanticVersion, failure: ReleaseLogFailure, now: number, detail: string): OnlineCheckResult {
  return { check: { release, state: 'failed', failure, lastAttempt: now }, detail }
}

/** How far ahead of the client's clock a cosignature's time may be before it is refused, in seconds. */
export const COSIGNATURE_CLOCK_SKEW_SECONDS = 300

/** The listed witnesses that cosigned a checkpoint, and what is wrong with the cosignatures that are present. */
interface Cosignatures {
  /** How many distinct listed witnesses cosigned with a cosignature that verifies and is not dated in the future. */
  readonly count: number
  /** The newest cosigning time in Unix seconds, or `undefined` when none cosigned. */
  readonly time: number | undefined
  /** One sentence per listed witness whose cosignature is present and does not verify or is dated in the future. */
  readonly problems: readonly string[]
}

/**
 * Read the checkpoint's cosignatures from the root's listed witnesses. A key the root does not list counts for nothing
 * (contract C18, `c18-unlisted-witness-refused`). A listed witness that has not cosigned is absent, which is not a
 * problem; one whose cosignature is present but does not verify, or is dated more than
 * {@link COSIGNATURE_CLOCK_SKEW_SECONDS} after the client's clock, is a problem.
 * @param root - the trusted root, which lists the witnesses.
 * @param body - the checkpoint body the signatures cover.
 * @param signatures - the note's signature lines.
 * @param now - the client's clock in Unix seconds.
 * @returns the count, the newest cosigning time and the problems.
 */
function cosignatures(root: RootMetadata, body: string, signatures: readonly NoteSignature[], now: number): Cosignatures {
  const times = new Map<string, number>()
  const problems: string[] = []
  for (const witness of root.witnesses.keys) {
    const verifier = parseVerifier(witness.vkey)
    const present = signatures.filter(line => line.name === verifier.name && line.keyHash.equals(verifier.keyHash))
    if (present.length === 0) continue
    const verified = present.map(line => verifySignature(verifier, body, line)).filter((time): time is number => typeof time === 'number')
    if (verified.length === 0) {
      problems.push(`the cosignature of witness ${verifier.name} does not verify`)
      continue
    }
    const newest = Math.max(...verified)
    if (newest > now + COSIGNATURE_CLOCK_SKEW_SECONDS) {
      problems.push(`the cosignature of witness ${verifier.name} is dated ${String(newest - now)} seconds after this computer's clock`)
      continue
    }
    times.set(witness.vkey, newest)
  }
  return { count: times.size, time: times.size === 0 ? undefined : Math.max(...times.values()), problems }
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
  /** The log. */
  readonly service: LogService
  /** The client's clock in Unix seconds. */
  readonly now: number
  /** How long to wait in all for one call of the service; {@link LOG_CHECK_DEADLINE_MS} by default. */
  readonly deadlineMs?: number
}

/**
 * Wait for a log call at most a deadline.
 * @param call - the call.
 * @param deadlineMs - the deadline in milliseconds.
 * @returns what the call answers.
 * @throws Error when the deadline passes first, which counts the log as unreachable.
 */
async function within<T>(call: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`no answer within ${String(deadlineMs)} ms`)) }, deadlineMs)
  })
  try {
    return await Promise.race([call, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run contract C18's online check.
 * @param request - the root, the release, the bundle's checkpoint, the stored one, the service and the clock.
 * @returns the record, and the checkpoint to store when the check verified; an unreachable log or an uncosigned or stale
 *   checkpoint gives `unchecked` and a verifiable contradiction gives `failed`, so the caller applies {@link refuseFailedLog} to refuse an install.
 */
export async function runOnlineCheck(request: OnlineCheckRequest): Promise<OnlineCheckResult> {
  const { root, release, now } = request
  let note: string
  const deadline = request.deadlineMs ?? LOG_CHECK_DEADLINE_MS
  try {
    note = await within(request.service.checkpoint(), deadline)
  } catch (error) {
    if (error instanceof LogContradiction) return failed(release, 'log-signature-invalid', now, error.message)
    return unchecked(release, now, `the release log did not answer: ${messageOf(error)}`)
  }
  if (Buffer.byteLength(note) > CHECKPOINT_MAX_BYTES) return failed(release, 'log-signature-invalid', now, `the latest checkpoint is larger than ${String(CHECKPOINT_MAX_BYTES)} bytes`)
  let body: string
  let signatures: NoteSignature[]
  let latest: Checkpoint
  try {
    const split = splitNote(note)
    body = split.body
    signatures = split.signatures
    latest = parseCheckpoint(body)
  } catch (error) {
    return failed(release, 'log-signature-invalid', now, `the latest checkpoint does not read: ${messageOf(error)}`)
  }
  if (latest.origin !== root.log.origin) return failed(release, 'log-signature-invalid', now, `the latest checkpoint is for ${latest.origin}, not the log the root names`)
  const log = parseVerifier(root.log.vkey)
  if (!signatures.some(line => verifySignature(log, body, line) === true)) return failed(release, 'log-signature-invalid', now, 'the latest checkpoint carries no valid signature of the log')
  const cosigned = cosignatures(root, body, signatures, now)
  if (cosigned.problems.length > 0) return failed(release, 'witness-cosignature-missing', now, cosigned.problems.join('; '))
  const stored = request.stored
  const from = Math.max(request.log.treeSize, stored?.treeSize ?? 0)
  const fromRoot = stored !== undefined && stored.treeSize >= request.log.treeSize ? Buffer.from(stored.rootHash, 'hex') : Buffer.from(request.log.rootHash)
  if (latest.size < from) return failed(release, 'checkpoint-rolled-back', now, `the latest checkpoint has ${String(latest.size)} entries, fewer than the ${String(from)} already verified`)
  let proof: readonly Uint8Array[]
  try {
    proof = await within(request.service.consistency(from, latest.size), deadline)
  } catch (error) {
    if (error instanceof LogContradiction) return failed(release, 'consistency-proof-invalid', now, error.message)
    return unchecked(release, now, `the release log gave no consistency proof: ${messageOf(error)}`)
  }
  if (!verifyConsistency(from, latest.size, fromRoot, latest.rootHash, proof)) {
    return failed(release, 'consistency-proof-invalid', now, `the consistency proof from ${String(from)} to ${String(latest.size)} entries does not verify`)
  }
  if (cosigned.count < root.witnesses.threshold) {
    return unchecked(release, now, `the latest checkpoint has ${String(cosigned.count)} of the ${String(root.witnesses.threshold)} witness cosignatures a check needs`)
  }
  if (cosigned.time !== undefined && now - cosigned.time > MAX_WITNESSED_CHECKPOINT_AGE_SECONDS) {
    return unchecked(release, now, `the log's newest witnessed checkpoint is ${String(Math.floor((now - cosigned.time) / 3600))} hours old, and a check needs one from the last ${String(MAX_WITNESSED_CHECKPOINT_AGE_SECONDS / 3600)} hours`)
  }
  return {
    check: { release, state: 'verified', lastAttempt: now },
    checkpoint: { treeSize: latest.size, rootHash: latest.rootHash.toString('hex') },
  }
}

/**
 * Refuse an install whose online check failed verifiably (contract C18, R3). A check that did not run is not refused
 * here: the install continues on the release's signature, and the caller warns and records the outcome.
 * @param result - what {@link runOnlineCheck} found.
 * @param source - the release the refusal names.
 * @throws {InstallError} `RELEASE_LOG_FAILED`, naming C18's reason code, when the log answered and contradicts the
 *   release.
 */
export function refuseFailedLog(result: OnlineCheckResult, source: string): void {
  const { check } = result
  if (check.state !== 'failed') return
  throw new InstallError('RELEASE_LOG_FAILED', source, `the release log failed its check (${check.failure ?? 'unknown'}${result.detail === undefined ? '' : `: ${result.detail}`}); nothing was installed`)
}

/** What a tlog-tiles log service needs. */
export interface TilesLogOptions {
  /**
   * The log's tlog-tiles prefix, without a trailing slash: the URL below which it serves `checkpoint` and `tile/...`.
   * Its host must be one of {@link TilesLogOptions.hosts}.
   */
  readonly origin: string
  /**
   * The hosts the release-log check reaches, which is the log's own host. This list is the log's own; contract C1's
   * release-file hosts are a separate rule and are never widened by it.
   */
  readonly hosts: readonly string[]
  /**
   * The downloader whose fetch, timings and size limit the log reads through. Its host rule is replaced by
   * {@link TilesLogOptions.hosts}, so the log's answers never travel under the release-file rule and the release files
   * never travel under the log's.
   */
  readonly downloader: Downloader
  /** Redirects followed before a log answer is refused; {@link LOG_MAX_REDIRECTS} by default. */
  readonly maxRedirects?: number
  /** How long one request may take in all, in milliseconds; {@link LOG_REQUEST_DEADLINE_MS} by default. */
  readonly requestDeadlineMs?: number
}

/** Redirects a log answer may follow: the log answers directly, so a hop is the exception. */
export const LOG_MAX_REDIRECTS = 2

/** The size of a full tile: 256 hashes of 32 bytes. */
const TILE_MAX_BYTES = 256 * 32

/**
 * The log's answer as a failure, when the log answered wrongly; any other failure is the network's and passes on.
 * @param error - what the request threw.
 * @param what - the thing asked for, for the message.
 * @returns the {@link LogContradiction} for an answer from outside the log's hosts, over its size limit, or `404` or
 *   `410` for something the log must serve; the error itself otherwise.
 */
function answerOf(error: unknown, what: string): unknown {
  if (!isInstallError(error)) return error
  if (error.code === 'DOWNLOAD_REFUSED') return new LogContradiction(`the answer for ${what} is refused: ${error.detail}`)
  if (error.oversize) return new LogContradiction(`the answer for ${what} is larger than the log's format allows: ${error.detail}`)
  if (error.status === 404 || error.status === 410) return new LogContradiction(`the log answered ${String(error.status)} for ${what}`)
  return error
}

/**
 * A {@link LogService} over a log's C2SP `tlog-tiles` static API: `GET <origin>/checkpoint` for the signed checkpoint with
 * its witness cosignatures, and `GET <origin>/tile/<L>/<N>[.p/<W>]` for the Merkle tree's tiles, from which the consistency
 * proof is computed (the API has no proof endpoint). The service reads under its own host rule, which names the log's
 * host, so the release-file rule never has to name another service's host. Each request has a total deadline of
 * {@link LOG_REQUEST_DEADLINE_MS}.
 * @param options - the log's prefix, its hosts, and the downloader.
 * @returns the service.
 * @throws {InstallError} `DOWNLOAD_REFUSED` when the origin is not one of the log's own hosts.
 */
export function createTilesLogService(options: TilesLogOptions): LogService {
  const shard = new URL(options.origin)
  if (!options.hosts.includes(shard.hostname)) {
    throw new InstallError('DOWNLOAD_REFUSED', options.origin, `the log's origin is not one of the log hosts ${options.hosts.join(', ')}`)
  }
  const downloader = options.downloader.withHosts({ scheme: shard.protocol, hosts: options.hosts, maxRedirects: options.maxRedirects ?? LOG_MAX_REDIRECTS }, { totalMs: options.requestDeadlineMs ?? LOG_REQUEST_DEADLINE_MS })
  return {
    async checkpoint(): Promise<string> {
      try {
        return (await downloader.bytes(`${options.origin}/checkpoint`, CHECKPOINT_MAX_BYTES)).bytes.toString('utf8')
      } catch (error) {
        throw answerOf(error, 'its checkpoint')
      }
    },
    async consistency(first: number, second: number): Promise<readonly Uint8Array[]> {
      const tile = async (path: string): Promise<Uint8Array | undefined> => {
        try {
          return (await downloader.bytes(`${options.origin}/${path}`, TILE_MAX_BYTES)).bytes
        } catch (error) {
          // A partial tile that a log deleted once its full tile exists answers 404, and the proof then reads the full tile.
          if (isInstallError(error) && (error.status === 404 || error.status === 410)) return undefined
          throw answerOf(error, path)
        }
      }
      try {
        return await consistencyProofFromTiles(first, second, tile)
      } catch (error) {
        if (error instanceof TileError) throw new LogContradiction(`the log's checkpoint says it holds ${String(second)} entries, but ${error.message}`)
        throw error
      }
    },
  }
}
