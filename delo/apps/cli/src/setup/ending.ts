/**
 * The end of an interactive setup: the offer to install the `delorun` command, then starting Delorun and opening
 * the studio, and the text that says what is running and how to look at it or stop it. Everything that touches the
 * computer goes through {@link Ending}, so specs inject a fake spawn and a fake start. The studio address comes from
 * the home process's `status` answer and carries no token; the browser gets a one-time link the home process mints
 * ([studio](../open/studio.ts)).
 *
 * @module @delo/cli/setup/ending
 */
import { hostname, userInfo } from 'node:os'
import { HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import { queryHomeStatus } from '@delo/home-process'
import { EXIT, type ExitCode } from '../exit.ts'
import type { CommandOutput, CommandResult } from '../command.ts'
import { computerOpener, openStudio, profileFlag, spawnCommand, type StudioOpener } from '../open/studio.ts'
import { startDetached, startForeground } from '../start.ts'
import { SetupCancelled, type Prompter } from './prompts.ts'

/** The line the install offer runs, and prints when the person declines or it fails. */
export const INSTALL_COMMAND = 'npm install -g delorun'

/** How the studio was started: attached to this terminal, or detached from it. */
export type StartMode = 'background' | 'foreground'

/** What the ending does on the computer. */
export interface Ending {
  /**
   * Run a command with the terminal attached.
   * @param command - the program.
   * @param args - its arguments.
   * @returns its exit code; 127 when it could not start.
   */
  spawn(command: string, args: readonly string[]): Promise<number>
  /**
   * Start Delorun without opening the studio.
   * @param mode - detached from the terminal, or attached to it.
   * @returns the start's result, as {@link startDetached} and {@link startForeground} return it.
   */
  start(mode: StartMode): Promise<CommandResult>
  /**
   * @returns the studio's loopback address, without a token, from the running home process's `status` answer, or
   *   `undefined` when it serves no studio or does not answer.
   */
  address(): Promise<string | undefined>
  /**
   * Ask the home process for a fresh one-time studio link and hand it to the computer's default browser.
   * @returns whether a browser took it.
   */
  open(): Promise<boolean>
  /**
   * @returns whether a browser can plausibly be shown on this computer: a desktop, and not an SSH session.
   */
  canOpen(): boolean
  /**
   * @returns the account and computer name for the SSH port-forward line.
   */
  identity(): { readonly user: string, readonly host: string }
}

/**
 * The studio address a running home process reports.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the address without a token, or `undefined` when the home process serves no studio or does not answer.
 */
export async function studioAddress(home: string, profile: string): Promise<string | undefined> {
  try {
    const status = await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
    return 'studio' in status && typeof status.studio === 'string' ? status.studio : undefined
  } catch (_notAnswering) {
    // The start reported success, so a home process that does not answer now has stopped; the report says so.
    return undefined
  }
}

/**
 * The ending of a terminal run on this computer.
 * @param home - the Delo home.
 * @param profile - the profile to start.
 * @param output - where the start writes.
 * @param env - the environment `delorun` inherited.
 * @param run - runs a program; {@link spawnCommand} by default.
 * @param opener - how the studio is opened; this computer's, through `run`, by default.
 * @returns the ending.
 */
export function computerEnding(
  home: string, profile: string, output: CommandOutput, env: Readonly<Record<string, string | undefined>>,
  run: typeof spawnCommand = spawnCommand, opener: StudioOpener = computerOpener(env, run),
): Ending {
  return {
    spawn: (command, args) => run(command, args),
    start: mode => mode === 'background' ? startDetached(home, profile, output, false, opener) : startForeground({ home, profile, open: false, output, env }),
    address: () => studioAddress(home, profile),
    open: async () => (await openStudio(home, profile, opener)).kind === 'opened',
    canOpen: () => opener.canOpen(),
    identity: () => ({ user: userInfo().username, host: hostname() }),
  }
}

/** What the ending needs to know about the run. */
export interface EndingRequest {
  /** The profile that was set up. */
  readonly profile: string
  /** Whether the person chose to keep Delorun running after the terminal closes. */
  readonly background: boolean
  /** Where the ending writes. */
  readonly output: CommandOutput
}

/**
 * Ask whether to install the command. Cancelling the question declines it: setup has written everything by now.
 * @param prompter - asks the question.
 * @returns whether the person said yes.
 */
async function offersInstall(prompter: Prompter): Promise<boolean> {
  try {
    return await prompter.confirm(`Install the delorun command? (runs ${INSTALL_COMMAND})`, true)
  } catch (error) {
    if (error instanceof SetupCancelled) return false
    throw error
  }
}

/**
 * Offer to install the command, then start Delorun and open the studio.
 * @param prompter - asks the install offer.
 * @param ending - what the ending does on the computer.
 * @param request - the profile, the background answer and the output.
 * @returns the exit code of the start.
 */
export async function finishSetup(prompter: Prompter, ending: Ending, request: EndingRequest): Promise<ExitCode> {
  const { output } = request
  if (await offersInstall(prompter)) {
    const [command, ...args] = INSTALL_COMMAND.split(' ') as [string, ...string[]]
    if ((await ending.spawn(command, args)) !== 0) output.stdout(`The install did not finish. To install it yourself, run:\n  ${INSTALL_COMMAND}\n`)
  } else {
    output.stdout(`To install it later, run:\n  ${INSTALL_COMMAND}\n`)
  }
  const mode: StartMode = request.background ? 'background' : 'foreground'
  const canOpen = ending.canOpen()
  const started = await ending.start(mode)
  if (started !== undefined && started !== EXIT.ok) return started
  const address = await ending.address()
  const opened = canOpen && address !== undefined && await ending.open()
  output.stdout(report(mode, request.profile, address, canOpen, opened, ending.identity()))
  return EXIT.ok
}

/**
 * The text that says what is running.
 * @param mode - how Delorun was started.
 * @param profile - the profile.
 * @param address - the studio address, if known.
 * @param canOpen - whether this computer can show a browser.
 * @param opened - whether the browser was opened by setup.
 * @param identity - the account and computer name for the SSH line.
 * @returns the text.
 */
function report(mode: StartMode, profile: string, address: string | undefined, canOpen: boolean, opened: boolean, identity: { readonly user: string, readonly host: string }): string {
  const flag = profileFlag(profile)
  const lines = [mode === 'background'
    ? 'Delorun is running in the background and keeps running after you close this terminal.'
    : 'Delorun is running in this terminal. Closing the terminal stops it.']
  lines.push(address === undefined ? `The home process reports no studio; see delorun status${flag} and delorun logs --follow${flag}` : `Studio: ${address}${opened ? ' (opened in your browser)' : ''}`)
  if (!canOpen && address !== undefined) {
    const port = new URL(address).port || '80'
    lines.push(
      'There is no browser to open here. To reach the studio from your own computer, run this there:',
      `  ssh -L ${port}:127.0.0.1:${port} ${identity.user}@${identity.host}`,
      `then run delorun open --print${flag} here and open the link it prints there; it signs in once, within one minute.`,
    )
  }
  lines.push(`  delorun status${flag}`, `  delorun logs --follow${flag}`, `  delorun stop${flag}`)
  return `${lines.join('\n')}\n`
}
