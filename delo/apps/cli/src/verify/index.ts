/**
 * `delorun verify [--release <version>] [--offline] [--json]` (contract C15's `verify` stage, contract C18's
 * `delorun verify`): check the running release, or the named installed one, against its signed manifest, the stored
 * timestamp's freshness and its release-log bundle, prove the log consistent online unless `--offline`, and print one
 * line per registered check: `passed`, `failed` or `not run`, with a one-line reason. The release-log check's state and
 * the verified checkpoint are recorded under the home's `trust/`, as a start records them.
 *
 * The trusted root is anchored on the roots of the launcher that started this runtime, named by `DELO_LAUNCHER_ROOTS`,
 * and the run names the root it anchored on; a root it could hold to its own signatures only is not a pass. The exit
 * code is 0 when no check failed and `release-signature` passed or fell short only of its online check, which contract
 * C18 makes no failure: the command then prints the warning that the release was not checked against the log, since
 * when, and why. It is 1 otherwise. After the check lines it prints the bill of materials of this Delo
 * ([bill text](./bill-text.ts)) and the statement that the checks run with the person's access, which a program running
 * with that access can change. A summary line states what was and was not checked, and the bill's badge state.
 *
 * After the release checks, every profile's installed plugins are compared with their install records, every file
 * hashed, and the profile's trust status written; a plugin whose files changed since it was installed is a warning on
 * standard error and does not change the exit code ([install check](../plugin-install-check.ts)).
 *
 * @module @delo/cli/verify
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TrustBill } from '@delo/bundle-local/trust-bill'
import { DELO_LAUNCHER_ROOTS_ENV, DELO_LAUNCHER_VERSION_ENV } from '@delo/contract-home-layout'
import { VERIFICATION_NOTICE, VERIFICATION_REPORT_SCHEMA_VERSION, type VerificationCheckResult, type VerificationMode, type VerificationReport, type VerificationResult } from '@delo/contract-verification-checks'
import type { DeloLogger } from '@delo/logs'
import type { Fetch, RecordedCheck } from '@delo/release-verify'
import { parseRuntimeVersion } from '@delo/runtime-store'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandOutput } from '../command.ts'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { deloVersion } from '../version.ts'
import { checkInstalledPlugins } from '../plugin-install-check.ts'
import { installedPluginsCheck } from './plugin-bill.ts'
import { runVerifyStage, type ChangesReader, type PluginInstallCheck } from './bill.ts'
import { ACCESS_LINE, billLines, billSuffix } from './bill-text.ts'
import { VERIFY_MODE, type ReleaseCheckOutcome, type ReleaseOrigins, type RootAnchor } from './checks.ts'

/** The `delorun verify --help` text. */
const VERIFY_USAGE = [
  'Usage: delorun verify [--release <version>] [--offline] [--json]',
  '',
  'Checks the running release, or an installed one, against its signed manifest, the stored timestamp\'s',
  'freshness and its release-log entry, and proves the release log consistent online unless --offline.',
  'Prints one line per check: passed, failed or not run, with the reason, then the bill of materials of',
  'this Delo and how much of it was checked.',
  'Exit codes: 0 when no check failed and release-signature passed or could not reach the release log,',
  '1 otherwise, 2 for a wrong command line. A release log that cannot be reached leaves the release not checked',
  'against it, with a warning, and does not fail.',
  '',
  '  --release <version>  the installed release to check (default: the running one)',
  '  --offline            run no online check',
  '  --json               print the report as JSON, with the bill of materials under "bill"',
  '',
].join('\n')

export { VERIFY_MODE } from './checks.ts'

/** How a result reads on a line. */
const LABELS: Readonly<Record<VerificationResult, string>> = { 'pass': 'passed', 'fail': 'failed', 'not-enforced': 'not enforced', 'unknown': 'not run' }

/** What the command reads from outside the home. */
export interface VerifyEnvironment {
  /** The fetch the online check reads the log through. */
  readonly fetch: Fetch
  /**
   * The clock.
   * @returns Unix seconds.
   */
  readonly now: () => number
  /** `<process.platform>-<process.arch>`. */
  readonly platform: string
  /**
   * The running release's version.
   * @returns the version.
   */
  readonly running: () => string
  /**
   * Compare every profile's installed plugins with their install records, hashing every file, and print a warning for
   * each changed plugin; absent compares none.
   * @param home - the Delo home.
   * @param output - where the warnings go.
   */
  readonly checkPlugins?: (home: string, output: CommandOutput) => Promise<void>
  /** The plugin install check; absent leaves the bill's plugins `unknown`. */
  readonly plugins?: PluginInstallCheck
  /** Changes; absent leaves the bill's changes `unknown`. */
  readonly changes?: ChangesReader
}

/**
 * The full plugin change check of every profile in a home ([install check](../plugin-install-check.ts)).
 * @param home - the Delo home.
 * @param output - where the warnings go.
 */
async function checkEveryProfile(home: string, output: CommandOutput): Promise<void> {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await checkInstalledPlugins({ home, profile: entry.name, profileDir: join(profiles, entry.name), installAnchor: INSTALL_ANCHOR, full: true, output })
  }
}

/** The bill's plugin install check over this installation's profile boot; the boot module loads when the check runs. */
const processPluginsCheck: PluginInstallCheck = {
  async check(home, profile) {
    const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
    return installedPluginsCheck(INSTALL_ANCHOR).check(home, profile)
  },
}

/** This process's fetch, clock, platform and version. */
const PROCESS_ENVIRONMENT: VerifyEnvironment = {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Math.floor(Date.now() / 1000),
  platform: `${process.platform}-${process.arch}`,
  running: deloVersion,
  checkPlugins: checkEveryProfile,
  plugins: processPluginsCheck,
}

/**
 * A logger whose warnings and errors go to standard error. The runtime store takes it for its retention, which a check
 * does not run.
 * @param output - the command's output.
 * @returns the logger.
 */
export function stderrLogger(output: CommandOutput): DeloLogger {
  return {
    error: message => output.stderr(`${message}\n`),
    warn: message => output.stderr(`${message}\n`),
    info: () => undefined,
    debug: () => undefined,
  }
}

/**
 * The line that names the root a run anchored on.
 * @param root - the anchor, when a root read.
 * @returns the line, ending with a newline.
 */
export function rootLine(root: RootAnchor | undefined): string {
  if (root === undefined) return 'Trusted root: none read.\n'
  const keys = root.keyids.map(keyid => keyid.slice(0, 16)).join(', ')
  const anchored = root.anchored === 'shipped'
    ? `anchored on the shipped roots of the launcher that started this Delo, in ${String(root.rootsDirectory)} (${DELO_LAUNCHER_ROOTS_ENV})`
    : 'anchored on the stored root only'
  return `Trusted root: version ${String(root.version)}, root keys ${keys}, ${anchored}.\n`
}

/**
 * The line that says where this home's releases come from, as its channel record names them.
 * @param origins - the channel's and the log's origins, or `undefined` when the record does not read.
 * @returns the line, ending with a newline.
 */
export function originsLine(origins: ReleaseOrigins | undefined): string {
  if (origins === undefined) return 'Release channel: unknown, because the home\'s channel record does not read.\n'
  return `Release channel: ${origins.channel}; release log: ${origins.log}; as the launcher that installed this Delo recorded them.\n`
}

/**
 * The summary line: what was and was not checked, which no reader should take for more, and the bill's badge state.
 * @param results - one result per registered check.
 * @param bill - the run's bill, when it built one.
 * @returns the line, ending with a newline.
 */
export function summaryLine(results: readonly VerificationCheckResult[], bill?: TrustBill): string {
  const count = (result: VerificationResult): number => results.filter(entry => entry.result === result).length
  const parts = [`${String(count('pass'))} checks passed`, `${String(count('fail'))} failed`, `${String(count('unknown'))} not run`]
  if (count('not-enforced') > 0) parts.push(`${String(count('not-enforced'))} not enforced`)
  return `${parts.join(', ')}${billSuffix(bill)}; this is not a full verification of this Delo.\n`
}

/**
 * The report's lines.
 * @param release - the release checked.
 * @param outcome - what the run found.
 * @param bill - the run's bill, when it built one.
 * @returns the text: a heading, the root line, the origins line, the launcher line when the manifest verified, one
 *   line per check, the bill of materials, the access statement and the summary.
 */
export function reportLines(release: string, outcome: Pick<ReleaseCheckOutcome, 'results' | 'root' | 'origins' | 'launcher'>, bill?: TrustBill): string {
  const width = Math.max(...outcome.results.map(result => result.id.length))
  const lines = outcome.results.map(result => `${LABELS[result.result].padEnd(7)}  ${result.id.padEnd(width)}  ${result.detail}`)
  const launcher = outcome.launcher === undefined ? '' : `Launcher: ${outcome.launcher}.\n`
  return `Release ${release}, verification mode ${VERIFY_MODE}; ${VERIFICATION_NOTICE}.\n${rootLine(outcome.root)}${originsLine(outcome.origins)}${launcher}${lines.join('\n')}\n${bill === undefined ? '' : billLines(bill)}${ACCESS_LINE}${summaryLine(outcome.results, bill)}`
}

/**
 * The run's report under contract C15, with the release it checked, the root it anchored on, the release-log state it
 * recorded and where the home's releases come from.
 * @param release - the release.
 * @param outcome - what the run found.
 * @param now - the clock, in Unix seconds.
 * @returns the report.
 */
export function report(release: string, outcome: ReleaseCheckOutcome, now: number): VerificationReport & { readonly release: string, readonly root: RootAnchor | null, readonly releaseLog: RecordedCheck | null, readonly origins: ReleaseOrigins | null } {
  return {
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    mode: VERIFY_MODE,
    stage: 'verify',
    generatedAt: new Date(now * 1000).toISOString().replace('.000Z', 'Z'),
    notice: VERIFICATION_NOTICE,
    // Contract C15's badge is green only in `enforce` with every check passing, so a `warn` run is never green.
    badge: 'not-green',
    checks: outcome.results,
    release,
    root: outcome.root ?? null,
    releaseLog: outcome.recorded ?? null,
    origins: outcome.origins ?? null,
  }
}

/**
 * The run's exit code: 1 when a check failed, or when `release-signature` fell short of a pass for any reason other
 * than its online check not completing, which contract C18 makes no failure; 0 otherwise.
 * @param outcome - what the run found.
 * @returns the exit code.
 */
export function exitOf(outcome: Pick<ReleaseCheckOutcome, 'results' | 'onlineOnly'>): ExitCode {
  if (outcome.results.some(result => result.result === 'fail')) return EXIT.failed
  const signature = outcome.results.find(result => result.id === 'release-signature')!
  return signature.result === 'pass' || outcome.onlineOnly ? EXIT.ok : EXIT.failed
}

/**
 * `delorun verify` over an environment.
 * @param environment - the fetch, the clock, the platform and the running version.
 * @returns the command.
 */
export function createVerifyCommand(environment: VerifyEnvironment): CliCommand {
  return {
    name: 'verify',
    summary: 'Check the release against its signed manifest and the release log: --release <version>, --offline, --json',
    async run(args: readonly string[], context: CommandContext): Promise<ExitCode> {
      if (args.includes('--help') || args.includes('-h')) {
        context.stdout(VERIFY_USAGE)
        return EXIT.ok
      }
      const values = parseOptions('verify', args, { release: { type: 'string' }, offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } })
      const named = values.release ?? environment.running()
      const release = parseRuntimeVersion(named)
      if (release === undefined) throw new CliError(EXIT.usage, `delorun verify: ${JSON.stringify(named)} is not a Delo release version`)
      const { home, profile } = await prepareHome(context, undefined)
      const now = environment.now()
      const { bill, outcome } = await runVerifyStage(
        { home: home.path, profile, platform: environment.platform, running: environment.running(), env: context.env, now, ...environment.plugins === undefined ? {} : { plugins: environment.plugins }, ...environment.changes === undefined ? {} : { changes: environment.changes } },
        { release, fetch: values.offline ? undefined : environment.fetch, logger: stderrLogger(context) },
      )
      if (values.json) context.stdout(`${JSON.stringify({ ...report(release, outcome, now), bill })}\n`)
      else context.stdout(reportLines(release, outcome, bill))
      for (const notice of outcome.notices) context.stderr(`notice: ${notice}\n`)
      for (const warning of outcome.warnings) context.stderr(`warning: ${warning}\n`)
      // A changed plugin is a warning and fails nothing: the plugins are the person's, not the release's.
      await environment.checkPlugins?.(home.path, context)
      return exitOf(outcome)
    },
  }
}

/** `delorun verify`, over this process's fetch, clock, platform and version. */
export const verifyCommand: CliCommand = createVerifyCommand(PROCESS_ENVIRONMENT)
