/**
 * The update check (design `delo/docs/design/update-notice.md`, contract C3 "Update check"): whether the channel the
 * running release names has a newer release, verified as `delorun update` verifies it, and how many installed plugins
 * that release would disable. The check opens the home's channel from the launcher's roots ({@link homeCheckChannel})
 * and asks `LauncherChannel.newest`, which fetches the timestamp, any newer root files, the manifest and its log
 * bundle, sends nothing about the person or the profile, and records nothing under `trust/`. The result goes to
 * `run/<profile>/update-check.json` with the time of the check; a failure keeps the last verified release and records
 * why. The plugin count is computed on this machine, at each read, from the profile as it is installed then.
 *
 * @module @delo/cli/update/notice
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RUN_ENTRIES, type RuntimeVersion } from '@delo/contract-home-layout'
import type { ReleaseChannel, ReleaseManifest, RootMetadata, RuntimePlatform, SemanticVersion, UtcTimestamp } from '@delo/contract-release-manifest'
import { isValidSummary } from '@delo/contract-release-manifest'
import { UPDATE_CHECK_SCHEMA, UPDATE_COMMAND, type CheckedRelease, type UpdateCheckRecord, type UpdateKind, type UpdateNotice } from '@delo/contract-update-report'
import { readProtectedFile, runDirectory, writeProtectedFile } from '@delo/home'
import { messageOf } from '@delo/install'
import { readStoredRelease, StorePaths } from '@delo/runtime-store'
import { pluginItems, type ProfileFacts } from '@delo/update'
import semver from 'semver'
import { z } from 'zod'
import { homeCheckChannel, type Publication } from './channel.ts'
import { readProfileFacts } from './sources.ts'
import type { LauncherAnchor } from './trusted-root.ts'

/** The release that runs, as its stored, signed manifest states it. */
export interface RunningRelease {
  /** Delo's version. */
  readonly delo: SemanticVersion
  /** Upstream's version. */
  readonly dsh: SemanticVersion
  /** The channel the release is published on, which the check asks. */
  readonly channel: ReleaseChannel
}

/**
 * The update-check record's path for a profile.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns `run/<profile>/update-check.json`.
 */
export function updateCheckPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.updateCheck)
}

const version = z.string().refine(text => semver.valid(text) !== null, 'a semantic version').transform(text => brandString<SemanticVersion>(text))
const timestamp = z.iso.datetime().transform(text => brandString<UtcTimestamp>(text))
const recordSchema = z.strictObject({
  schema: z.literal(UPDATE_CHECK_SCHEMA),
  checked: timestamp,
  newest: z.strictObject({
    delo: version,
    dsh: version,
    channel: z.enum(['stable', 'beta']),
    security: z.boolean(),
    summary: z.string().refine(isValidSummary, 'one line of at most 200 characters with no control character').exactOptional(),
  }).exactOptional(),
  verified: timestamp.exactOptional(),
  failure: z.string().exactOptional(),
})

/**
 * Read a profile's update-check record under C1's protected-file rule.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns the record, or `undefined` when it is absent, laxer than mode 0600 or does not validate: a record that
 *   cannot be trusted shows nothing, and the next check replaces it.
 */
export async function readUpdateCheck(home: string, profile: string): Promise<UpdateCheckRecord | undefined> {
  let text: string
  try {
    text = (await readProtectedFile(updateCheckPath(home, profile))).toString('utf8')
  } catch (_unreadable) {
    // Absent, or not a file this user alone can read: no record.
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // Not JSON: no record.
    return undefined
  }
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Write a profile's update-check record atomically at mode 0600.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param record - the record.
 */
export async function writeUpdateCheck(home: string, profile: string, record: UpdateCheckRecord): Promise<void> {
  await writeProtectedFile(updateCheckPath(home, profile), `${JSON.stringify(record, undefined, 2)}\n`)
}

/**
 * Remove a profile's update-check record, as a start does when the check is switched off.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 */
export async function removeUpdateCheck(home: string, profile: string): Promise<void> {
  await rm(updateCheckPath(home, profile), { force: true })
}

/**
 * The running release as its stored manifest states it, verified with the stored root anchored on the launcher's roots.
 * @param home - the resolved Delo home.
 * @param platform - the runtime platform.
 * @param running - the version this process runs from the store.
 * @param root - the stored root, anchored on the launcher's roots ([trusted root](./trusted-root.ts)).
 * @returns its Delo and upstream versions and its channel.
 * @throws {Error} when the installation's signed files do not read or verify.
 */
export async function runningRelease(home: string, platform: RuntimePlatform, running: RuntimeVersion, root: RootMetadata): Promise<RunningRelease> {
  const { manifest } = await readStoredRelease(new StorePaths(home, platform), root, running)
  return { delo: manifest.version, dsh: manifest.dsh, channel: manifest.channel }
}

/**
 * The facts of a verified manifest the notice shows.
 * @param manifest - the channel's verified manifest.
 * @returns the release; no security mark reads as false and no summary as none.
 */
export function checkedReleaseOf(manifest: ReleaseManifest): CheckedRelease {
  return {
    delo: manifest.version,
    dsh: manifest.dsh,
    channel: manifest.channel,
    security: manifest.security === true,
    ...manifest.summary === undefined ? {} : { summary: manifest.summary },
  }
}

/**
 * How far a newer release moves.
 * @param from - the running Delo version.
 * @param to - the newer one.
 * @returns `major`, `minor` or `patch`; a pre-release counts as the step it leads to.
 */
export function updateKind(from: SemanticVersion, to: SemanticVersion): UpdateKind {
  const step = semver.diff(from, to)
  if (step === 'major' || step === 'premajor') return 'major'
  if (step === 'minor' || step === 'preminor') return 'minor'
  return 'patch'
}

/**
 * How many installed plugins a release would disable, by the evaluation the update report runs on both axes.
 * @param profile - the profile as it is installed.
 * @param running - the running release.
 * @param release - the newer release.
 * @returns the count.
 */
export function countDisabled(profile: ProfileFacts, running: RunningRelease, release: CheckedRelease): number {
  const versions = { dsh: { from: running.dsh, to: release.dsh }, delo: { from: running.delo, to: release.delo } }
  return pluginItems(profile.plugins, versions, profile.exemptions, []).disabled.size
}

/**
 * The notice a record supports for a profile.
 * @param record - the update-check record, if any.
 * @param running - the running release.
 * @param profile - reads the profile as it is installed now; asked only when a newer release is known.
 * @returns the notice, or `undefined` when no newer release than the running one is known.
 */
export async function noticeOf(record: UpdateCheckRecord | undefined, running: RunningRelease, profile: () => Promise<ProfileFacts>): Promise<UpdateNotice | undefined> {
  const release = record?.newest
  if (release === undefined || !semver.gt(release.delo, running.delo)) return undefined
  return {
    running: { delo: running.delo, dsh: running.dsh },
    release,
    kind: updateKind(running.delo, release.delo),
    disables: countDisabled(await profile(), running, release),
  }
}

/**
 * The notice's one terminal line.
 * @param notice - the notice.
 * @returns the line, without a newline.
 */
export function noticeLine(notice: UpdateNotice): string {
  const kind = notice.release.security ? 'security fix' : `${notice.kind} release`
  const base = notice.release.dsh === notice.running.dsh ? '' : ` on DSH ${notice.release.dsh}`
  const plugins = notice.disables === 0
    ? 'all your plugins stay compatible'
    : `it would turn off ${String(notice.disables)} of your plugins`
  return `Delorun ${notice.release.delo} is available (${kind}${base}; ${plugins}). Run: ${UPDATE_COMMAND}`
}

/**
 * What `delorun update --check` prints for a notice: its line, and the release's summary beneath it.
 * @param notice - the notice.
 * @returns the lines, without newlines.
 */
export function noticeLines(notice: UpdateNotice): readonly string[] {
  return notice.release.summary === undefined ? [noticeLine(notice)] : [noticeLine(notice), `  ${notice.release.summary}`]
}

/** What one check needs. */
export interface CheckOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile, whose record the check writes. */
  readonly profile: string
  /** The runtime platform. */
  readonly platform: RuntimePlatform
  /** The version this process runs from the store. */
  readonly running: RuntimeVersion
  /** The launcher's roots and the stored root anchored on them, which the check verifies with as an update does. */
  readonly anchor: LauncherAnchor
  /** How long the whole check may take, in milliseconds. */
  readonly timeoutMs: number
  /** The clock; `Date` by default. */
  readonly now?: () => Date
  /** The fetch every request goes through; this process's by default. */
  readonly fetch?: typeof globalThis.fetch
  /** Where the files are published, and their hosts; the installation's recorded channel by default. */
  readonly publication?: Publication
}

/**
 * The time as the record states it.
 * @param date - the time.
 * @returns ISO 8601 in UTC.
 */
function utc(date: Date): UtcTimestamp {
  return brandString<UtcTimestamp>(date.toISOString())
}

/**
 * A fetch whose every request also ends when a deadline passes.
 * @param base - the fetch requests go through.
 * @param deadline - aborts when the check's time is up.
 * @returns the fetch.
 */
export function withDeadline(base: typeof globalThis.fetch, deadline: AbortSignal): typeof globalThis.fetch {
  return async (input, init) => base(input, { ...init, signal: init?.signal == null ? deadline : AbortSignal.any([init.signal, deadline]) })
}

/**
 * Run one check and record it. Every request shares one deadline; a check that fails, does not verify or passes its
 * deadline is recorded with its reason and keeps the last verified release.
 * @param options - the home, the profile, the platform, the running version, the deadline, the clock and the fetch.
 * @returns the record written.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheckRecord> {
  const now = options.now ?? (() => new Date())
  const previous = await readUpdateCheck(options.home, options.profile)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error(`the check took longer than ${String(options.timeoutMs / 1000)} seconds`)) }, options.timeoutMs)
  const fetch = withDeadline(options.fetch ?? globalThis.fetch.bind(globalThis), deadline.signal)
  let record: UpdateCheckRecord
  try {
    const running = await runningRelease(options.home, options.platform, options.running, await options.anchor.root())
    const channel = await homeCheckChannel(options.home, { platform: options.platform, channel: running.channel, shipped: await options.anchor.shipped(), fetch, timeoutMs: options.timeoutMs, now: () => now().getTime(), ...options.publication === undefined ? {} : { publication: options.publication } })
    const checked = utc(now())
    record = { schema: UPDATE_CHECK_SCHEMA, checked, newest: checkedReleaseOf(await channel.newest()), verified: checked }
  } catch (error) {
    const kept = previous?.newest === undefined || previous.verified === undefined ? {} : { newest: previous.newest, verified: previous.verified }
    record = { schema: UPDATE_CHECK_SCHEMA, checked: utc(now()), ...kept, failure: messageOf(error).replace(/\s+/gu, ' ') }
  } finally {
    clearTimeout(timer)
  }
  await writeUpdateCheck(options.home, options.profile, record)
  return record
}

/**
 * The profile reader the notice counts plugins with.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns a reader of the profile as it is installed when it is asked.
 */
export function profileReader(home: string, profile: string): () => Promise<ProfileFacts> {
  return async () => readProfileFacts(home, profile)
}
