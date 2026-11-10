/**
 * The closure lane: build the `linux-x64` runtime closure of `HEAD` from the worktree's built artifacts with the release
 * recipe (`delo/apps/release/src/build-closure.ts --artifacts existing`), then run the closure specs
 * (`delo/apps/release/tests/closure/boot.closure.spec.ts`) against the archive: setup and start from the extracted
 * closure, the studio on loopback, and `--version` with one command of every top-level command. A dependency cycle
 * among the release tooling's packages, a module the closure does not carry, or a command that crashes instead of
 * refusing fails the lane before the change reaches the trunk. The module is the check's command; the archive and the
 * build's directory are removed when it ends.
 *
 * @module @delo/tools/checks/closure
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from '../git.ts'

/** The check's id, which the catalogue, `--only` and `budgets.json` name. */
export const CLOSURE_CHECK_ID = 'tests:closure'
/** This module, which is the check's command after the tsx launcher. */
export const CLOSURE_LANE_MODULE = 'delo/apps/tools/src/checks/closure.ts'
/** The closure specs the lane runs against the archive it builds. */
export const CLOSURE_SPEC = 'delo/apps/release/tests/closure/boot.closure.spec.ts'
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

/**
 * Build the closure and run the closure specs against it.
 * @param root - the repository root.
 * @returns the exit status: 0 when the closure built and every closure spec passed.
 */
export function runClosureLane(root: string): number {
  const out = mkdtempSync(join(tmpdir(), 'delo-closure-lane-'))
  try {
    const built = step(root, ['node_modules/.bin/tsx', 'delo/apps/release/src/build-closure.ts', '--version', CLOSURE_VERSION, '--out', out, '--platform', CLOSURE_PLATFORM, '--artifacts', 'existing'])
    if (built !== 0) return built
    const archive = readdirSync(out).find(name => name.endsWith(`-${CLOSURE_PLATFORM}.tar.gz`))
    if (archive === undefined) {
      console.error(`closure: build-closure wrote no ${CLOSURE_PLATFORM} archive to ${out}`)
      return 1
    }
    return step(root, ['node_modules/.bin/vitest', 'run', '--config', 'delo/vitest.config.ts', CLOSURE_SPEC], { DELO_CLOSURE_ARCHIVE: join(out, archive), DELO_CLOSURE_EXISTING_ARTIFACTS: '1' })
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
