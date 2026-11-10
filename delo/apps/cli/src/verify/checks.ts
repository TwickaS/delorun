/**
 * The checks `delorun verify` runs for one installed release (contract C15's `verify` stage), with one result per
 * registry entry of `@delo/contract-verification-checks`:
 *
 * - `release-signature` (contracts C2 and C18): the home's trusted root, anchored on the roots the launcher ships as the
 *   launcher's own start anchors it, and not expired; the stored manifest's targets signature under that root; the
 *   release-log bundle offline and, unless the run is offline, the online consistency check, with the check's state
 *   and the verified checkpoint recorded under `trust/` as a start records them; and the stored timestamp's freshness.
 *   A verifiable failure of any part is a `fail`. A root anchored on the stored root only, or an online check that did
 *   not complete, is `unknown`: the run does not claim a pass it did not prove.
 * - `runtime-files` (contract C2's start check): every installed file against the signed file list, through the
 *   runtime store. It is `unknown` when no root or manifest verified, because then there is no list to check against.
 * - Every other registry entry belongs to checks this command does not run yet, and is `unknown` with that reason.
 *
 * Every part reads its inputs itself and turns its own failure into its result, so one unreadable file names the part
 * it stopped and never hides the others.
 *
 * @module @delo/cli/verify/checks
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, ROOT_FILE_NAME_PATTERN, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { CLOCK_TOLERANCE_SECONDS, RELEASE_FILE_SIZE_LIMITS, RUNTIME_PLATFORMS, type ReleaseManifest, type RuntimePlatform } from '@delo/contract-release-manifest'
import {
  VERIFICATION_CHECKS,
  VERIFICATION_DETAIL_MAX_LENGTH,
  type VerificationCheckId,
  type VerificationCheckResult,
  type VerificationMode,
  type VerificationResult,
} from '@delo/contract-verification-checks'
import { readProtectedFile } from '@delo/home'
import { readStoredRootChain, verifyStoredRoot } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { readRoot, verifySignedManifest, verifyTimestamp, type TrustedRoot } from '@delo/release/sign/verify'
import { checkAndStore, logEndpoints, recordResult, tilesTransport, uncheckedWarning, type Fetch, type RecordedCheck } from '@delo/release-verify'
import { RuntimeStore, StorePaths } from '@delo/runtime-store'

/** What one run of the checks reads. */
export interface ReleaseCheckOptions {
  /** The resolved Delo home, whose tree exists. */
  readonly home: string
  /** The installed release to check. */
  readonly release: RuntimeVersion
  /** `<process.platform>-<process.arch>`, which names the file list this machine installs. */
  readonly platform: string
  /** The clock, in Unix seconds. */
  readonly now: number
  /** The fetch the online check reads the log through; `undefined` runs no online check. */
  readonly fetch: Fetch | undefined
  /** The verification mode the start check is given; `off` would skip the online check, so the caller passes another. */
  readonly mode: Exclude<VerificationMode, 'off'>
  /** The launcher's shipped-roots directory, from the variable the launcher sets; `undefined` when it set none. */
  readonly launcherRoots: string | undefined
  /** Where the runtime store reports a removal it could not finish; the check removes nothing. */
  readonly logger: DeloLogger
}

/** The trusted root a run anchored on, for the line that names it. */
export interface RootAnchor {
  /** The root's version. */
  readonly version: number
  /** The key ids of its root role. */
  readonly keyids: readonly string[]
  /** `shipped` when the launcher's shipped roots lead to it; `stored` when only its own signatures were checked. */
  readonly anchored: 'shipped' | 'stored'
  /** Why the run anchored on the stored root only, when it did. */
  readonly reason?: string
}

/** What one run found. */
export interface ReleaseCheckOutcome {
  /** One result per registry entry, in the registry's order. */
  readonly results: readonly VerificationCheckResult[]
  /** The root the run anchored on, when one read. */
  readonly root: RootAnchor | undefined
  /** Whether `release-signature` is short of a pass only because its online check did not complete. */
  readonly onlineOnly: boolean
  /** The release-log state this run recorded, when the release-log part ran. */
  readonly recorded: RecordedCheck | undefined
  /** The warnings to print: a release not checked against the log, a root anchored on itself only. */
  readonly warnings: readonly string[]
  /** What the release-log check noticed without it being a failure. */
  readonly notices: readonly string[]
}

/** One part of the `release-signature` check. */
interface Part {
  /** `pass`, `fail` or `unknown`. */
  readonly result: Exclude<VerificationResult, 'not-enforced'>
  /** What the part found, in one clause. */
  readonly detail: string
}

/** The detail of a registry entry this command does not run yet. */
export const NOT_RUN_HERE = 'delorun verify does not run this check yet'

/**
 * The words a failure gives.
 * @param error - the failure.
 * @returns its message on one line.
 */
function reasonOf(error: unknown): string {
  // Every reader and verifier this module calls throws an `Error`: the filesystem's, `@delo/home`'s, C2's and C18's.
  return (error as Error).message.replace(/\s*\n\s*/gu, ' ')
}

/**
 * A detail cut to contract C15's limit.
 * @param text - the detail.
 * @returns the detail, at most {@link VERIFICATION_DETAIL_MAX_LENGTH} characters.
 */
export function boundedDetail(text: string): string {
  return text.length <= VERIFICATION_DETAIL_MAX_LENGTH ? text : `${text.slice(0, VERIFICATION_DETAIL_MAX_LENGTH - 1)}…`
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
 * The time a line names, as RFC 3339 UTC.
 * @param seconds - Unix seconds.
 * @returns the time text.
 */
export function utcText(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * A duration in the largest whole unit a person reads at a glance.
 * @param seconds - the duration.
 * @returns such as `3 hours` or `under a minute`.
 */
export function durationText(seconds: number): string {
  for (const [unit, size] of [['day', 86_400], ['hour', 3600], ['minute', 60]] as const) {
    const count = Math.floor(seconds / size)
    if (count >= 1) return `${String(count)} ${unit}${count === 1 ? '' : 's'}`
  }
  return 'under a minute'
}

/**
 * The root files the launcher ships, from its `roots/` directory, in no order: the anchoring reads each by its version.
 * @param directory - the directory the launcher named.
 * @returns the files.
 * @throws when the directory cannot be read or holds no root file.
 */
async function shippedRoots(directory: string): Promise<readonly Uint8Array[]> {
  const pattern = new RegExp(ROOT_FILE_NAME_PATTERN, 'u')
  const names = (await readdir(directory)).map(name => pattern.exec(name)).filter((match): match is RegExpExecArray => match !== null)
  if (names.length === 0) throw new Error(`${directory} holds no <n>.root.json file`)
  return Promise.all(names.map(match => readFile(join(directory, match[0]))))
}

/** The anchored root, or the part that refused it. */
type RootStep = { readonly root: TrustedRoot, readonly anchor: RootAnchor, readonly expiry: Part } | { readonly refused: Part }

/**
 * Read the home's trusted root, `trust/root.json`, and anchor it as the launcher's start does: on the roots the launcher
 * ships, through the chain an install walked to a newer root (`trust/roots/`). Without the launcher's roots the root
 * is held to its own signatures only, which the anchor records. The root must not have expired.
 * @param options - the run's options.
 * @returns the root with its anchor and expiry part, or the part that refused it.
 */
async function anchoredRoot(options: ReleaseCheckOptions): Promise<RootStep> {
  const path = join(options.home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root)
  let stored: Buffer
  let own: TrustedRoot
  try {
    stored = await readProtectedFile(path)
    own = readRoot(stored)
  } catch (error) {
    return { refused: { result: 'fail', detail: `the trusted root ${path} does not read: ${reasonOf(error)}` } }
  }
  let root = own
  let anchor: RootAnchor
  const keyids = own.metadata.roles.root.keyids.map(String)
  let shipped: readonly Uint8Array[] | undefined
  let reason: string | undefined
  if (options.launcherRoots === undefined) reason = 'the launcher that started this runtime named no shipped roots'
  else {
    try {
      shipped = await shippedRoots(options.launcherRoots)
    } catch (error) {
      reason = `the launcher's roots at ${options.launcherRoots} do not read: ${reasonOf(error)}`
    }
  }
  if (shipped === undefined) anchor = { version: own.metadata.version, keyids, anchored: 'stored', reason: reason! }
  else {
    try {
      root = verifyStoredRoot({ stored, shipped, walked: await readStoredRootChain(options.home), source: path })
    } catch (error) {
      return { refused: { result: 'fail', detail: `the trusted root ${path} is not one the launcher's shipped roots lead to: ${reasonOf(error)}` } }
    }
    anchor = { version: root.metadata.version, keyids, anchored: 'shipped' }
  }
  const expires = Date.parse(root.metadata.expires) / 1000
  const expiry: Part = options.now > expires + CLOCK_TOLERANCE_SECONDS
    ? { result: 'fail', detail: `trusted root ${String(root.metadata.version)} expired at ${root.metadata.expires}; this machine's clock reads ${utcText(options.now)}, and an update brings the next root` }
    : { result: 'pass', detail: `trusted root ${String(root.metadata.version)} is valid until ${root.metadata.expires}` }
  return { root, anchor, expiry }
}

/** What the manifest part leaves for the parts after it. */
interface ManifestPart extends Part {
  /** The verified manifest's bytes, when it verified. */
  readonly bytes?: Uint8Array
}

/**
 * The manifest part: the stored manifest is the release's and its targets signature verifies with the trusted root.
 * @param root - the trusted root.
 * @param paths - the store's paths.
 * @param release - the release.
 * @returns the part, with the manifest's bytes when it verified.
 */
async function manifestPart(root: TrustedRoot, paths: StorePaths, release: RuntimeVersion): Promise<ManifestPart> {
  const path = paths.releaseFiles(release).manifest
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isMissing(error)) return { result: 'fail', detail: `release ${release} is not installed: ${path} is missing` }
    return { result: 'fail', detail: `the signed manifest ${path} cannot be read: ${reasonOf(error)}` }
  }
  if (bytes.byteLength > RELEASE_FILE_SIZE_LIMITS.manifest) return { result: 'fail', detail: `the signed manifest ${path} is above its size limit` }
  let manifest: ReleaseManifest
  try {
    manifest = verifySignedManifest(root.metadata, bytes)
  } catch (error) {
    return { result: 'fail', detail: `the manifest of release ${release} does not verify with the trusted root: ${reasonOf(error)}` }
  }
  if (manifest.version !== String(release)) return { result: 'fail', detail: `the stored manifest is release ${manifest.version}, not ${release}` }
  return { result: 'pass', detail: 'the manifest\'s targets signature verifies', bytes }
}

/**
 * The freshness part: the stored timestamp verifies with the trusted root and has not expired (contract C2,
 * `Freshness and rollback protection`). A stale or missing timestamp never stops a start; `delorun verify` reports it.
 * @param home - the resolved Delo home.
 * @param root - the trusted root.
 * @param now - the clock.
 * @returns the part.
 */
async function freshnessPart(home: string, root: TrustedRoot, now: number): Promise<Part> {
  const path = join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.timestamp)
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (isMissing(error)) return { result: 'fail', detail: `no timestamp is stored at ${path}, so the release's freshness is unknown; an update stores one` }
    return { result: 'fail', detail: `the stored timestamp cannot be read: ${reasonOf(error)}` }
  }
  try {
    verifyTimestamp(root, bytes, now)
  } catch (error) {
    return { result: 'fail', detail: `the stored timestamp is not fresh: ${reasonOf(error)}` }
  }
  return { result: 'pass', detail: 'the stored timestamp is fresh' }
}

/** The release-log part, with what it recorded. */
interface LogPart extends Part {
  /** The state the part recorded. */
  readonly recorded?: RecordedCheck
  /** The warning of a release the online check did not complete for. */
  readonly warning?: string
  /** What the check noticed. */
  readonly notices?: readonly string[]
}

/**
 * The release-log part: contract C18's start check over the stored bundle, offline and, with a fetch, online, with its
 * state and verified checkpoint recorded.
 * @param options - the run's options.
 * @param root - the trusted root.
 * @param paths - the store's paths.
 * @param manifest - the verified manifest's bytes.
 * @returns the part.
 */
async function releaseLogPart(options: ReleaseCheckOptions, root: TrustedRoot, paths: StorePaths, manifest: Uint8Array): Promise<LogPart> {
  const path = paths.releaseFiles(options.release).bundle
  let bundle: Buffer | undefined
  let record: RecordedCheck
  let notices: readonly string[]
  try {
    bundle = await readFile(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    const transport = options.fetch === undefined ? undefined : tilesTransport({ fetch: options.fetch, ...logEndpoints(root.metadata) })
    const result = await checkAndStore(options.home, { root: root.metadata, version: options.release, manifest, bundle, now: options.now, transport, mode: options.mode })
    record = await recordResult(options.home, options.release, options.now, result)
    notices = result.notices ?? []
  } catch (error) {
    return { result: 'fail', detail: `the release-log check could not run: ${reasonOf(error)}` }
  }
  switch (record.state) {
    case 'verified':
      return { result: 'pass', detail: 'the release-log entry verifies and the log is consistent with the stored checkpoint', recorded: record, notices }
    case 'failed':
      return { result: 'fail', detail: `the release log refused it (${String(record.refusal)}): ${String(record.detail)}`, recorded: record, notices }
    case 'unchecked': {
      // Contract C18: `delorun verify` fails on a missing bundle, which a start only warns about.
      if (bundle === undefined) return { result: 'fail', detail: `no release-log bundle is stored for release ${options.release} at ${path}`, recorded: record, notices }
      const why = options.fetch === undefined ? 'the online check was not run (--offline)' : `the online check could not complete: ${String(record.detail)}`
      const since = record.uncheckedSince!
      const warning = `${uncheckedWarning(options.release)} It has stayed unchecked since ${utcText(since)} (${durationText(options.now - since)}); ${why}.`
      return { result: 'unknown', detail: `the release-log bundle verifies offline; ${why}`, recorded: record, warning, notices }
    }
  }
}

/**
 * The `release-signature` result from its parts: `fail` when any part failed, naming every failed part; `unknown` when
 * none failed and one could not run; `pass` otherwise.
 * @param parts - the parts, in the order they ran.
 * @returns the result.
 */
function combine(parts: readonly Part[]): Part {
  const failed = parts.filter(part => part.result === 'fail')
  if (failed.length > 0) return { result: 'fail', detail: failed.map(part => part.detail).join('; ') }
  const unknown = parts.filter(part => part.result === 'unknown')
  if (unknown.length > 0) return { result: 'unknown', detail: unknown.map(part => part.detail).join('; ') }
  return { result: 'pass', detail: parts.map(part => part.detail).join('; ') }
}

/**
 * The `runtime-files` result: the runtime store's start check of every installed file against the signed file list.
 * @param options - the run's options.
 * @param platform - the platform whose file list the store reads.
 * @param root - the trusted root.
 * @returns the part.
 */
async function runtimeFilesPart(options: ReleaseCheckOptions, platform: RuntimePlatform, root: TrustedRoot): Promise<Part> {
  try {
    const runtime = await new RuntimeStore({ home: options.home, platform, logger: options.logger }).checkRuntime(options.release, root.metadata)
    return { result: 'pass', detail: `all ${String(runtime.files.files.length)} files of runtime ${options.release} match the signed file list` }
  } catch (error) {
    return { result: 'fail', detail: reasonOf(error) }
  }
}

/** The two checks this command runs, and what they found. */
interface OwnChecks {
  readonly parts: ReadonlyMap<VerificationCheckId, Part>
  readonly root?: RootAnchor
  readonly onlineOnly?: boolean
  readonly recorded?: RecordedCheck
  readonly warnings?: readonly string[]
  readonly notices?: readonly string[]
}

/**
 * Run the checks for one installed release.
 * @param options - the home, the release, the platform, the clock, the fetch, the mode, the launcher's roots and the
 *   logger.
 * @returns one result per registry entry, the root anchor, the recorded state and the lines to print.
 */
export async function checkRelease(options: ReleaseCheckOptions): Promise<ReleaseCheckOutcome> {
  const own = await releaseChecks(options)
  const results = VERIFICATION_CHECKS.map((entry): VerificationCheckResult => {
    const part = own.parts.get(entry.id)
    return part === undefined ? { id: entry.id, result: 'unknown', detail: NOT_RUN_HERE } : { id: entry.id, result: part.result, detail: boundedDetail(part.detail) }
  })
  return { results, root: own.root, onlineOnly: own.onlineOnly ?? false, recorded: own.recorded, warnings: own.warnings ?? [], notices: own.notices ?? [] }
}

/**
 * The two checks this command runs.
 * @param options - the run's options.
 * @returns their parts by check, and what else they found.
 */
async function releaseChecks(options: ReleaseCheckOptions): Promise<OwnChecks> {
  const platform = RUNTIME_PLATFORMS.find(candidate => candidate === options.platform)
  if (platform === undefined) {
    const detail = `Delo publishes no runtime for ${options.platform}, so no installed release can be checked here`
    return { parts: new Map([['release-signature', { result: 'fail', detail }], ['runtime-files', { result: 'fail', detail }]]) }
  }
  const rooted = await anchoredRoot(options)
  if ('refused' in rooted) {
    return { parts: new Map([['release-signature', rooted.refused], ['runtime-files', { result: 'unknown', detail: 'not checked, because no trusted root reads' }]]) }
  }
  const { root, anchor } = rooted
  const anchorPart: Part = anchor.anchored === 'shipped'
    ? { result: 'pass', detail: `trusted root ${String(anchor.version)} is anchored on the launcher's shipped roots` }
    : { result: 'unknown', detail: `trusted root ${String(anchor.version)} is checked against its own signatures only, because ${String(anchor.reason)}` }
  const anchorWarnings = anchor.anchored === 'stored' ? [`the trusted root was anchored on the stored root only: ${String(anchor.reason)}. A pass needs the launcher's shipped roots; run delorun verify through the delorun launcher.`] : []
  const paths = new StorePaths(options.home, platform)
  const manifest = await manifestPart(root, paths, options.release)
  if (manifest.bytes === undefined) {
    const signature = combine([anchorPart, rooted.expiry, manifest])
    return { parts: new Map([['release-signature', signature], ['runtime-files', { result: 'unknown', detail: 'not checked, because the signed manifest did not verify' }]]), root: anchor, warnings: anchorWarnings }
  }
  const log = await releaseLogPart(options, root, paths, manifest.bytes)
  const freshness = await freshnessPart(options.home, root, options.now)
  const files = await runtimeFilesPart(options, platform, root)
  const offline = [anchorPart, rooted.expiry, manifest, freshness]
  const signature = combine([...offline, log])
  // `release-signature` falls short of a pass only for its online check when every other part passed.
  const onlineOnly = signature.result === 'unknown' && offline.every(part => part.result === 'pass')
  return {
    parts: new Map([['release-signature', signature], ['runtime-files', files]]),
    root: anchor,
    onlineOnly,
    ...log.recorded === undefined ? {} : { recorded: log.recorded },
    warnings: [...anchorWarnings, ...log.warning === undefined ? [] : [log.warning]],
    notices: log.notices ?? [],
  }
}
