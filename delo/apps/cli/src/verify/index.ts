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
 * when, and why. It is 1 otherwise. After the check lines the command prints what it found about Changes
 * ([changes](./changes.ts)): it also exits 1 while content the person did not approve runs or an invariant of Changes
 * does not hold. A summary line states what was and was not checked, and what is present that the person did not
 * approve.
 *
 * @module @delo/cli/verify
 */
import { fileURLToPath } from 'node:url'
import { DELO_LAUNCHER_ROOTS_ENV } from '@delo/contract-home-layout'
import { VERIFICATION_NOTICE, VERIFICATION_REPORT_SCHEMA_VERSION, type VerificationCheckResult, type VerificationMode, type VerificationReport, type VerificationResult } from '@delo/contract-verification-checks'
import type { DeloLogger } from '@delo/logs'
import type { Fetch, RecordedCheck } from '@delo/release-verify'
import { parseRuntimeVersion } from '@delo/runtime-store'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandOutput } from '../command.ts'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { runtimeOfFile } from '../update/runtime.ts'
import { deloVersion } from '../version.ts'
import { changesExit, changesLines, changesSuffix, readVerifyChanges, type VerifyChanges } from './changes.ts'
import { checkRelease, type ReleaseCheckOutcome, type ReleaseOrigins, type RootAnchor } from './checks.ts'

/** The `delorun verify --help` text. */
const VERIFY_USAGE = [
  'Usage: delorun verify [--release <version>] [--offline] [--json]',
  '',
  'Checks the running release, or an installed one, against its signed manifest, the stored timestamp\'s',
  'freshness and its release-log entry, and proves the release log consistent online unless --offline.',
  'Prints one line per check: passed, failed or not run, with the reason, then the changes you approved and',
  'anything present that you did not approve.',
  'Exit codes: 0 when no check failed and release-signature passed or could not reach the release log,',
  '1 otherwise or while content you did not approve runs, 2 for a wrong command line. A release log that cannot be',
  'reached leaves the release not checked against it, with a warning, and does not fail.',
  '',
  '  --release <version>  the installed release to check (default: the running one)',
  '  --offline            run no online check',
  '  --json               print the report as JSON',
  '',
].join('\n')

/**
 * The mode a run reports. `delorun verify` runs every check on request in every mode (contract C15), and nothing reads
 * `integrity.mode` yet, so a run reports the contract's default.
 */
export const VERIFY_MODE: Exclude<VerificationMode, 'off'> = 'warn'

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
   * Whether this `delorun` runs from the runtime store.
   * @param home - the resolved Delo home.
   * @returns false for a source checkout or a development build.
   */
  readonly fromStore: (home: string) => boolean
}

/**
 * Whether this `delorun` runs from the runtime store of a home.
 * @param home - the resolved Delo home.
 * @returns true when this module lies under the home's `runtimes/<version>/`; false for a source checkout or a
 *   development build.
 */
export function runsFromStore(home: string): boolean {
  return runtimeOfFile(home, fileURLToPath(import.meta.url)).store
}

/** This process's fetch, clock, platform and version. */
const PROCESS_ENVIRONMENT: VerifyEnvironment = {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Math.floor(Date.now() / 1000),
  platform: `${process.platform}-${process.arch}`,
  running: deloVersion,
  fromStore: runsFromStore,
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
 * The summary line: what was and was not checked, which no reader should take for more, and what is present that the
 * person did not approve.
 * @param results - one result per registered check.
 * @param changes - what the run found about Changes, when it read them.
 * @returns the line, ending with a newline.
 */
export function summaryLine(results: readonly VerificationCheckResult[], changes?: VerifyChanges): string {
  const count = (result: VerificationResult): number => results.filter(entry => entry.result === result).length
  const parts = [`${String(count('pass'))} checks passed`, `${String(count('fail'))} failed`, `${String(count('unknown'))} not run`]
  if (count('not-enforced') > 0) parts.push(`${String(count('not-enforced'))} not enforced`)
  return `${parts.join(', ')}${changesSuffix(changes)}; this is not a full verification of this Delo.\n`
}

/**
 * The report's lines.
 * @param release - the release checked.
 * @param outcome - what the run found.
 * @param changes - what the run found about Changes, when it read them.
 * @returns the text: a heading, the root line, one line per check, the Changes block and the summary.
 */
export function reportLines(release: string, outcome: Pick<ReleaseCheckOutcome, 'results' | 'root' | 'origins'>, changes?: VerifyChanges): string {
  const width = Math.max(...outcome.results.map(result => result.id.length))
  const lines = outcome.results.map(result => `${LABELS[result.result].padEnd(7)}  ${result.id.padEnd(width)}  ${result.detail}`)
  return `Release ${release}, verification mode ${VERIFY_MODE}; ${VERIFICATION_NOTICE}.\n${rootLine(outcome.root)}${originsLine(outcome.origins)}${lines.join('\n')}\n${changes === undefined ? '' : changesLines(changes)}${summaryLine(outcome.results, changes)}`
}

/**
 * The run's report under contract C15, with the release it checked, the root it anchored on, the release-log state it
 * recorded and where the home's releases come from.
 * @param release - the release.
 * @param outcome - what the run found.
 * @param now - the clock, in Unix seconds.
 * @param changes - what the run found about Changes.
 * @returns the report.
 */
export function report(release: string, outcome: ReleaseCheckOutcome, now: number, changes: VerifyChanges): VerificationReport & { readonly release: string, readonly root: RootAnchor | null, readonly releaseLog: RecordedCheck | null, readonly origins: ReleaseOrigins | null, readonly changes: VerifyChanges } {
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
    changes,
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
      const outcome = await checkRelease({
        home: home.path,
        release,
        platform: environment.platform,
        now,
        fetch: values.offline ? undefined : environment.fetch,
        mode: VERIFY_MODE,
        launcherRoots: context.env[DELO_LAUNCHER_ROOTS_ENV],
        logger: stderrLogger(context),
      })
      const changes = await readVerifyChanges(home.path, profile, environment.fromStore(home.path))
      if (values.json) context.stdout(`${JSON.stringify(report(release, outcome, now, changes))}\n`)
      else context.stdout(reportLines(release, outcome, changes))
      for (const notice of outcome.notices) context.stderr(`notice: ${notice}\n`)
      for (const warning of outcome.warnings) context.stderr(`warning: ${warning}\n`)
      return exitOf(outcome) === EXIT.ok ? changesExit(changes) : EXIT.failed
    },
  }
}

/** `delorun verify`, over this process's fetch, clock, platform and version. */
export const verifyCommand: CliCommand = createVerifyCommand(PROCESS_ENVIRONMENT)
