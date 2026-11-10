/**
 * The end of an interactive setup: the offer to install the `delorun` command, then starting Delorun and opening
 * the studio, and the text that says what is running and how to look at it or stop it. Everything that touches the
 * computer goes through {@link Ending}, so specs inject a fake spawn and a fake start.
 *
 * @module @delo/cli/setup/ending
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { canOpenNativePath } from '@deepseek-ai/dsh-native-command'
import { resolveSurface } from '@delo/logs'
import { EXIT, type ExitCode } from '../exit.ts'
import type { CommandOutput, CommandResult } from '../command.ts'
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
   * Start Delorun.
   * @param mode - detached from the terminal, or attached to it.
   * @param open - whether an attached start opens the studio itself.
   * @returns the start's result, as {@link startDetached} and {@link startForeground} return it.
   */
  start(mode: StartMode, open: boolean): Promise<CommandResult>
  /**
   * @returns the studio's address once the started process has printed it, or `undefined` when it did not.
   */
  address(): Promise<string | undefined>
  /**
   * Hand the address to the computer's default browser.
   * @param url - the address.
   * @returns whether a browser took it.
   */
  open(url: string): Promise<boolean>
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
 * Run a command with the terminal attached.
 * @param command - the program.
 * @param args - its arguments.
 * @param stdio - where its input and output go.
 * @returns its exit code; 127 when it could not start.
 */
export function spawnCommand(command: string, args: readonly string[], stdio: 'inherit' | 'ignore' = 'inherit'): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio })
    child.once('error', () => { resolve(127) })
    child.once('close', (code) => { resolve(code ?? 127) })
  })
}

/**
 * The studio address a started process printed: the last `dsh web: <address>` line of the log text.
 * @param log - the home log's text.
 * @returns the address, or `undefined`.
 */
export function studioAddressFromLog(log: string): string | undefined {
  const matches = [...log.matchAll(/dsh web: (https?:\/\/\S+)/gu)]
  return matches.at(-1)?.[1]
}

/** How long the address is waited for, in steps. */
const ADDRESS_ATTEMPTS = 20
const ADDRESS_STEP_MS = 250

/**
 * Wait one step while the address is awaited.
 * @returns when the step has passed.
 */
export const pauseOneStep = (): Promise<void> => sleep(ADDRESS_STEP_MS)

/**
 * Wait for the home log to hold the studio's address.
 * @param read - reads the log text, empty while the log does not exist.
 * @param pause - waits one step.
 * @returns the address, or `undefined` when the log never held one.
 */
export async function waitForAddress(read: () => string, pause: () => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < ADDRESS_ATTEMPTS; attempt += 1) {
    const address = studioAddressFromLog(read())
    if (address !== undefined) return address
    await pause()
  }
  return undefined
}

/**
 * The command that hands an address to the computer's browser.
 * @param platform - `process.platform`.
 * @param env - the environment, read for WSL.
 * @param url - the address.
 * @returns the program and arguments.
 */
export function openerFor(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, url: string): readonly [string, readonly string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32' || (env['WSL_DISTRO_NAME'] ?? '') !== '') return ['cmd.exe', ['/c', 'start', '""', url]]
  return ['xdg-open', [url]]
}

/**
 * The ending of a terminal run on this computer.
 * @param home - the Delo home.
 * @param profile - the profile to start.
 * @param output - where the start writes.
 * @param env - the environment `delorun` inherited.
 * @param run - runs a program; {@link spawnCommand} by default.
 * @param pause - waits one step while the address is awaited; a timer by default.
 * @returns the ending.
 */
export function computerEnding(
  home: string, profile: string, output: CommandOutput, env: Readonly<Record<string, string | undefined>>,
  run: typeof spawnCommand = spawnCommand, pause: () => Promise<void> = pauseOneStep,
): Ending {
  return {
    spawn: (command, args) => run(command, args),
    start: (mode, open) => mode === 'background' ? startDetached(home, profile, output) : startForeground({ home, profile, open, output }),
    address() {
      const file = resolveSurface({ kind: 'home', home, profile }).file
      return waitForAddress(() => existsSync(file) ? readFileSync(file, 'utf8') : '', pause)
    },
    async open(url) {
      const [command, args] = openerFor(process.platform, env, url)
      return (await run(command, args, 'ignore')) === 0
    },
    canOpen: () => sshSession(env) ? false : canOpenNativePath({ env }),
    identity: () => ({ user: userInfo().username, host: hostname() }),
  }
}

/**
 * @param env - the environment.
 * @returns whether the terminal is an SSH session.
 */
function sshSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['SSH_CONNECTION'] ?? '') !== '' || (env['SSH_TTY'] ?? '') !== ''
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
 * The flag that selects a profile other than the default, for the commands the ending prints.
 * @param profile - the profile.
 * @returns the flag with a leading space, or the empty string.
 */
function profileFlag(profile: string): string {
  return profile === 'default' ? '' : ` --profile ${profile}`
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
  const started = await ending.start(mode, canOpen)
  if (started !== undefined && started !== EXIT.ok) return started
  const address = await ending.address()
  const opened = mode === 'background' && canOpen && address !== undefined && await ending.open(address)
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
  lines.push(address === undefined ? 'The studio address is in the log: delorun logs --follow' : `Studio: ${address}${opened ? ' (opened in your browser)' : ''}`)
  if (!canOpen && address !== undefined) {
    const port = new URL(address).port || '80'
    lines.push('There is no browser to open here. To reach the studio from your own computer, run this there and open the address above:', `  ssh -L ${port}:127.0.0.1:${port} ${identity.user}@${identity.host}`)
  }
  lines.push(`  delorun status${flag}`, `  delorun logs --follow${flag}`, `  delorun stop${flag}`)
  return `${lines.join('\n')}\n`
}
