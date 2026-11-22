/**
 * `delorun reach status | on tailscale | off` (contract C7): remote access to the studio over the person's own tailnet.
 *
 * - `on tailscale` checks that Tailscale is installed, running and signed in and that the tailnet has HTTPS certificates
 *   on; refuses while Tailscale Funnel is on for the address; removes any rule on the serve port that is not this home's
 *   own, or every rule there while the option does not run, confirming each removal; and tests that the person's user
 *   may configure `tailscale serve` by configuring the serve target and removing it again (`checkServeAccess`). A user
 *   who may not gets `TAILSCALE_SERVE_NOT_PERMITTED` with the one command the person runs, and nothing is written;
 *   nothing runs through `sudo`. It then writes the profile's `delorun-reach` row with this machine's `ts.net` address
 *   and the fixed listener port, chosen once, and prints the address, the sign-in address and the trust statement.
 * - `off` turns the option off in the row, resets who may ask to pair without a window, removes whatever Tailscale
 *   serves on the serve port at once and confirms it is gone, then signs every paired device out (the device list stays).
 *   The sign-out does not depend on what Tailscale or the home answers: a running home does it itself, after its
 *   listener has stopped, when it applies the row; a home that does not answer, and one that does not run, have their
 *   stored sessions removed. "Every paired device is signed out" is printed only once that succeeded; a removal
 *   Tailscale cannot confirm, a sign-out that failed, or a home that did not apply the row exits non-zero with the
 *   reason. A home that did not answer keeps its sessions in memory until it restarts.
 * - While the profile's home runs, `on` and `off` ask it over the update channel's `reach.apply` (C19) to restart its
 *   options from the row, and print the state it answers; a home that cannot apply it, or a start that is not
 *   `ready`, exits non-zero with the reason and the restart command.
 * - `status` prints the row and, while the home runs, each option's live state from `reach.status`.
 *
 * Every `tailscale` call goes through the injected runner, and every home request through the injected sender.
 *
 * @module @delorun/cli/reach/command
 */
import { pinOffHint } from '../devices/pin.ts'
import { DEFAULT_SERVE_PORT } from '@delorun/contract-reach-providers'
import type { ReachOptionStatus } from '@delorun/contract-home-process'
import { checkServeAccess, ReachError, readTailscale, removeServe, serveTarget, systemTailscale, tailscaleAddress, type TailscaleRunner } from '@delorun/reach'
import { listenerPortFor, readPairingAt, signInAddress, TRUST_STATEMENT, writeMayAskAt } from '@delorun/setup-apply'
import { join } from 'node:path'
import { processExists, readHomeLock, resolveDelorunHome, runDirectory } from '@delorun/home'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delorun/home-process'
import { HomeAuth, HomeAuthError, type PairingSpec } from '@delorun/home-auth'
import { CliError, EXIT } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext } from '../command.ts'
import { hasCliProfile, selectProfile } from '../profile.ts'
import { profileFlag } from '../open/studio.ts'
import { printable } from '../terminal-text.ts'
import { askOnTerminal, isYes } from '../trash/terminal.ts'
import { profilePatchPath, readReachRow, writeReachRow } from './row.ts'

/** What the command runs against. */
export interface ReachDependencies {
  /** Runs `tailscale`. */
  readonly tailscale: TailscaleRunner
  /**
   * Whether the profile's home process runs.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the update channel with the token file's token.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @param request - the request.
   * @returns the response lines.
   * @throws the connection's error when no home process answers.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<ResponseLine[]>
  /**
   * Ask one yes-or-no question on the terminal.
   * @param question - the question, with its own prompt suffix.
   * @returns the answer; the empty string when no terminal can ask.
   */
  readonly ask: (question: string) => Promise<string>
  /** Whether a terminal can answer {@link ReachDependencies.ask}. */
  readonly terminal: boolean
}

/** The usage line. */
const USAGE = 'Usage: delorun reach status | on tailscale [--yes] | off [--profile <name>]'

/**
 * Whether a profile's home process runs.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns true when a live process holds the lock.
 */
export function homeRuns(home: string, profile: string): boolean {
  const record = readHomeLock(runDirectory(home, profile))
  return record !== undefined && processExists(record.pid)
}

/**
 * Build the command over its dependencies.
 * @param dependencies - the runner, the running check and the home socket.
 * @returns the command.
 */
export function createReachCommand(dependencies: ReachDependencies): CliCommand {
  return {
    name: 'reach',
    summary: 'Reach the studio from your phone over your own tailnet: status, on tailscale, off',
    async run(args, context) {
      const [action, ...rest] = args
      switch (action) {
        case 'status': return status(rest, context, dependencies)
        case 'on': return turnOn(rest, context, dependencies)
        case 'off': return turnOff(rest, context, dependencies)
        default: throw new CliError(EXIT.usage, `delorun reach: ${action === undefined ? 'choose an action' : `unknown action ${JSON.stringify(action)}`}\n${USAGE}`)
      }
    },
  }
}

/** `delorun reach`, over the system's `tailscale`, the home lock and the home socket. */
export const reachCommand: CliCommand = createReachCommand({ tailscale: systemTailscale(), running: homeRuns, send: sendHomeRequest, ask: askOnTerminal, terminal: process.stdin.isTTY === true && process.stdout.isTTY === true })

/**
 * The home and profile of a command that changes the profile, refusing a home without the CLI profile.
 * @param command - the action's name, for the option errors.
 * @param args - the options.
 * @param context - the environment and output.
 * @returns the home path and the profile.
 * @throws {CliError} when the profile does not exist.
 */
async function preparedProfile(command: string, args: readonly string[], context: CommandContext): Promise<{ readonly home: string; readonly profile: string; readonly yes: boolean }> {
  const values = parseOptions(`reach ${command}`, args, command === 'on' ? { profile: { type: 'string' }, yes: { type: 'boolean', default: false } } : { profile: { type: 'string' } })
  const { home, profile } = await prepareHome(context, values.profile, true)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun reach: the profile ${profile} is not set up; run delorun setup first`)
  return { home: home.path, profile, yes: 'yes' in values && values.yes === true }
}

/**
 * The commands that restart a profile's home.
 * @param profile - the CLI profile, named with `--profile` unless it is the default.
 * @returns the commands.
 */
function restartCommand(profile: string): string {
  const flag = profileFlag(profile)
  return `delorun stop${flag}, then delorun start${flag}`
}

/**
 * The lines that tell the person how to add a phone: the approval first, then the sign-in address on the phone.
 * @param address - the option's studio address.
 * @returns the lines.
 */
export function addPhoneLines(address: string): readonly string[] {
  return [
    'To add your phone:',
    '  1. Run delorun devices approve on this computer.',
    `  2. Open ${signInAddress(address)} on the phone, choose Ask for approval, and type the code it shows here.`,
  ]
}

/** What the running home answered to a reach operation. */
type LiveAnswer =
  | { readonly kind: 'options'; readonly options: readonly ReachOptionStatus[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Ask the running home one reach operation.
 * @param dependencies - the home socket.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param op - `reach.status` or `reach.apply`.
 * @returns the options, or why the home did not answer them.
 */
async function askHome(dependencies: ReachDependencies, home: string, profile: string, op: 'reach.status' | 'reach.apply'): Promise<LiveAnswer> {
  let lines: ResponseLine[]
  try {
    lines = await dependencies.send(home, profile, { op })
  } catch (error) {
    return { kind: 'unavailable', reason: `the home process did not answer (${error instanceof Error ? error.message : String(error)})` }
  }
  const line = lines.at(-1)
  if (line === undefined) return { kind: 'unavailable', reason: 'the home process closed the request without an answer; see delorun logs home' }
  if (line.ok !== true) {
    const detail = typeof line.detail === 'string' ? `: ${line.detail}` : ''
    return { kind: 'unavailable', reason: `the home process refused with ${String(line.error)}${detail}` }
  }
  const options = optionsOf(line.options)
  return options === undefined ? { kind: 'unavailable', reason: 'the home process answered with states this command cannot read' } : { kind: 'options', options }
}

/**
 * Read the options of a reach answer.
 * @param value - the answer's `options` field.
 * @returns the options, or undefined when an entry is not one.
 */
function optionsOf(value: unknown): readonly ReachOptionStatus[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: readonly unknown[] = value
  const options: ReachOptionStatus[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const option: unknown = Reflect.get(entry, 'option')
    const state: unknown = Reflect.get(entry, 'state')
    if (typeof option !== 'string' || typeof state !== 'string') return undefined
    const text = (name: string): Record<string, string> => {
      const field: unknown = Reflect.get(entry, name)
      return typeof field === 'string' ? { [name]: field } : {}
    }
    options.push({ option, state, ...text('address'), ...text('cause'), ...text('detail') })
  }
  return options
}

/**
 * One option's live state as a line, its text escaped for the terminal.
 * @param option - the option.
 * @returns the line.
 */
function liveLine(option: ReachOptionStatus): string {
  const at = option.address === undefined ? '' : ` at ${printable(option.address)}`
  const cause = option.cause === undefined ? '' : ` (${printable(option.cause)}): ${printable(option.detail ?? '')}`
  return `${option.option === 'tailscale-private' ? 'Remote access over Tailscale' : printable(option.option)} is ${printable(option.state)}${at}${cause}`
}

/** The live states in which the running home holds the option's fixed listener port. */
const HOLDING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded'])

/**
 * Whether the running home holds the Tailscale private option's fixed listener port now, as its live state says: a
 * blocked, failed or off option holds none, so its own serve rule would forward to a port any local program can bind.
 * @param dependencies - the home socket.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns whether it holds the port; false when the home does not answer.
 */
async function holdsListener(dependencies: ReachDependencies, home: string, profile: string): Promise<boolean> {
  const answer = await askHome(dependencies, home, profile, 'reach.status')
  if (answer.kind === 'unavailable') return false
  const state = answer.options.find(entry => entry.option === 'tailscale-private')?.state
  return state !== undefined && HOLDING_STATES.has(state)
}

/**
 * `delorun reach on tailscale`.
 * @param args - the arguments after `on`.
 * @param context - the environment and output.
 * @param dependencies - the runner, the running check and the home socket.
 * @returns the exit code.
 */
async function turnOn(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok | typeof EXIT.failed> {
  const [option, ...rest] = args
  if (option !== 'tailscale') throw new CliError(EXIT.usage, `delorun reach on: the one option this build offers is tailscale\n${USAGE}`)
  const { home, profile, yes } = await preparedProfile('on', rest, context)
  if (!yes && !dependencies.terminal) {
    throw new CliError(EXIT.failed, 'delorun reach on tailscale: this changes Tailscale on this computer, and there is no terminal to ask you. Run it in a terminal, or add --yes to change it without a question.')
  }
  const running = dependencies.running(home, profile)
  const row = readReachRow(home, profile)
  const holds = running && row.enabled && await holdsListener(dependencies, home, profile)
  let dnsName: string
  let listenerPort: number
  try {
    ({ dnsName } = await readTailscale(dependencies.tailscale))
    if (!yes && !isYes(await dependencies.ask(`This changes Tailscale on this computer: Delorun tests Tailscale's serve setting now, and while Delorun runs, Tailscale serves your studio to your own devices at ${tailscaleAddress(dnsName, DEFAULT_SERVE_PORT)}. Continue? (y/N) `))) {
      context.stderr('delorun reach on tailscale: nothing was changed. Run it again and answer y to turn remote access on.\n')
      return EXIT.failed
    }
    listenerPort = await listenerPortFor(row.listenerPort, holds)
    await checkServeAccess(dependencies.tailscale, { host: dnsName, servePort: DEFAULT_SERVE_PORT, listenerPort, keepOwn: holds, next: 'then run delorun reach on tailscale again' })
  } catch (error) {
    if (!(error instanceof ReachError)) throw error
    context.stderr(`delorun reach: ${error.detail} (${error.code})\nRemote access stays off.\n`)
    return EXIT.failed
  }
  const address = tailscaleAddress(dnsName, DEFAULT_SERVE_PORT)
  writeReachRow(home, profile, { ...row, enabled: true, address, servePort: DEFAULT_SERVE_PORT, listenerPort })
  const pinHint = await pinOffHint(home)
  context.stdout([`Remote access is on for the profile ${profile} at ${address}`, '', ...TRUST_STATEMENT, ...(pinHint === undefined ? [] : ['', pinHint]), '', ''].join('\n'))
  if (!running) {
    context.stdout([`It starts with Delorun: delorun start.`, ...addPhoneLines(address), ''].join('\n'))
    return EXIT.ok
  }
  const answer = await askHome(dependencies, home, profile, 'reach.apply')
  if (answer.kind === 'unavailable') {
    context.stderr(`delorun reach: the running Delorun did not apply it: ${answer.reason}.\nRestart Delorun to apply it: ${restartCommand(profile)}.\n`)
    return EXIT.failed
  }
  const tailscalePrivate = answer.options.find(entry => entry.option === 'tailscale-private')
  context.stdout(`${answer.options.map(liveLine).join('\n')}\n`)
  if (tailscalePrivate?.state !== 'ready') {
    context.stderr(`delorun reach: the running Delorun did not make the address ready. Fix what the line above names, then run delorun reach on tailscale again.\n`)
    return EXIT.failed
  }
  context.stdout(`${addPhoneLines(address).join('\n')}\n`)
  return EXIT.ok
}

/**
 * `delorun reach off`.
 * @param args - the options.
 * @param context - the environment and output.
 * @param dependencies - the runner, the running check and the home socket.
 * @returns the exit code.
 */
async function turnOff(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok | typeof EXIT.failed> {
  const { home, profile } = await preparedProfile('off', args, context)
  const row = readReachRow(home, profile)
  writeReachRow(home, profile, { ...row, enabled: false })
  // Who may ask to pair without an approval window goes back to the safe default, as in Settings.
  writeMayAskAt(profilePatchPath(home, profile), 'own-user')
  const running = dependencies.running(home, profile)
  const lines = [`Remote access is off for the profile ${profile}.`]
  const problems: string[] = []
  // Tailscale first, so the address stops answering; whatever it says, the devices are signed out below.
  let failure: { readonly error: unknown } | undefined
  try {
    const host = URL.parse(row.address)?.hostname ?? (await readTailscale(dependencies.tailscale)).dnsName
    await removeServe(dependencies.tailscale, host, row.servePort, serveTarget(row.listenerPort))
    lines.push('Tailscale no longer serves this computer\'s studio.')
  } catch (error) {
    if (!(error instanceof ReachError)) failure = { error }
    else if (error.code === 'TAILSCALE_NOT_INSTALLED') lines.push('Tailscale is not installed, so nothing serves this computer\'s studio.')
    else problems.push(`Tailscale may still serve this computer's studio. ${error.detail} (${error.code})`)
  }
  // A running home signs the devices out itself when it applies the row, after its listener has stopped. When it does
  // not answer, or while no home runs, the stored sessions go here, so none is there when it starts; a home that
  // answered nothing keeps its sessions in memory until it restarts.
  let signedOut = false
  let live: readonly ReachOptionStatus[] = []
  if (running) {
    const answer = await askHome(dependencies, home, profile, 'reach.apply')
    if (answer.kind === 'options') {
      signedOut = true
      live = answer.options
    } else {
      problems.push(`the running Delorun did not close its remote listener or end its sessions: ${answer.reason}.\nRestart Delorun to close it: ${restartCommand(profile)}.`)
    }
  }
  if (!signedOut) {
    try {
      await new HomeAuth({ directory: join(home, 'secrets', 'home-auth') }).signAllDevicesOut()
      signedOut = true
    } catch (error) {
      if (!(error instanceof HomeAuthError)) throw error
      problems.push(`the paired devices could not be signed out: ${error.message}`)
    }
  }
  if (signedOut) lines.splice(1, 0, 'Every paired device is signed out and stays on the list; each signs in again when remote access is on.')
  context.stdout(`${[...lines, ...live.map(liveLine)].join('\n')}\n`)
  if (failure !== undefined) throw failure.error
  if (problems.length > 0) {
    context.stderr(problems.map(problem => `delorun reach: ${problem}\n`).join(''))
    return EXIT.failed
  }
  return EXIT.ok
}

/**
 * `delorun reach status`.
 * @param args - the options.
 * @param context - the environment and output.
 * @param dependencies - the running check and the home socket.
 * @returns the exit code.
 */
async function status(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok> {
  const values = parseOptions('reach status', args, { profile: { type: 'string' } })
  const profile = selectProfile(values.profile, context.env)
  const home = (await resolveDelorunHome(context.env)).path
  const row = readReachRow(home, profile)
  const lines = [row.enabled ? `Remote access is on over Tailscale at ${row.address}.` : 'Remote access is off. Turn it on with delorun reach on tailscale.']
  if (!dependencies.running(home, profile)) {
    if (row.enabled) lines.push('Delorun is not running, so the address does not work until you run delorun start.')
  } else {
    const answer = await askHome(dependencies, home, profile, 'reach.status')
    if (answer.kind === 'options') lines.push(...answer.options.filter(option => row.enabled || option.state !== 'off').map(liveLine))
    else lines.push(`Delorun is running, but its live state could not be read: ${answer.reason}. Settings → Devices in the studio on this computer shows it.`)
  }
  const pinHint = row.enabled ? await pinOffHint(home) : undefined
  if (pinHint !== undefined) lines.push(pinHint)
  if (row.enabled) lines.push(`Sign-in address: ${signInAddress(row.address)}`, ...addPhoneLines(row.address), mayAskLine(readPairingAt(profilePatchPath(home, profile))))
  context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}

/**
 * Say who may ask to pair a device without an approval window, and how the studio shows a request.
 * @param pairing - the profile's resolved pairing values.
 * @returns the sentence.
 */
function mayAskLine(pairing: PairingSpec): string {
  const who = {
    'own-user': 'Devices signed in as this computer\'s Tailscale user may ask to pair without an approval window',
    tailnet: 'Any device on your tailnet may ask to pair without an approval window',
    'window-only': 'A device may ask to pair only while an approval window is open (delorun devices approve)',
  }[pairing.mayAskWithoutWindow]
  return `${who}; every request needs the code from its screen, typed at this computer.`
}
