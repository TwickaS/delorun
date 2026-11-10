/**
 * The `parity-replay:control` check, the negative control of the parity replay (contract C16, denial test
 * `parity replay refuses a model-visible switch left on`): it replays one recorded headless scenario through
 * upstream's snapshot adapter with a planted overlay that leaves the `profile_history` switch on, and passes only when
 * that replay fails on the model-visible difference. A replay that passed would mean the overlay does not reach the
 * scenario's processes, so `parity-replay`'s pass would prove nothing. Run from the repository root:
 * `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/replay-control.ts`. It exits 0 when the replay refused
 * the planted switch, and 1 with the replay's output otherwise.
 *
 * @module @delo/tools/parity/composition/replay-control
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { PARITY_OVERLAY_ENV } from '@delo/contract-parity-composition'
import { repositoryRoot } from '../../git.ts'

/** The planted overlay, repository-relative. */
export const SWITCH_LEFT_ON_PATH = 'delo/apps/tools/src/parity/composition/switch-left-on.overlay.yml'

/** The headless scenario whose recorded tool schemas hold upstream's `plugin_manager` tool. */
export const CONTROL_SCENARIO = 'replays plugin-manager through dsh --profile headless'

/** The most the replay may take; one scenario measured under a minute on a busy host. */
const CONTROL_TIMEOUT_MS = 600_000

/** One replay run to start: the command, its arguments and the variables it sets. */
export interface ControlRun {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * The replay the control runs: upstream's headless snapshot adapter, filtered to {@link CONTROL_SCENARIO}, in replay
 * mode, with the planted overlay.
 * @returns the run.
 */
export function controlRun(): ControlRun {
  return {
    command: 'node_modules/.bin/vitest',
    args: ['run', '--config', 'vitest.snapshot.config.ts', 'snapshots/session/headless.snapshot.ts', '-t', CONTROL_SCENARIO],
    env: { DSH_SNAPSHOT: 'replay', [PARITY_OVERLAY_ENV]: SWITCH_LEFT_ON_PATH },
  }
}

/**
 * The environment the replay gets: the runner's, without the variables that would make it a Vitest worker, a model
 * key or another overlay, plus the run's own.
 * @param inherited - the runner's environment.
 * @param run - the run.
 * @returns the replay's environment.
 */
export function controlEnv(inherited: NodeJS.ProcessEnv, run: ControlRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (!/^(?:VITEST|TEST$|NODE_ENV$|DEEPSEEK_|DSH_)/u.test(key)) env[key] = value
  }
  return { ...env, ...run.env }
}

/**
 * The control's verdict on a finished replay.
 * @param status - the replay's exit status; null when a signal or the timeout ended it.
 * @param output - its standard output and error.
 * @returns undefined when the replay failed on the planted switch, else why the control fails.
 */
export function controlFailure(status: number | null, output: string): string | undefined {
  if (status === 1 && output.includes('plugin-manager: request header 1') && output.includes('1 failed')) return undefined
  if (status === 0) return 'the replay passed with the profile_history switch left on, so the parity overlay does not reach the replay'
  return `the replay did not fail on the planted switch's request header (exit ${String(status)}), so the control proves nothing`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = controlRun()
  const result = spawnSync(run.command, [...run.args], { cwd: repositoryRoot(process.cwd()), encoding: 'utf8', env: controlEnv(process.env, run), maxBuffer: 64 * 1024 * 1024, timeout: CONTROL_TIMEOUT_MS })
  const failure = controlFailure(result.status, `${result.stdout}${result.stderr}`)
  if (failure === undefined) {
    console.log('parity-replay:control: the replay refused the planted profile_history switch')
  } else {
    console.error(`${result.stdout}${result.stderr}`)
    console.error(`parity-replay:control: ${failure}`)
  }
  process.exitCode = failure === undefined ? 0 : 1
}
