/**
 * The closure lane: build the `linux-x64` runtime closure of `HEAD` from the worktree's built artifacts with the release
 * recipe (`delo/apps/release/src/build-closure.ts --artifacts existing`), then run the closure specs
 * (`delo/apps/release/tests/closure/boot.closure.integration.spec.ts`) against the archive: setup and start from the
 * extracted closure, the studio on loopback, and `--version` with one command of every top-level command. A dependency
 * cycle among the release tooling's packages, a module the closure does not carry, or a command that crashes instead of
 * refusing fails the lane before the change reaches the trunk. The lane fails too when the spec file is missing, or
 * when the run passes no test or skips one, so a renamed spec or an archive the spec does not see never passes. The
 * module is the check's command; the archive and the build's directory are removed when it ends.
 *
 * @module @delo/tools/checks/closure
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from '../git.ts'

/** The check's id, which the catalogue, `--only` and `budgets.json` name. */
export const CLOSURE_CHECK_ID = 'tests:closure'
/** This module, which is the check's command after the tsx launcher. */
export const CLOSURE_LANE_MODULE = 'delo/apps/tools/src/checks/closure.ts'
/** The closure specs the lane runs against the archive it builds. */
export const CLOSURE_SPEC = 'delo/apps/release/tests/closure/boot.closure.integration.spec.ts'
/** The Vitest project that holds {@link CLOSURE_SPEC}: the integration project, since the spec starts processes. */
const CLOSURE_PROJECT = 'fork-integration'
/** The platform the lane builds and boots: the closure specs extract a `linux-x64` archive and run its Node. */
export const CLOSURE_PLATFORM = 'linux-x64'
/** The version the lane's closure carries; it is never published. */
const CLOSURE_VERSION = '0.0.0'

/**
 * Why this host cannot run the lane.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the reason, or `undefined` on a `linux-x64` host.
 */
export function closureHostProblem(platform: string, arch: string): string | undefined {
  return `${platform}-${arch}` === CLOSURE_PLATFORM ? undefined : `the closure lane builds and boots the ${CLOSURE_PLATFORM} closure, and this host is ${platform}-${arch}`
}

/**
 * Run one step of the lane with the output inherited.
 * @param root - the repository root, the step's working directory.
 * @param command - the command and its arguments.
 * @param env - variables over the inherited environment.
 * @returns the step's exit status; 1 when it did not start or a signal ended it.
 */
function step(root: string, command: readonly string[], env: Readonly<Record<string, string>> = {}): number {
  console.log(`closure: ${command.join(' ')}`)
  const result = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.error !== undefined) console.error(`closure: ${command[0]!} did not start: ${result.error.message}`)
  return result.status ?? 1
}

/** The counts of a Vitest JSON report that say whether the closure specs ran. */
interface SpecCounts {
  readonly numTotalTests: number
  readonly numPassedTests: number
  readonly numFailedTests: number
  readonly numPendingTests: number
  readonly numTodoTests: number
}

/**
 * Why a closure spec run that exited 0 does not count as a pass: no test ran, or a test was skipped, as when the spec
 * file is not found or the spec does not see the archive.
 * @param report - the text of the run's Vitest JSON report.
 * @returns the reason, or `undefined` when every test ran and passed.
 */
export function closureRunProblem(report: string): string | undefined {
  let counts: SpecCounts
  try {
    counts = JSON.parse(report) as SpecCounts
  } catch (error) {
    return `the closure specs' report does not read: ${error instanceof Error ? error.message : String(error)}`
  }
  if (typeof counts.numTotalTests !== 'number' || counts.numTotalTests === 0) return `no closure test ran; ${CLOSURE_SPEC} found no test to run`
  const unrun = counts.numPendingTests + counts.numTodoTests
  if (unrun > 0) return `${String(unrun)} of ${String(counts.numTotalTests)} closure tests did not run`
  if (counts.numFailedTests > 0 || counts.numPassedTests !== counts.numTotalTests) return `${String(counts.numTotalTests - counts.numPassedTests)} of ${String(counts.numTotalTests)} closure tests did not pass`
  return undefined
}

/**
 * Build the closure and run the closure specs against it.
 * @param root - the repository root.
 * @returns the exit status: 0 when the closure built and every closure spec passed.
 */
export function runClosureLane(root: string): number {
  if (!existsSync(join(root, CLOSURE_SPEC))) {
    console.error(`closure: the closure spec ${CLOSURE_SPEC} does not exist`)
    return 1
  }
  const out = mkdtempSync(join(tmpdir(), 'delo-closure-lane-'))
  try {
    const built = step(root, ['node_modules/.bin/tsx', 'delo/apps/release/src/build-closure.ts', '--version', CLOSURE_VERSION, '--out', out, '--platform', CLOSURE_PLATFORM, '--artifacts', 'existing'])
    if (built !== 0) return built
    const archive = readdirSync(out).find(name => name.endsWith(`-${CLOSURE_PLATFORM}.tar.gz`))
    if (archive === undefined) {
      console.error(`closure: build-closure wrote no ${CLOSURE_PLATFORM} archive to ${out}`)
      return 1
    }
    const report = join(out, 'closure-specs.json')
    const ran = step(root, ['node_modules/.bin/vitest', 'run', '--config', 'delo/vitest.config.ts', '--project', CLOSURE_PROJECT, '--reporter', 'default', '--reporter', 'json', '--outputFile.json', report, CLOSURE_SPEC], { DELO_CLOSURE_ARCHIVE: join(out, archive), DELO_CLOSURE_EXISTING_ARTIFACTS: '1' })
    if (ran !== 0) return ran
    const problem = closureRunProblem(existsSync(report) ? readFileSync(report, 'utf8') : '')
    if (problem !== undefined) {
      console.error(`closure: ${problem}`)
      return 1
    }
    return 0
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = closureHostProblem(process.platform, process.arch)
  if (problem !== undefined) {
    console.error(`closure: ${problem}`)
    process.exitCode = 1
  } else {
    process.exitCode = runClosureLane(repositoryRoot(process.cwd()))
  }
}
