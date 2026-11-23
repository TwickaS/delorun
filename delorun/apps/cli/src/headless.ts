/**
 * `delorun headless <task>`: the home's `headless` profile, upstream's one-task `headless` template with Delorun's
 * `@delorun/bundle-headless` linked into it ([headless bundle](./headless-bundle.ts)), booted through Delorun's one
 * composition ([compose](./compose.ts)) instead of upstream's command line: its commands run under C1's sandbox
 * overlay, a safe-mode marker for the `headless` profile applies, and the booted Host is held to the invariants of the
 * sandbox row and of every row of the bundle, the fetch guard, the instruction write, MCP and schedule consents, the
 * full-access consent and the turn gate, which holds the task's first step until that check passes. A guard that asks a
 * person refuses here, because the profile composes no answerer. Full access for a working directory whose full access
 * the person has not granted, in the studio or with `delorun workspace full-access`, is refused by the full-access consent inside the Host; a request for it by
 * `--permission-mode` or `DSH_PERMISSION_MODE` is also refused early, before boot ({@link refuseUngrantedFullAccess}).
 *
 * The profile and its layers are Delorun's: the launcher options of upstream's `dsh` (`--profile`, `--patch`,
 * `--from-default-profile` and the configuration dumps) are refused, because each would boot another profile or add a
 * layer after the sandbox overlay. Every other argument reaches the headless app unchanged. The command registers as
 * a shared user of the home's chat data for its life ([home exclusion](./home-exclusion.ts)); it takes no home lock,
 * because it serves no update channel a second run could ask, and two runs may answer two tasks at once.
 *
 * @module @delorun/cli/headless
 */
import { NPM_MIRROR_ENV } from '@delorun/bundle-local/profile'
import { mkdirSync } from 'node:fs'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { HEADLESS_PROFILE, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import type { RequiredModelKey } from './model-key.ts'
import { runDirectory, shellQuote } from '@delorun/home'
import { HostNotStoppedError, refuseBootedHost } from '@delorun/home-process'
import { FULL_ACCESS_PRESET, fullAccessGranted, permissionStorePath, readPermissionStore } from '@delorun/plugin-permission-defaults/store'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import { dangerousModeHolds } from './setup/dangerous.ts'
import type { CommandOutput, CommandResult } from './command.ts'
import { assertDelorunInvariants, composeDelorunProfile, packLayersOf, type ComposeDependencies } from './compose.ts'
import { providePackLayers } from './pack-layers-service.ts'
import { CliError, EXIT } from './exit.ts'
import { isRecord, rowPatches, type PatchLayer } from './patch-layers.ts'
import { runPreStartSteps, type PreStartStep } from './pre-start.ts'
import { printable } from './terminal-text.ts'
import { settleSecrets, type BootedProfile } from './start.ts'

/** The upstream profile `delorun headless` boots, which contract C1 reserves as a CLI profile name. */
export { HEADLESS_PROFILE } from '@delorun/contract-home-layout'

/** Upstream's launcher options, which `delorun headless` refuses because they choose the profile or its layers. */
export const REFUSED_LAUNCHER_OPTIONS = ['--profile', '--patch', '--from-default-profile', '--dump-config', '--dump-default-config', '--dump-config-schema'] as const

/** What a headless run calls outside this module; specs replace them. */
export interface HeadlessDependencies extends ComposeDependencies {
  /**
   * Finds the model key the headless profile's default model needs, the way the model would, before anything boots.
   * @param request - the home, the output and the environment.
   * @returns the key the profile needs and cannot find, or `undefined` when it has the key or needs none from the CLI.
   */
  readonly missingModelKey: (request: HeadlessRequest) => Promise<RequiredModelKey | undefined>
  /** Loads the launch environment with upstream's `.env` layers. */
  readonly loadEnvironment: () => RunProfileOptions['environment']
  /** Boots the profile; upstream's `runProfile` in a real run. */
  readonly runProfile: (options: RunProfileOptions) => Promise<BootedProfile>
  /** The ordered steps before any Host boots ([pre-start](./pre-start.ts)); the real start's in a real run. */
  readonly preStartSteps: readonly PreStartStep[]
  /**
   * The working directory, which upstream's headless profile takes as the task's workspace.
   * @returns the directory; `process.cwd()` in a real run.
   */
  readonly cwd: () => string
  /**
   * Registers the teardown the CLI's last-resort handler runs before it ends the process on a crash; the CLI's
   * `registerFatalRelease` in a real run.
   * @param teardown - disposes the booted Host.
   * @returns the unregistration.
   */
  readonly fatalRelease: (teardown: () => Promise<void>) => () => void
}

/** What one headless run is given. */
export interface HeadlessRequest {
  /** The prepared Delorun home. */
  readonly home: string
  /** The arguments after `headless`. */
  readonly args: readonly string[]
  /** Where the run writes. */
  readonly output: CommandOutput
  /** The launch environment. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Upstream's variable that sets the headless profile's sandbox mode, which only the launching environment may set. */
export const PERMISSION_MODE_ENV = 'DSH_PERMISSION_MODE'

/** The id of upstream's permission-preset row, whose `presets` map each preset name to a sandbox mode. */
const PERMISSION_ROW = 'permission'

/**
 * A preset name or a sandbox mode as the comparison reads it: trimmed and case-folded, so a spelling that upstream
 * would refuse as unknown still counts as asking for full access.
 * @param value - the name or mode.
 * @returns the folded value.
 */
function folded(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The preset names that select full access in a composed profile: `danger-full-access`, and every preset that any
 * layer's `permission` row maps to the `danger-full-access` sandbox mode, folded. A name that one layer maps to full
 * access counts even when a later layer maps it elsewhere, so the early refusal errs towards refusing.
 * @param layers - the composed profile's patch layers.
 * @returns the folded names.
 */
export function fullAccessPresetNames(layers: readonly PatchLayer[]): ReadonlySet<string> {
  const names = new Set<string>([FULL_ACCESS_PRESET])
  for (const layer of layers) {
    for (const row of rowPatches(layer.patches, PERMISSION_ROW)) {
      const presets = isRecord(row.config) ? row.config.presets : undefined
      if (!isRecord(presets)) continue
      for (const [name, spec] of Object.entries(presets)) {
        if (isRecord(spec) && typeof spec.sandbox === 'string' && folded(spec.sandbox) === FULL_ACCESS_PRESET) names.add(folded(name))
      }
    }
  }
  return names
}

/**
 * The full-access sources among a headless run's arguments and environment: a `--permission-mode` preset that selects
 * full access, and `DSH_PERMISSION_MODE` set to the full-access sandbox mode, each compared trimmed and case-folded.
 * @param args - the arguments after `headless`.
 * @param env - the launch environment.
 * @param presets - the folded preset names that select full access ({@link fullAccessPresetNames}).
 * @returns how the run asks for full access: the option, the variable, both, or none.
 */
export function fullAccessRequests(args: readonly string[], env: Readonly<Record<string, string | undefined>>, presets: ReadonlySet<string> = new Set([FULL_ACCESS_PRESET])): readonly string[] {
  const requests: string[] = []
  for (let at = 0; at < args.length; at++) {
    const argument = args[at]!
    if (argument === '--') break
    const value = argument === '--permission-mode' ? args[at + 1] : argument.startsWith('--permission-mode=') ? argument.slice('--permission-mode='.length) : undefined
    if (value !== undefined && presets.has(folded(value))) requests.push(`--permission-mode ${value.trim()}`)
  }
  const mode = env[PERMISSION_MODE_ENV]
  if (mode !== undefined && folded(mode) === FULL_ACCESS_PRESET) requests.push(`${PERMISSION_MODE_ENV}=${mode.trim()}`)
  return requests
}

/**
 * Refuse early, before boot, a run that asks for full access in a working directory whose full access the person has
 * not granted, so the run stops with the workspace named and no task starts. The enforcement is the guard of
 * `@delorun/plugin-permission-defaults` inside the Host, which refuses every switch to full access without a grant
 * however it is asked for; this check only refuses the requests it can read from the arguments and environment.
 * @param home - the Delorun home.
 * @param args - the arguments after `headless`.
 * @param env - the launch environment.
 * @param cwd - the working directory, the task's workspace.
 * @param presets - the folded preset names that select full access ({@link fullAccessPresetNames}).
 * @throws {CliError} naming the request, the workspace and how to grant full access, when the store holds no grant for
 *   it or cannot be read.
 */
export async function refuseUngrantedFullAccess(home: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string, presets?: ReadonlySet<string>): Promise<void> {
  const requests = fullAccessRequests(args, env, presets)
  if (requests.length === 0) return
  if (await dangerousModeHolds(home)) return
  const workspace = workspaceKey(cwd)
  const read = await readPermissionStore(permissionStorePath(home))
  switch (read.kind) {
    case 'readable':
      if (fullAccessGranted(read.entries, workspace)) return
      break
    case 'absent':
      break
    case 'refused':
      throw new CliError(EXIT.failed, `delorun headless: ${requests.join(' and ')} asks for full access in ${JSON.stringify(workspace)}, and Delorun's record of full-access grants, ${permissionStorePath(home)}, cannot be read (${read.problem}), so no grant counts and Delorun did not start the task. Repair or remove that file, then turn full access on for this folder again: delorun workspace full-access ${printable(shellQuote(workspace))} on`)
    default:
      read satisfies never
  }
  throw new CliError(EXIT.failed, `delorun headless: ${requests.join(' and ')} asks for full access in ${JSON.stringify(workspace)}, which you have not granted full access, so Delorun did not start the task. Full access lets the task's commands read Delorun's home and reach its channels. To grant it at this computer, run delorun workspace full-access ${printable(shellQuote(workspace))} on, or turn it on in the studio's Settings → Safety → Permissions; delorun headless in this folder then keeps that grant. Or run without full access.`)
}

/**
 * Refuse an upstream launcher option among the arguments.
 * @param args - the arguments after `headless`.
 * @throws {CliError} with the usage code, naming the option.
 */
export function refuseLauncherOptions(args: readonly string[]): void {
  const refused = args.find(argument => REFUSED_LAUNCHER_OPTIONS.some(option => argument === option || argument.startsWith(`${option}=`)))
  if (refused === undefined) return
  throw new CliError(EXIT.usage, `delorun headless: ${refused.split('=')[0]!} is refused: delorun headless boots the ${HEADLESS_PROFILE} profile through Delorun's composition, with its sandbox protection last, so it takes no other profile and no extra layer; pass only the task's own arguments`)
}

/**
 * Compose the headless profile, boot it and hold it to the invariants; the headless app then answers the task and
 * ends the process through upstream's profile runner.
 * @param request - the home, the arguments, the output and the environment.
 * @param dependencies - the profile preparation, the approved plugin content step, the environment loader and the runner.
 * @returns `undefined`: upstream's profile runner sets the exit code when the task ends.
 * @throws {CliError} when an argument is refused, the composition refuses, the profile fails to boot, the booted
 *   rows break an invariant, which first tears the profile down within `REFUSED_HOST_STOP_S`, without ending the
 *   process.
 * @throws {HostNotStoppedError} carrying the refusal when that teardown failed or overran; upstream's bounded shutdown
 *   then ends the process with {@link EXIT.failed} in the next turn of the event loop.
 */
export async function runHeadless(request: HeadlessRequest, dependencies: HeadlessDependencies): Promise<CommandResult> {
  refuseLauncherOptions(request.args)
  const missing = await dependencies.missingModelKey(request)
  if (missing !== undefined) {
    throw new CliError(EXIT.failed, `delorun headless: Delorun has no ${missing.label} API key, so it cannot answer. Set ${missing.variable} in your shell, or run delorun setup key.`)
  }
  mkdirSync(runDirectory(request.home, HEADLESS_PROFILE), { recursive: true, mode: PRIVATE_DIR_MODE })
  await runPreStartSteps(dependencies.preStartSteps, { home: request.home, profile: HEADLESS_PROFILE, kind: 'headless', successor: false, output: request.output })
  const composed = await composeDelorunProfile({ home: request.home, profile: HEADLESS_PROFILE, kind: 'headless', output: request.output, env: request.env }, dependencies)
  await refuseUngrantedFullAccess(request.home, request.args, request.env, dependencies.cwd(), fullAccessPresetNames(composed.layers))
  // The Host boots in this process, so `@delorun/bundle-headless`'s `plugin-manager` row reads the mirror setting from here.
  process.env[NPM_MIRROR_ENV] = composed.npmMirror ? 'on' : 'off'
  // A crash after boot ends the process through the CLI's last-resort handler, which first disposes the booted Host
  // within its bound; the registration lasts as long as the run, which upstream's runner ends.
  let current: BootedProfile | undefined
  const unregister = dependencies.fatalRelease(async () => { await current?.dispose() })
  let booted: BootedProfile
  try {
    booted = current = await dependencies.runProfile({
      environment: dependencies.loadEnvironment(),
      profile: HEADLESS_PROFILE,
      resolvedProfile: composed.resolvedProfile,
      patchFiles: composed.patchFiles,
      args: request.args,
      // The MCP consent reads the composition's judgement of the bundle layers at each review.
      prepare: (root) => { providePackLayers(root, packLayersOf(composed.request, composed.resolvedProfile.profile.dir, composed.releasePacks)) },
    })
  } catch (error) {
    unregister()
    throw new CliError(EXIT.failed, `delorun headless: the ${HEADLESS_PROFILE} profile failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    assertDelorunInvariants(composed, booted)
  } catch (error) {
    // The refused profile stops through its own teardown, which ends no process, so the refusal is reported.
    await refuseBootedHost(() => booted.dispose(), error).catch((failure: unknown) => {
      // Upstream's runner owns this process: once `main` has reported the refusal in this turn of the event loop, its
      // bounded shutdown ends the process with a failure code, and the profile that may still run ends with it.
      if (failure instanceof HostNotStoppedError) setImmediate(() => { void booted.shutdown(EXIT.failed) })
      else unregister()
      throw failure
    })
  }
  await settleSecrets(booted, request.home, HEADLESS_PROFILE, request.output)
  booted.releaseTurns()
  return undefined
}
