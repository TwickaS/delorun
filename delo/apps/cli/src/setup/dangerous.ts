/**
 * Dangerous mode, the third prompts answer of `delorun setup`: the warning and the two-step consent that precede it,
 * the refusals of the scripted forms and of a root user, and the grant file that makes full access available to every
 * chat. The `delo-permission-defaults` row's `fullAccessEverywhere` setting alone grants nothing; the plugin honours
 * it only while this file is valid, and only `delorun setup` writes it.
 *
 * The grant file is `<home>/secrets/permission-defaults/full-access-everywhere.json`, `{ v: 1, grantedAt, warning }`
 * at mode 0600, written and removed while holding the permission store's lock.
 *
 * @module @delo/cli/setup/dangerous
 */
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DANGEROUS_PHRASE, type PromptsAnswer } from '@delo/contract-setup-answers'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { permissionStorePath, withPermissionStoreLock } from '@delo/plugin-permission-defaults/store'
import { CliError, EXIT } from '../exit.ts'
import { readPromptsAnswer } from './prompt-switches.ts'
import { BACK, type Back, type StepIO } from './steps.ts'

/** The version of the warning text below, recorded in the grant file as the text the person accepted. */
export const DANGEROUS_WARNING_VERSION = 1

/** Format version of the grant file. */
const GRANT_FILE_VERSION = 1

/** File name of the grant file inside the permission store's directory. */
export const DANGEROUS_GRANT_FILE = 'full-access-everywhere.json'

/** The line `delorun` prints at start and `delorun status` prints while dangerous mode is on. */
export const DANGEROUS_ON_LINE = 'Dangerous mode is on: any chat can switch to full access without asking. Turn it off with `delorun setup prompts`.'

/** The warning of step 1, one paragraph per entry; {@link DANGEROUS_WARNING_VERSION} names this text. */
export const DANGEROUS_WARNING_LINES: readonly string[] = [
  'Dangerous mode lets any chat switch to full access without asking: a chat at this computer, a phone signed in over remote access, a scheduled task, a bot, or delorun headless.',
  'Commands then run outside the sandbox with everything your user can do, including reading and changing Delorun\'s home, its keys and the token that controls it.',
  'The questions before writing AGENTS.md or skills, adding MCP servers and creating scheduled tasks are off, as in DeepSeek Harness.',
  'Text the model reads (web pages, files, repositories) can tell it to do harmful things.',
  'New chats still start on Workspace Write unless you choose otherwise.',
  'Turn it off with `delorun setup prompts`.',
]

/** The sentence a refusal gives for a root user. */
const ROOT_REFUSAL = 'dangerous mode is refused when running as root, because full access then reaches the whole computer, not one user\'s account; run delorun as an ordinary user, as Claude Code requires for its bypass mode'

/**
 * Whether this process runs as the root user.
 * @returns true when the effective user id is 0; false on a platform without user ids.
 */
export function runsAsRoot(): boolean {
  return process.getuid?.() === 0
}

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

/**
 * The grant file's path.
 * @param home - the resolved Delo home.
 * @returns `<home>/secrets/permission-defaults/full-access-everywhere.json`.
 */
export function dangerousGrantPath(home: string): string {
  return join(dirname(permissionStorePath(home)), DANGEROUS_GRANT_FILE)
}

/**
 * Write the grant file while holding the permission store's lock, at mode 0600.
 * @param home - the resolved Delo home.
 * @param now - the grant time.
 * @returns when the file is replaced.
 */
export async function writeDangerousGrant(home: string, now: Date = new Date()): Promise<void> {
  const path = dangerousGrantPath(home)
  const text = `${JSON.stringify({ v: GRANT_FILE_VERSION, grantedAt: now.toISOString(), warning: DANGEROUS_WARNING_VERSION }, null, 2)}\n`
  await withPermissionStoreLock(permissionStorePath(home), async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeProtectedFile(path, text)
  })
}

/**
 * Remove the grant file while holding the permission store's lock; a symbolic link is removed as a link. A home with
 * no grant file is left untouched.
 * @param home - the resolved Delo home.
 * @returns whether a file was removed.
 */
export async function removeDangerousGrant(home: string): Promise<boolean> {
  const path = dangerousGrantPath(home)
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return withPermissionStoreLock(permissionStorePath(home), async () => {
    await rm(path, { force: true })
    return true
  })
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
 * Read the grant file under the protected-file rule: a symbolic link, a mode laxer than 0600 or another format is a
 * problem, as for the permission store.
 * @param home - the resolved Delo home.
 * @returns the grant time, or the reason the file does not grant.
 */
async function readDangerousGrant(home: string): Promise<{ readonly grantedAt: string } | { readonly problem: string }> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(dangerousGrantPath(home))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: 'its grant file is missing' }
    return { problem: `its grant file is refused: ${error instanceof Error ? error.message : 'it could not be read'}` }
  }
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    // The JSON parser's message quotes the text; the reason names the file only.
    return { problem: 'its grant file holds no JSON document' }
  }
  const record = typeof document === 'object' && document !== null && !Array.isArray(document) ? document as Record<string, unknown> : undefined
  const grantedAt = record?.['grantedAt']
  const known = record !== undefined && Object.keys(record).length === 3 && record['v'] === GRANT_FILE_VERSION && record['warning'] === DANGEROUS_WARNING_VERSION
  if (!known || typeof grantedAt !== 'string' || Number.isNaN(Date.parse(grantedAt))) return { problem: 'its grant file is not in the format this version reads' }
  return { grantedAt }
}

/**
 * Whether a valid dangerous-mode grant file exists, so a person who already confirmed does not confirm again.
 * @param home - the resolved Delo home.
 * @returns true when the grant file is present and in the format this version reads.
 */
export async function hasDangerousGrant(home: string): Promise<boolean> {
  return !('problem' in await readDangerousGrant(home))
}

/**
 * Whether dangerous mode is on for a profile, for the start, `delorun status` and `delorun doctor`.
 * @param home - the resolved Delo home.
 * @param profileDirectory - the CLI profile's directory, whose answers record names the prompts answer.
 * @returns `off` for any other answer; `on` with the grant time; or `inactive` with the problem.
 */
export async function dangerousModeState(home: string, profileDirectory: string): Promise<DangerousState> {
  if (readPromptsAnswer(profileDirectory) !== 'dangerous') return { kind: 'off' }
  const grant = await readDangerousGrant(home)
  return 'problem' in grant ? { kind: 'inactive', problem: grant.problem } : { kind: 'on', grantedAt: grant.grantedAt }
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
 * @param home - the resolved Delo home.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the line, or `undefined` while the profile's answer is not `dangerous`.
 */
export async function dangerousModeLine(home: string, profileDirectory: string): Promise<string | undefined> {
  return dangerousStateLine(await dangerousModeState(home, profileDirectory))
}
