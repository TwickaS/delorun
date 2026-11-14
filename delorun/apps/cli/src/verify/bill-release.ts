/**
 * The release and release-log sections of a trust bill ([bill](./bill.ts)): the running release's version, the commit
 * and the SHA-256 values its stored manifest names, the trusted root and how it was anchored, the launcher that started
 * the runtime, the launcher's start check, and the release-log state the home recorded. Each reader turns its own
 * failure into a `null` value, an `unknown` result or an `unknown` state with the reason, so one unreadable file never
 * hides the others. Nothing here hashes a runtime file or contacts the network: the stored manifest is read, its size
 * limited and its signature verified under the anchored root, which is the same offline work a start does.
 *
 * @module @delorun/cli/verify/bill-release
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DELORUN_LAUNCHER_ROOTS_ENV, DELORUN_START_CHECK_ENV, type RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_FILE_SIZE_LIMITS, RUNTIME_PLATFORMS } from '@delorun/contract-release-manifest'
import type { TrustCheckResult, TrustRelease, TrustReleaseLog, TrustStartCheck } from '@delorun/bundle-local/trust-bill'
import { verifySignedManifest } from '@delorun/release-formats/sign/verify'
import { readCheckRecords, type RecordedCheck } from '@delorun/release-verify'
import { parseStartCheckHandoff, StorePaths, type StartCheckHandoff } from '@delorun/runtime-store'
import { anchoredRoot, boundedDetail, utcText, type Part, type RootAnchor } from './checks.ts'

/** What the release readers take from the bill's context. */
export interface ReleaseReadContext {
  /** The resolved Delorun home. */
  readonly home: string
  /** `<process.platform>-<process.arch>`. */
  readonly platform: string
  /** The environment, read for `DELORUN_START_CHECK` and `DELORUN_LAUNCHER_ROOTS`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The clock, in Unix seconds. */
  readonly now: number
}

/** What the stored manifest of a release says, as far as it verified. */
export interface ReleaseIdentity {
  /** The root the read anchored on; `undefined` when none read. */
  readonly anchor: RootAnchor | undefined
  /** The commit the verified manifest names; `null` when none verified. */
  readonly commit: string | null
  /** The SHA-256 of the verified manifest's bytes; `null` when none verified. */
  readonly manifestSha256: string | null
  /** The SHA-256 of this platform's file list the verified manifest names; `null` when none verified. */
  readonly fileListSha256: string | null
  /** The root and manifest parts: `fail` for a verifiable refusal, `unknown` for a file that is not there. */
  readonly part: Part
}

/**
 * The words a failure gives.
 * @param error - the failure.
 * @returns its message on one line, or the value's text for a non-`Error`.
 */
export function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/gu, ' ')
}

/**
 * Whether a failure is a missing file.
 * @param error - the failure.
 * @returns `true` for `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The combined result of several parts: `fail` when any failed, `unknown` when none failed and one is unknown, `pass`
 * otherwise; the detail names the parts that decided it.
 * @param parts - the parts.
 * @returns the combined part.
 */
export function combineParts(parts: readonly Part[]): Part {
  for (const result of ['fail', 'unknown'] as const) {
    const deciding = parts.filter(part => part.result === result)
    if (deciding.length > 0) return { result, detail: deciding.map(part => part.detail).join('; ') }
  }
  return { result: 'pass', detail: parts.map(part => part.detail).join('; ') }
}

/**
 * Read the release's identity from the home: the trusted root anchored as `delorun verify` anchors it, and the stored
 * manifest verified under it. Nothing is hashed but the manifest's own bytes.
 * @param context - the home, the platform, the environment and the clock.
 * @param release - the release.
 * @returns the identity, with the part that says how far it verified.
 */
export async function readReleaseIdentity(context: ReleaseReadContext, release: RuntimeVersion): Promise<ReleaseIdentity> {
  const none = { commit: null, manifestSha256: null, fileListSha256: null }
  const platform = RUNTIME_PLATFORMS.find(candidate => candidate === context.platform)
  if (platform === undefined) return { anchor: undefined, ...none, part: { result: 'unknown', detail: `Delorun publishes no runtime for ${context.platform}` } }
  const rooted = await anchoredRoot({ home: context.home, launcherRoots: context.env[DELORUN_LAUNCHER_ROOTS_ENV], now: context.now })
  if ('refused' in rooted) return { anchor: undefined, ...none, part: rooted.refused }
  const anchorPart: Part = rooted.anchor.anchored === 'shipped'
    ? { result: 'pass', detail: `trusted root ${String(rooted.anchor.version)} is anchored on the launcher's shipped roots` }
    : { result: 'unknown', detail: `trusted root ${String(rooted.anchor.version)} is checked against its own signatures only, because ${String(rooted.anchor.reason)}` }
  const path = new StorePaths(context.home, platform).releaseFiles(release).manifest
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    const part: Part = isMissing(error) ? { result: 'unknown', detail: `release ${release} has no stored manifest at ${path}` } : { result: 'fail', detail: `the signed manifest ${path} cannot be read: ${reasonOf(error)}` }
    return { anchor: rooted.anchor, ...none, part: combineParts([anchorPart, rooted.expiry, part]) }
  }
  if (bytes.byteLength > RELEASE_FILE_SIZE_LIMITS.manifest) return { anchor: rooted.anchor, ...none, part: combineParts([anchorPart, rooted.expiry, { result: 'fail', detail: `the signed manifest ${path} is above its size limit` }]) }
  try {
    const manifest = verifySignedManifest(rooted.root.metadata, bytes)
    if (manifest.version !== String(release)) throw new Error(`the stored manifest is release ${manifest.version}, not ${release}`)
    return {
      anchor: rooted.anchor,
      commit: manifest.source.commit,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      fileListSha256: manifest.runtime[platform]?.files.sha256 ?? null,
      part: combineParts([anchorPart, rooted.expiry, { result: 'pass', detail: 'the manifest\'s targets signature verifies' }]),
    }
  } catch (error) {
    return { anchor: rooted.anchor, ...none, part: combineParts([anchorPart, rooted.expiry, { result: 'fail', detail: `the manifest of release ${release} does not verify with the trusted root: ${reasonOf(error)}` }]) }
  }
}

/**
 * The launcher's handoff for a release: the record in `DELORUN_START_CHECK`, when it reads and names that release.
 * @param env - the environment.
 * @param release - the release the bill describes.
 * @returns the handoff, or `undefined` when it is unset, does not read or names another release.
 */
export function handoffFor(env: Readonly<Record<string, string | undefined>>, release: string): StartCheckHandoff | undefined {
  const handoff = parseStartCheckHandoff(env[DELORUN_START_CHECK_ENV])
  return handoff?.release === release ? handoff : undefined
}

/**
 * A time in milliseconds as RFC 3339 UTC to the second.
 * @param milliseconds - milliseconds since the epoch.
 * @returns the time text.
 */
export function utcMillisText(milliseconds: number): string {
  return utcText(Math.floor(milliseconds / 1000))
}

/**
 * The start check the launcher handed over.
 * @param handoff - the handoff, when one names the release.
 * @returns the bill's start check, or `null` without a handoff.
 */
function startCheckOf(handoff: StartCheckHandoff | undefined): TrustStartCheck | null {
  if (handoff === undefined) return null
  return { at: utcMillisText(handoff.at), full: handoff.full, hashed: handoff.hashed, files: handoff.files }
}

/** How the release section's signature and files results were reached. */
export interface ReleaseResults {
  readonly signature: TrustCheckResult
  readonly files: TrustCheckResult
  /** What failed or could not run; absent when both passed. */
  readonly detail?: string
  /** When every runtime file was last hashed, RFC 3339 UTC; `null` when unknown. */
  readonly lastFullHashAt: string | null
}

/**
 * The start stage's results: the launcher's start check verified the manifest and file list signatures under the
 * anchored root and the files, so a handoff naming the release is `pass` for both; without one both are `unknown`. A
 * root or manifest that verifiably fails now is a `fail` of the signature whatever the handoff says.
 * @param identity - the release's identity as read now.
 * @param handoff - the launcher's handoff, when one names the release.
 * @returns the results.
 */
export function startResults(identity: ReleaseIdentity, handoff: StartCheckHandoff | undefined): ReleaseResults {
  const started: Part = handoff === undefined
    ? { result: 'unknown', detail: 'no start check of this release was handed over by the launcher' }
    : { result: 'pass', detail: 'the launcher\'s start check passed' }
  const signature = combineParts([started, identity.part])
  const lastFullHashAt = handoff?.fullCheckAt === null || handoff === undefined ? null : utcMillisText(handoff.fullCheckAt)
  const detail = signature.result === 'pass' && started.result === 'pass' ? undefined : boundedDetail(signature.result === 'pass' ? started.detail : signature.detail)
  return { signature: signature.result, files: started.result, ...detail === undefined ? {} : { detail }, lastFullHashAt }
}

/**
 * The release section.
 * @param context - the environment.
 * @param version - the release's version.
 * @param identity - its identity as read now.
 * @param handoff - the launcher's handoff, when one names the release.
 * @param results - the signature and files results.
 * @returns the section.
 */
export function releaseSection(context: Pick<ReleaseReadContext, 'env'>, version: string, identity: Omit<ReleaseIdentity, 'part'>, handoff: StartCheckHandoff | undefined, results: ReleaseResults): TrustRelease {
  const roots = context.env[DELORUN_LAUNCHER_ROOTS_ENV]
  const launcher = handoff === undefined
    ? { version: null, path: roots === undefined || roots === '' ? null : dirname(roots) }
    : { version: handoff.launcher.version, path: handoff.launcher.path }
  const root = identity.anchor === undefined ? null : { version: identity.anchor.version, keyIds: [...identity.anchor.keyids], anchored: identity.anchor.anchored }
  return {
    version,
    commit: identity.commit,
    manifestSha256: identity.manifestSha256,
    fileListSha256: identity.fileListSha256,
    root,
    launcher,
    lastFullHashAt: results.lastFullHashAt,
    startCheck: startCheckOf(handoff),
    signature: results.signature,
    files: results.files,
    ...results.detail === undefined ? {} : { detail: results.detail },
  }
}

/**
 * The release-log section from a recorded state.
 * @param record - the record of the release.
 * @returns the section.
 */
export function releaseLogOf(record: RecordedCheck): TrustReleaseLog {
  const detail = record.state === 'verified' ? undefined : [record.refusal, record.detail].filter(text => text !== undefined).join(': ')
  return {
    state: record.state,
    lastAttempt: utcText(record.lastAttempt),
    uncheckedSince: record.state === 'unchecked' && record.uncheckedSince !== undefined ? utcText(record.uncheckedSince) : null,
    ...detail === undefined || detail === '' ? {} : { detail: boundedDetail(detail) },
  }
}

/**
 * Read the release-log state the home recorded for a release, `trust/release-log.json`.
 * @param home - the resolved Delorun home.
 * @param release - the release.
 * @returns the section; `unknown` with the reason when no record of the release reads.
 */
export async function readReleaseLog(home: string, release: string): Promise<TrustReleaseLog> {
  let records: Map<string, RecordedCheck>
  try {
    records = await readCheckRecords(home)
  } catch (error) {
    return { state: 'unknown', lastAttempt: null, uncheckedSince: null, detail: boundedDetail(`the release-log record does not read: ${reasonOf(error)}`) }
  }
  const record = records.get(release)
  if (record === undefined) return { state: 'unknown', lastAttempt: null, uncheckedSince: null, detail: `no release-log check is recorded for release ${release}` }
  return releaseLogOf(record)
}
