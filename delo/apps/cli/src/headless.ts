/**
 * `delorun headless <task>`: upstream's one-task `headless` profile, booted through Delo's one composition
 * ([compose](./compose.ts)) instead of upstream's command line, so its commands run under C1's sandbox overlay, a
 * safe-mode marker for the `headless` profile applies, and the booted rows are held to the sandbox invariants. The
 * profile carries no Delo bundle, so no Delo row is required of it.
 *
 * The profile and its layers are Delo's: the launcher options of upstream's `dsh` (`--profile`, `--patch`,
 * `--from-default-profile` and the configuration dumps) are refused, because each would boot another profile or add a
 * layer after the sandbox overlay. Every other argument reaches the headless app unchanged. The command registers as
 * a shared user of the home's chat data for its life ([home exclusion](./home-exclusion.ts)); it takes no home lock,
 * because it serves no update channel a second run could ask, and two runs may answer two tasks at once.
 *
 * @module @delo/cli/headless
 */
import { mkdirSync } from 'node:fs'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { HEADLESS_PROFILE, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { runDirectory } from '@delo/home'
import { HostNotStoppedError, refuseBootedHost } from '@delo/home-process'
import type { CommandOutput, CommandResult } from './command.ts'
import { assertDeloInvariants, composeDeloProfile, type ComposeDependencies } from './compose.ts'
import { CliError, EXIT } from './exit.ts'
import { runPreStartSteps, type PreStartStep } from './pre-start.ts'
import type { BootedProfile } from './start.ts'

/** The upstream profile `delorun headless` boots, which contract C1 reserves as a CLI profile name. */
export { HEADLESS_PROFILE } from '@delo/contract-home-layout'

/** Upstream's launcher options, which `delorun headless` refuses because they choose the profile or its layers. */
export const REFUSED_LAUNCHER_OPTIONS = ['--profile', '--patch', '--from-default-profile', '--dump-config', '--dump-default-config', '--dump-config-schema'] as const

/** What a headless run calls outside this module; specs replace them. */
export interface HeadlessDependencies extends ComposeDependencies {
  /** Loads the launch environment with upstream's `.env` layers. */
  readonly loadEnvironment: () => RunProfileOptions['environment']
  /** Boots the profile; upstream's `runProfile` in a real run. */
  readonly runProfile: (options: RunProfileOptions) => Promise<BootedProfile>
  /** The ordered steps before any Host boots ([pre-start](./pre-start.ts)); the real start's in a real run. */
  readonly preStartSteps: readonly PreStartStep[]
}

/** What one headless run is given. */
export interface HeadlessRequest {
  /** The prepared Delo home. */
  readonly home: string
  /** The arguments after `headless`. */
  readonly args: readonly string[]
  /** Where the run writes. */
  readonly output: CommandOutput
  /** The launch environment. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Refuse an upstream launcher option among the arguments.
 * @param args - the arguments after `headless`.
 * @throws {CliError} with the usage code, naming the option.
 */
export function refuseLauncherOptions(args: readonly string[]): void {
  const refused = args.find(argument => REFUSED_LAUNCHER_OPTIONS.some(option => argument === option || argument.startsWith(`${option}=`)))
  if (refused === undefined) return
  throw new CliError(EXIT.usage, `delorun headless: ${refused.split('=')[0]!} is refused: delorun headless boots the ${HEADLESS_PROFILE} profile through Delo's composition, with its sandbox protection last, so it takes no other profile and no extra layer; pass only the task's own arguments`)
}

/**
 * Compose the headless profile, boot it and hold it to the invariants; the headless app then answers the task and
 * ends the process through upstream's profile runner.
 * @param request - the home, the arguments, the output and the environment.
 * @param dependencies - the profile preparation, the approved plugin content step, the environment loader and the runner.
 * @returns `undefined`: upstream's profile runner sets the exit code when the task ends.
 * @throws {CliError} when an argument is refused, the composition refuses, the profile fails to boot, or the booted
 *   rows break an invariant, which first tears the profile down within `REFUSED_HOST_STOP_S`, without ending the
 *   process.
 * @throws {HostNotStoppedError} carrying the refusal when that teardown failed or overran; upstream's bounded shutdown
 *   then ends the process with {@link EXIT.failed} in the next turn of the event loop.
 */
export async function runHeadless(request: HeadlessRequest, dependencies: HeadlessDependencies): Promise<CommandResult> {
  refuseLauncherOptions(request.args)
  mkdirSync(runDirectory(request.home, HEADLESS_PROFILE), { recursive: true, mode: PRIVATE_DIR_MODE })
  await runPreStartSteps(dependencies.preStartSteps, { home: request.home, profile: HEADLESS_PROFILE, kind: 'headless', successor: false, output: request.output })
  const composed = await composeDeloProfile({ home: request.home, profile: HEADLESS_PROFILE, kind: 'headless', output: request.output, env: request.env }, dependencies)
  let booted: BootedProfile
  try {
    booted = await dependencies.runProfile({
      environment: dependencies.loadEnvironment(),
      profile: HEADLESS_PROFILE,
      resolvedProfile: composed.resolvedProfile,
      patchFiles: composed.patchFiles,
      args: request.args,
    })
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun headless: the ${HEADLESS_PROFILE} profile failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    assertDeloInvariants(composed, booted)
  } catch (error) {
    // The refused profile stops through its own teardown, which ends no process, so the refusal is reported.
    await refuseBootedHost(() => booted.dispose(), error).catch((failure: unknown) => {
      // Upstream's runner owns this process: once `main` has reported the refusal in this turn of the event loop, its
      // bounded shutdown ends the process with a failure code, and the profile that may still run ends with it.
      if (failure instanceof HostNotStoppedError) setImmediate(() => { void booted.shutdown(EXIT.failed) })
      throw failure
    })
  }
  booted.releaseTurns()
  return undefined
}
