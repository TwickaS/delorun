/**
 * The end of a fresh terminal setup: Delorun starts in this terminal and opens the studio, and while it runs setup asks
 * the questions that need the running home. They are the phone PIN (`delorun devices pin set`, which goes over the home
 * socket) and whether to keep the `delorun` command, which `npx` does not keep. Then it prints the ending
 * ({@link foregroundEnding}). The home process runs the whole time: these steps are the start's `afterStart` work.
 *
 * @module @delorun/cli/setup/foreground
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SetupAnswers } from '@delorun/contract-setup-answers'
import { sendHomeRequest } from '@delorun/home-process'
import type { CheckResult } from '../doctor/checks.ts'
import { askSecretInTerminal, readStdinLine } from '../devices/command.ts'
import { runPin, type PinDependencies } from '../devices/pin.ts'
import { EXIT, type ExitCode } from '../exit.ts'
import type { CommandOutput, CommandResult } from '../command.ts'
import { homeRuns } from '../reach/command.ts'
import type { StartRequest } from '../start.ts'
import { foregroundEnding, installLine, launcherVersion, localInstallLine, nextSteps } from './ending.ts'
import { SetupCancelled, type Prompter } from './prompts.ts'

/** What npm did. */
export interface NpmResult {
  /** Whether npm exited with code 0. */
  readonly ok: boolean
  /** Its standard output and standard error together. */
  readonly output: string
}

/** What the steps after the start run against. */
export interface ForegroundDependencies {
  /**
   * Start Delorun in this terminal, as `delorun start` does.
   * @param request - the start, with the steps to run once it announced the studio.
   * @returns the start's result.
   */
  readonly start: (request: StartRequest) => Promise<CommandResult>
  /** What `delorun devices pin set` needs: the running check, the home socket and the hidden prompt. */
  readonly pin: Pick<PinDependencies, 'running' | 'send' | 'secret' | 'stdinLine' | 'interactive' | 'stdinIsTerminal' | 'now'>
  /**
   * Run npm with fixed arguments and collect its output.
   * @param args - the arguments after `npm`.
   * @returns what npm did.
   */
  readonly npm: (args: readonly string[]) => Promise<NpmResult>
  /** Stop Delorun as Ctrl+C does; used when the person cancels a question while it runs. */
  readonly interrupt: () => void
  /** The person's home folder, which `--prefix ~/.local` expands against. */
  readonly userHome: string
}

/** One run of the steps. */
export interface ForegroundRequest {
  /** The prepared Delorun home. */
  readonly home: string
  /** The CLI profile that was set up. */
  readonly profile: string
  /** Where setup writes. */
  readonly output: CommandOutput
  /** The environment `delorun` inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The answers the run applied. */
  readonly answers: SetupAnswers
  /** The questions' prompter. */
  readonly prompter: Prompter
  /** The channel origin of a launcher built for another release channel, or `undefined` for the production channel. */
  readonly channelOrigin: string | undefined
  /** The sandbox check, shown when it found the sandbox cannot run. */
  readonly sandbox: CheckResult | undefined
  /** The dependencies. */
  readonly dependencies: ForegroundDependencies
}

/** The line a declined or failed PIN prints. */
const PIN_LATER = 'No PIN is set. delorun devices pin set sets it later, and so does the studio\'s Settings → Safety → PIN mode.'

/** What npm prints when it lacks permission to write the global folder. */
const PERMISSION_REFUSED = /\b(?:EACCES|EPERM)\b/u

/**
 * Run npm with the system's `npm`, without a shell except where Windows needs one for `npm.cmd`. The arguments are fixed
 * words and a semantic version.
 * @param args - the arguments after `npm`.
 * @param command - the program that runs them; `npm` outside tests.
 * @returns what npm did; a command that cannot start is a result that is not ok.
 */
export function runNpm(args: readonly string[], command = 'npm'): Promise<NpmResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { shell: process.platform === 'win32', windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stdout}${stderr}` })
    })
  })
}

/**
 * The dependencies a terminal run uses: the real start, home socket, hidden prompt and npm.
 * @returns the dependencies.
 */
export function terminalForeground(): ForegroundDependencies {
  return {
    start: async request => (await import('../start.ts')).startForeground(request),
    pin: { running: homeRuns, send: sendHomeRequest, secret: askSecretInTerminal, stdinLine: readStdinLine, interactive: true, stdinIsTerminal: true, now: Date.now },
    npm: args => runNpm(args),
    interrupt: () => { process.kill(process.pid, 'SIGINT') },
    userHome: homedir(),
  }
}

/**
 * Ask whether to set the phone PIN now, and set it.
 * @param request - the run.
 * @throws {SetupCancelled} when the person cancels the question.
 */
async function offerPin(request: ForegroundRequest): Promise<void> {
  const { output, prompter, dependencies } = request
  if (!await prompter.confirm('Set a PIN for your phone now? (6 digits or more; asked for each sensitive action)', true)) {
    output.stdout(`${PIN_LATER}\n`)
    return
  }
  const code: ExitCode = await runPin('set', [], { home: request.home, profile: request.profile, context: { ...output, env: request.env }, dependencies: dependencies.pin })
  if (code !== EXIT.ok) output.stdout(`${PIN_LATER}\n`)
}

/**
 * Install the `delorun` command with npm. A permission refusal is retried under `~/.local`; any other failure prints the
 * command for the person to run.
 * @param request - the run.
 * @param version - the launcher's version.
 */
async function installCommand(request: ForegroundRequest, version: string): Promise<void> {
  const { output, dependencies } = request
  const global = installLine(version)
  const first = await dependencies.npm(['install', '-g', `delorun@${version}`])
  if (first.ok) {
    output.stdout('✔ delorun is installed. Next time: delorun\n')
    return
  }
  const prefixed = global.replace('install -g', 'install -g --prefix ~/.local')
  if (!PERMISSION_REFUSED.test(first.output)) {
    output.stdout(`npm could not install it. To install it yourself, run: ${global}\n`)
    return
  }
  const second = await dependencies.npm(['install', '-g', '--prefix', join(dependencies.userHome, '.local'), `delorun@${version}`])
  if (!second.ok) {
    output.stdout(`npm could not install it, even under ~/.local. To install it yourself, run: ${prefixed}\n`)
    return
  }
  output.stdout('✔ delorun is installed under ~/.local. Next time: delorun\nAdd ~/.local/bin to your PATH so the delorun command is found.\n')
}

/**
 * Ask whether to keep the `delorun` command, when the launcher started the run.
 * @param request - the run.
 * @throws {SetupCancelled} when the person cancels the question.
 */
async function offerCommand(request: ForegroundRequest): Promise<void> {
  const { output, prompter } = request
  const version = launcherVersion(request.env)
  if (version === undefined) return
  if (request.channelOrigin !== undefined) {
    output.stdout(`To keep the delorun command: ${version} is not on the npm registry, so install the package file this launcher came from: ${localInstallLine(version)}\n`)
    return
  }
  const answer = await prompter.select('Keep the delorun command?\nRuns: ' + installLine(version), [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No, keep using npx' },
  ], 'yes')
  if (answer === 'yes') await installCommand(request, version)
}

/**
 * The steps after the start: the phone PIN when phone access is on, the question about the `delorun` command, and the
 * ending. A cancelled question is Ctrl+C: Delorun stops and nothing more is printed.
 * @param request - the run.
 */
async function afterStart(request: ForegroundRequest): Promise<void> {
  try {
    if (request.answers.reach.option !== 'none') await offerPin(request)
    await offerCommand(request)
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error
    request.dependencies.interrupt()
    return
  }
  request.output.stdout(foregroundEnding(request.profile, request.sandbox))
}

/**
 * Start Delorun in this terminal and open the studio, asking the questions that need it while it runs.
 * @param request - the run.
 * @returns the start's result: `undefined` once Delorun runs, as the profile runner then owns the exit code. A start that
 *   hands over to a home that already runs, or ends without running, prints the plain ending instead.
 */
export async function runForeground(request: ForegroundRequest): Promise<CommandResult> {
  const { home, profile, output, env, dependencies } = request
  let asked = false
  const result = await dependencies.start({ home, profile, open: true, output, env, afterStart: async () => { asked = true; await afterStart(request) } })
  if (!asked) output.stdout(nextSteps({ profile, answers: request.answers, env, channelOrigin: request.channelOrigin, sandbox: request.sandbox }))
  return result
}
