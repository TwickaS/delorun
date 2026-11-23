/**
 * Dangerous mode, the third prompts answer of `delorun setup`: the warning and the two-step consent that precede it,
 * the refusals of the scripted forms and of a root user, and the grant file that makes full access available to every
 * chat. The `delorun-permission-defaults` row's `fullAccessEverywhere` setting alone grants nothing; the plugin honours
 * it only while this file is valid, and only `delorun setup` and the studio's computer-only confirmation write it. The
 * warning text and the root check are `@delorun/setup-apply`'s.
 *
 * The grant file is `<home>/secrets/permission-defaults/full-access-everywhere.json`; the plugin's store module
 * (`@delorun/plugin-permission-defaults/store`) reads, writes and removes it.
 *
 * @module @delorun/cli/setup/dangerous
 */
import { join } from 'node:path'
import { CLI_PROFILE } from '@delorun/contract-home-layout'
import { DANGEROUS_PHRASE, type PromptsAnswer } from '@delorun/contract-setup-answers'
import { dangerousGrantPath, readDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import { DANGEROUS_WARNING_LINES, runsAsRoot } from '@delorun/setup-apply'
import { CliError, EXIT } from '../exit.ts'
import { readPromptsAnswer } from './prompt-switches.ts'
import { BACK, type Back, type StepIO } from './steps.ts'

/** The line `delorun` prints at start and `delorun status` prints while dangerous mode is on. */
export const DANGEROUS_ON_LINE = 'Dangerous mode is on: any chat can switch to full access without asking. Turn it off with `delorun setup prompts`.'

/** The sentence a refusal gives for a root user. */
const ROOT_REFUSAL = 'dangerous mode is refused when running as root, because full access then reaches the whole computer, not one user\'s account; run delorun as an ordinary user, as Claude Code requires for its bypass mode'

/**
 * Refuse a dangerous answer for a root user.
 * @param answer - the prompts answer.
 * @param source - the command or form that starts the message.
 * @throws {CliError} `EXIT.failed` when the answer is `dangerous` and the process runs as root.
 */
export function refuseDangerousAsRoot(answer: PromptsAnswer, source: string): void {
  if (answer === 'dangerous' && runsAsRoot()) throw new CliError(EXIT.failed, `${source}: ${ROOT_REFUSAL}`)
}

/** The scripted flags that name the prompts answer. */
export interface PromptsFlags {
  /** `--prompts`, if given. */
  readonly prompts?: string | undefined
  /** `--accept-dangerous-mode`. */
  readonly acceptDangerousMode?: boolean | undefined
}

/**
 * The prompts answer a scripted command line names. `--yes` alone keeps setup's default; `dangerous` needs both
 * `--prompts dangerous` and `--accept-dangerous-mode`, which stands for the two-step consent of the interactive form.
 * @param flags - the parsed flags.
 * @param yes - whether `--yes` was given.
 * @param option - the `--prompts` values setup accepts.
 * @returns the answer, or `undefined` when no flag names one.
 * @throws {CliError} `EXIT.usage` for a flag outside `--yes`, an unknown answer, `dangerous` without the accept flag, the
 *   accept flag without `dangerous`, or `dangerous` for a root user.
 */
export function promptsFromFlags(flags: PromptsFlags, yes: boolean, option: readonly PromptsAnswer[]): PromptsAnswer | undefined {
  const accept = flags.acceptDangerousMode === true
  if (flags.prompts === undefined && !accept) return undefined
  if (!yes) throw new CliError(EXIT.usage, 'delorun setup: --prompts and --accept-dangerous-mode apply to --yes; a --config document names the answer in prompts, and a terminal run asks')
  if (flags.prompts === undefined) throw new CliError(EXIT.usage, 'delorun setup: --accept-dangerous-mode needs --prompts dangerous')
  const answer = option.find(candidate => candidate === flags.prompts)
  if (answer === undefined) throw new CliError(EXIT.usage, `delorun setup: --prompts must be one of ${option.join(', ')}`)
  if (answer !== 'dangerous' && accept) throw new CliError(EXIT.usage, 'delorun setup: --accept-dangerous-mode applies to --prompts dangerous only')
  if (answer === 'dangerous' && !accept) throw new CliError(EXIT.usage, 'delorun setup: --prompts dangerous needs --accept-dangerous-mode, which states that you have read what dangerous mode allows (delorun setup prompts shows the warning)')
  refuseDangerousAsRoot(answer, 'delorun setup --prompts')
  return answer
}

/**
 * Ask the two-step consent of the interactive form: the warning and a yes-or-no that starts on No, then the phrase.
 * @param io - the questions of the prompts section.
 * @returns true when the person accepted both steps, false when either was declined or the phrase was not typed
 *   exactly, or {@link BACK} when the person went back.
 * @throws {CliError} `EXIT.failed` for a root user, before the warning is shown.
 */
export async function askDangerousConsent(io: StepIO): Promise<boolean | Back> {
  refuseDangerousAsRoot('dangerous', 'delorun setup')
  const followUp = io.followUp()
  followUp.note(DANGEROUS_WARNING_LINES.join('\n\n'), 'Dangerous mode')
  const understood = await followUp.confirm('Allow any chat to switch to full access without asking?', false)
  if (understood === BACK || !understood) return understood
  const typed = await followUp.text(`To confirm, type ${DANGEROUS_PHRASE}`, '', () => undefined)
  return typed === BACK ? BACK : typed === DANGEROUS_PHRASE
}

/** Whether dangerous mode is in force on a profile. */
export type DangerousState =
  /** The profile's answer is not `dangerous`. */
  | { readonly kind: 'off' }
  /** The answer is `dangerous` and the grant file is valid. */
  | { readonly kind: 'on', readonly grantedAt: string }
  /** The answer is `dangerous` but the grant file is absent or refused, so the plugin grants nothing. */
  | { readonly kind: 'inactive', readonly problem: string }

/**
 * Whether a valid dangerous-mode grant file exists, so a person who already confirmed does not confirm again.
 * @param home - the resolved Delorun home.
 * @returns true when the grant file is present and in the format this version reads.
 */
export async function hasDangerousGrant(home: string): Promise<boolean> {
  return (await readDangerousGrant(dangerousGrantPath(home))).kind === 'valid'
}

/**
 * Whether dangerous mode is on for a profile, for the start, `delorun status` and `delorun doctor`.
 * @param home - the resolved Delorun home.
 * @param profileDirectory - the CLI profile's directory, whose answers record names the prompts answer.
 * @returns `off` for any other answer; `on` with the grant time; or `inactive` with the problem.
 */
export async function dangerousModeState(home: string, profileDirectory: string): Promise<DangerousState> {
  if (readPromptsAnswer(profileDirectory) !== 'dangerous') return { kind: 'off' }
  const grant = await readDangerousGrant(dangerousGrantPath(home))
  if (grant.kind === 'valid') return { kind: 'on', grantedAt: grant.grantedAt }
  const PARSED = 'the dangerous-mode grant file '
  if (grant.kind === 'absent') return { kind: 'inactive', problem: 'its grant file is missing' }
  // A file that was read but is not this version's grant keeps the plugin's words; a refused read names the refusal.
  return { kind: 'inactive', problem: grant.problem.startsWith(PARSED) ? `its grant file ${grant.problem.slice(PARSED.length)}` : `its grant file is refused: ${grant.problem}` }
}

/**
 * The lines the visibility commands print for a state.
 * @param state - the state.
 * @returns the line, or `undefined` while dangerous mode is off.
 */
export function dangerousStateLine(state: DangerousState): string | undefined {
  if (state.kind === 'off') return undefined
  if (state.kind === 'on') return DANGEROUS_ON_LINE
  return `Dangerous mode is chosen but not active: ${state.problem}, so full access still needs each workspace's own consent. Run \`delorun setup prompts\` to choose again.`
}

/**
 * The line a visibility command prints for a profile.
 * @param home - the resolved Delorun home.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the line, or `undefined` while the profile's answer is not `dangerous`.
 */
export async function dangerousModeLine(home: string, profileDirectory: string): Promise<string | undefined> {
  return dangerousStateLine(await dangerousModeState(home, profileDirectory))
}

/**
 * Whether dangerous mode holds for the whole home: the CLI profile's answer is `dangerous` and the grant file is valid.
 * `delorun headless` reads its permission from the same answer record, because it has no setup of its own.
 * @param home - the resolved Delorun home.
 * @returns whether the effective rule holds.
 */
export async function dangerousModeHolds(home: string): Promise<boolean> {
  return (await dangerousModeState(home, join(home, 'profiles', CLI_PROFILE))).kind === 'on'
}
