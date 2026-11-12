/**
 * The trust bill of one Delo (`@delo/bundle-local/trust-bill`): what it runs and how much of it was checked, which
 * `delorun verify` prints and the studio's Host row serves. Two stages produce it:
 *
 * - {@link startBill}, `start`: the launcher's start check as it handed it over in `DELO_START_CHECK`, the stored
 *   release-log record, the stored manifest verified under the anchored root, and cheap reads of the profile's plugins,
 *   patches, skills and MCP servers. It hashes no runtime file and contacts no network.
 * - {@link runVerifyStage}, `verify`: `delorun verify`'s checks ([checks](./checks.ts)), which hash every runtime file
 *   and run the online release-log check unless no fetch is given, with the same reads around them.
 *
 * The plugin install check and Changes come from other components through {@link PluginInstallCheck} and
 * {@link ChangesReader}; without one, or when one fails, its section is `unknown` with the reason. Each section's reader
 * turns its own failure into an `unknown` section, so one unreadable file never hides the others.
 *
 * @module @delo/cli/verify/bill
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { DELO_LAUNCHER_ROOTS_ENV } from '@delo/contract-home-layout'
import { TRUST_BILL_SCHEMA, type TrustBill, type TrustBillStage, type TrustChanges, type TrustPlugins, type TrustRelease, type TrustReleaseLog } from '@delo/bundle-local/trust-bill'
import type { DeloLogger } from '@delo/logs'
import type { Fetch } from '@delo/release-verify'
import { parseRuntimeVersion } from '@delo/runtime-store'
import { listedPlugins, mcpSection, patchesSection, readOwnLayers, skillsSection } from './bill-profile.ts'
import { boundedDetail, checkRelease, utcText, VERIFY_MODE, type ReleaseCheckOutcome } from './checks.ts'
import { handoffFor, readReleaseIdentity, readReleaseLog, reasonOf, releaseLogOf, releaseSection, startResults, utcMillisText, type ReleaseResults } from './bill-release.ts'

/**
 * The install check of the plugin supply chain, which another component provides: what each plugin the profile installs
 * is, against the record its install wrote.
 */
export interface PluginInstallCheck {
  /**
   * Check the profile's plugins against their install records.
   * @param home - the resolved Delo home.
   * @param profile - the CLI profile.
   * @returns the plugins section; `unknown` with a reason when the check could not run in full.
   */
  check(home: string, profile: string): Promise<TrustPlugins>
}

/** What Changes reports for a bill: the approved harness edits and plugin versions, and how many changes wait. */
export type ChangesReading = Pick<TrustChanges, 'harnessEdits' | 'approvedPlugins' | 'notReviewed'>

/**
 * Changes, which another component provides: the person's approved changes to the harness and to plugins, and the count
 * of changes present that the person has not approved.
 */
export interface ChangesReader {
  /**
   * Read Changes for one release; nothing is written.
   * @param home - the resolved Delo home.
   * @param profile - the CLI profile.
   * @param release - the release whose harness edits are reported.
   * @returns what Changes keeps.
   */
  read(home: string, profile: string, release: string): Promise<ChangesReading>
}

/** What a bill is produced from. */
export interface BillContext {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** `${process.platform}-${process.arch}`. */
  readonly platform: string
  /** The running release's version string. */
  readonly running: string
  /** The environment, read for `DELO_START_CHECK`, `DELO_LAUNCHER_ROOTS`, `DSH_AGENTS_HOME` and `DSH_BUNDLED_SKILL_DIR`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The clock, in Unix seconds. */
  readonly now: number
  /** The plugin install check; absent makes the plugins section `unknown`. */
  readonly plugins?: PluginInstallCheck
  /** Changes; absent makes the changes section `unknown`. */
  readonly changes?: ChangesReader
}

/** The reason a changes section is `unknown` while no Changes reader is wired in. */
export const NO_CHANGES = 'Changes is not available in this release'

/**
 * The plugins section: the install check's, or the profile's listed plugins as `unknown` when there is none or it fails.
 * @param context - the bill's context.
 * @returns the section.
 */
async function pluginsOf(context: BillContext): Promise<TrustPlugins> {
  if (context.plugins === undefined) return listedPlugins(context.home, context.profile)
  try {
    return await context.plugins.check(context.home, context.profile)
  } catch (error) {
    return listedPlugins(context.home, context.profile, boundedDetail(`the plugin install check failed: ${reasonOf(error)}`))
  }
}

/**
 * The changes section: Changes' reading, or `unknown` with the reason when there is no reader or it fails.
 * @param context - the bill's context.
 * @param release - the release the bill describes.
 * @returns the section.
 */
async function changesOf(context: BillContext, release: string): Promise<TrustChanges> {
  const unknown = (reason: string): TrustChanges => ({ status: 'unknown', reason, harnessEdits: [], approvedPlugins: [], notReviewed: 0 })
  if (context.changes === undefined) return unknown(NO_CHANGES)
  let reading: ChangesReading
  try {
    reading = await context.changes.read(context.home, context.profile, release)
  } catch (error) {
    return unknown(boundedDetail(`Changes does not read: ${reasonOf(error)}`))
  }
  return { status: 'known', harnessEdits: reading.harnessEdits, approvedPlugins: reading.approvedPlugins, notReviewed: reading.notReviewed }
}

/**
 * Assemble a bill around its release sections.
 * @param context - the bill's context.
 * @param stage - the stage.
 * @param release - the release section.
 * @param releaseLog - the release-log section.
 * @returns the bill.
 */
async function assemble(context: BillContext, stage: TrustBillStage, release: TrustRelease, releaseLog: TrustReleaseLog): Promise<TrustBill> {
  const own = readOwnLayers(context.home, context.profile)
  const [plugins, changes] = await Promise.all([pluginsOf(context), changesOf(context, release.version ?? context.running)])
  return {
    schema: TRUST_BILL_SCHEMA,
    stage,
    generatedAt: utcText(context.now),
    release,
    releaseLog,
    plugins,
    changes,
    patches: patchesSection(own),
    skills: skillsSection(context.home, context.env, own),
    mcp: mcpSection(own),
  }
}

/**
 * The bill a start leaves: from the launcher's handoff, the stored release-log record (`trust/release-log.json`), the
 * stored manifest verified under the anchored root, and cheap reads of plugins, patches, skills and MCP servers. It
 * never hashes a runtime file and never contacts the network. A handoff naming the running release makes the release's
 * signature and files `pass`, because the launcher's start check verified both; without one they are `unknown`.
 * @param context - the home, the profile, the platform, the running release, the environment, the clock and the other
 *   components' readers.
 * @returns the bill, stage `start`.
 */
export async function startBill(context: BillContext): Promise<TrustBill> {
  const handoff = handoffFor(context.env, context.running)
  const release = parseRuntimeVersion(context.running)
  if (release === undefined) {
    const results: ReleaseResults = { signature: 'unknown', files: 'unknown', detail: `${context.running} is not a Delo release version, so no signed release describes this runtime`, lastFullHashAt: null }
    const identity = { anchor: undefined, commit: null, manifestSha256: null, fileListSha256: null }
    return assemble(context, 'start', releaseSection(context, context.running, identity, undefined, results), { state: 'unknown', lastAttempt: null, uncheckedSince: null, detail: `${context.running} is not a Delo release version` })
  }
  const identity = await readReleaseIdentity(context, release)
  const section = releaseSection(context, context.running, identity, handoff, startResults(identity, handoff))
  return assemble(context, 'start', section, await readReleaseLog(context.home, context.running))
}

/**
 * The verify stage's results from `checkRelease`'s outcome: `release-signature` and `runtime-files` as they came out,
 * with the detail of the first that did not pass, and this run's time as the last full hash when `runtime-files` ran.
 * @param outcome - the checks' outcome.
 * @param now - the clock, in Unix seconds.
 * @param fallback - the last full hash time when `runtime-files` did not run.
 * @returns the results.
 */
function verifyResults(outcome: ReleaseCheckOutcome, now: number, fallback: string | null): ReleaseResults {
  const result = (id: string): { readonly result: 'pass' | 'fail' | 'unknown', readonly detail: string } => {
    const found = outcome.results.find(entry => entry.id === id)
    return found === undefined || found.result === 'not-enforced' ? { result: 'unknown', detail: `${id} did not run` } : { result: found.result, detail: found.detail }
  }
  const signature = result('release-signature')
  const files = result('runtime-files')
  const short = [signature, files].find(entry => entry.result !== 'pass')
  return {
    signature: signature.result,
    files: files.result,
    ...short === undefined ? {} : { detail: short.detail },
    lastFullHashAt: files.result === 'unknown' ? fallback : utcText(now),
  }
}

/**
 * Run the verify stage exactly as `delorun verify` does: `checkRelease` hashes every runtime file and runs the online
 * release-log check unless `fetch` is undefined, records the release-log state under `trust/`, and the bill is built
 * around its results.
 * @param context - the home, the profile, the platform, the running release, the environment, the clock and the other
 *   components' readers.
 * @param options - the release to check (default: the running one), the fetch for the online check, and the logger the
 *   runtime store reports to.
 * @returns the bill, stage `verify`, and the checks' outcome.
 * @throws {Error} when no release is named and the running version is not a Delo release version.
 */
export async function runVerifyStage(context: BillContext, options: { readonly release?: RuntimeVersion, readonly fetch: Fetch | undefined, readonly logger: DeloLogger }): Promise<{ readonly bill: TrustBill, readonly outcome: ReleaseCheckOutcome }> {
  const release = options.release ?? parseRuntimeVersion(context.running)
  if (release === undefined) throw new Error(`${context.running} is not a Delo release version`)
  const outcome = await checkRelease({
    home: context.home,
    release,
    platform: context.platform,
    now: context.now,
    fetch: options.fetch,
    mode: VERIFY_MODE,
    launcherRoots: context.env[DELO_LAUNCHER_ROOTS_ENV],
    logger: options.logger,
  })
  const handoff = handoffFor(context.env, release)
  const identity = await readReleaseIdentity(context, release)
  const fallback = handoff?.fullCheckAt === null || handoff === undefined ? null : utcMillisText(handoff.fullCheckAt)
  const section = releaseSection(context, release, identity, handoff, verifyResults(outcome, context.now, fallback))
  const releaseLog = outcome.recorded === undefined ? await readReleaseLog(context.home, release) : releaseLogOf(outcome.recorded)
  return { bill: await assemble(context, 'verify', section, releaseLog), outcome }
}
