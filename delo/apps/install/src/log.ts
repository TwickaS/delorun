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
import { parseCheckpoint, parseVerifier, splitNote, verifySignature, type Checkpoint, type NoteSignature } from '@delo/release/log/note'
import type { Downloader } from './download.ts'
import { InstallError, messageOf } from './errors.ts'
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
  /** The log and the distributor. */
  readonly service: LogService
  /** The client's clock in Unix seconds. */
  readonly now: number
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
  try {
    note = await request.service.checkpoint()
  } catch (error) {
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
    proof = await request.service.consistency(from, latest.size)
  } catch (error) {
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
  /** The log shard's tlog-tiles origin, without a trailing slash; its host must be one of {@link TilesLogOptions.hosts}. */
  readonly origin: string
  /**
   * The hosts the release-log check reaches: the log's own origin and the witness network's checkpoint distributor.
   * This list is the log's own; contract C1's release-file hosts are a separate rule and are never widened by it.
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
}

/** Redirects a log answer may follow: the log and its distributor answer directly, so a hop is the exception. */
export const LOG_MAX_REDIRECTS = 2

/**
 * A {@link LogService} over a log shard's C2SP `tlog-tiles` static API: `GET <origin>/checkpoint` for the signed
 * checkpoint and `GET <origin>/proof/consistency?first=<a>&second=<b>` for the proof, whose body is the older size as
 * eight big-endian bytes followed by the hashes, or the hashes alone. The service reads under its own host rule, which
 * names the log and the distributor, so the release-file rule never has to name another service's host.
 * @param options - the shard's origin, the hosts the check reaches, and the downloader.
 * @returns the service.
 * @throws {InstallError} `DOWNLOAD_REFUSED` when the origin is not one of the log's own hosts.
 */
export function createTilesLogService(options: TilesLogOptions): LogService {
  const shard = new URL(options.origin)
  if (!options.hosts.includes(shard.hostname)) {
    throw new InstallError('DOWNLOAD_REFUSED', options.origin, `the log's origin is not one of the log hosts ${options.hosts.join(', ')}`)
  }
  const downloader = options.downloader.withHosts({ scheme: shard.protocol, hosts: options.hosts, maxRedirects: options.maxRedirects ?? LOG_MAX_REDIRECTS })
  const parts = (first: number, second: number): string => `proof/consistency?first=${String(first)}&second=${String(second)}`
  return {
    async checkpoint(): Promise<string> {
      const { bytes } = await downloader.bytes(`${options.origin}/checkpoint`, CHECKPOINT_MAX_BYTES)
      return bytes.toString('utf8')
    },
    async consistency(first: number, second: number): Promise<readonly Uint8Array[]> {
      const { bytes } = await downloader.bytes(`${options.origin}/${parts(first, second)}`, CHECKPOINT_MAX_BYTES)
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
