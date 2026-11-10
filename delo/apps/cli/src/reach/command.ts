/**
 * `delorun reach status | on tailscale | off` (contract C7): remote access to the studio over the person's own tailnet.
 *
 * - `on tailscale` checks that Tailscale is installed, running and signed in, that the tailnet has HTTPS certificates
 *   on, and that the person's user may configure `tailscale serve`; for the last it prints the one command the person
 *   runs and runs nothing through `sudo`. It then writes the profile's `delo-reach` row with this machine's `ts.net`
 *   address and prints the address and the trust statement. The running home applies it at its next start.
 * - `off` turns the option off in the row and removes the serve target at once.
 * - `status` prints the row, and the live state when the home runs.
 *
 * Every `tailscale` call goes through the injected runner.
 *
 * @module @delo/cli/reach/command
 */
import { DEFAULT_SERVE_PORT, TAILSCALE_OPERATOR_COMMAND } from '@delo/contract-reach-providers'
import { isPermissionRefusal, ReachError, readTailscale, systemTailscale, tailscaleAddress, unserve, type TailscaleRunner } from '@delo/reach'
import { processExists, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { CliError, EXIT } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext } from '../command.ts'
import { hasCliProfile, selectProfile } from '../profile.ts'
import { readReachRow, writeReachRow } from './row.ts'
import { loopbackStudio, studioPort, type StudioClient } from './studio.ts'
import { TRUST_STATEMENT } from './trust.ts'

/** What the command runs against. */
export interface ReachDependencies {
  /** Runs `tailscale`. */
  readonly tailscale: TailscaleRunner
  /** Reaches the profile's studio on its loopback port. */
  readonly studio: StudioClient
  /**
   * Whether the profile's home process runs.
   * @param home - the Delo home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
}

/** The usage line. */
const USAGE = 'Usage: delorun reach status | on tailscale | off [--profile <name>]'

/**
 * Whether a profile's home process runs.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns true when a live process holds the lock.
 */
export function homeRuns(home: string, profile: string): boolean {
  const record = readHomeLock(runDirectory(home, profile))
  return record !== undefined && processExists(record.pid)
}

/**
 * Build the command over its dependencies.
 * @param dependencies - the runner, the studio client and the running check.
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

/** `delorun reach`, over the system's `tailscale` and the loopback studio. */
export const reachCommand: CliCommand = createReachCommand({ tailscale: systemTailscale(), studio: loopbackStudio, running: homeRuns })

/**
 * The home and profile of a command that changes the profile, refusing a home without the CLI profile.
 * @param command - the action's name, for the option errors.
 * @param args - the options.
 * @param context - the environment and output.
 * @returns the home path and the profile.
 * @throws {CliError} when the profile does not exist.
 */
async function preparedProfile(command: string, args: readonly string[], context: CommandContext): Promise<{ readonly home: string; readonly profile: string }> {
  const values = parseOptions(`reach ${command}`, args, { profile: { type: 'string' } })
  const { home, profile } = await prepareHome(context, values.profile)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun reach: the profile ${profile} is not set up; run delorun setup first`)
  return { home: home.path, profile }
}

/**
 * `delorun reach on tailscale`.
 * @param args - the arguments after `on`.
 * @param context - the environment and output.
 * @param dependencies - the runner and the running check.
 * @returns the exit code.
 */
async function turnOn(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok | typeof EXIT.failed> {
  const [option, ...rest] = args
  if (option !== 'tailscale') throw new CliError(EXIT.usage, `delorun reach on: the one option this build offers is tailscale\n${USAGE}`)
  const { home, profile } = await preparedProfile('on', rest, context)
  let dnsName: string
  try {
    ({ dnsName } = await readTailscale(dependencies.tailscale))
    const check = await dependencies.tailscale(['serve', 'status', '--json'])
    if (check.code !== 0 && isPermissionRefusal(check.stderr)) {
      throw new ReachError('TAILSCALE_SERVE_NOT_PERMITTED', `Your user may not configure tailscale serve yet. Run this once yourself, then run delorun reach on tailscale again:\n  ${TAILSCALE_OPERATOR_COMMAND}`)
    }
  } catch (error) {
    if (!(error instanceof ReachError)) throw error
    context.stderr(`delorun reach: ${error.detail} (${error.code})\n`)
    return EXIT.failed
  }
  const address = tailscaleAddress(dnsName, DEFAULT_SERVE_PORT)
  writeReachRow(home, profile, { enabled: true, address, servePort: DEFAULT_SERVE_PORT })
  context.stdout([
    `Remote access is on for the profile ${profile} at ${address}`,
    '',
    ...TRUST_STATEMENT,
    '',
    dependencies.running(home, profile)
      ? 'Restart Delo to apply it: delorun stop, then delorun start.'
      : 'It starts with Delo: delorun start.',
    'Then add your phone: run delorun devices approve here, open the address on the phone and type the code it shows.',
    '',
  ].join('\n'))
  return EXIT.ok
}

/**
 * `delorun reach off`.
 * @param args - the options.
 * @param context - the environment and output.
 * @param dependencies - the runner and the running check.
 * @returns the exit code.
 */
async function turnOff(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok> {
  const { home, profile } = await preparedProfile('off', args, context)
  const row = readReachRow(home, profile)
  writeReachRow(home, profile, { ...row, enabled: false })
  const removed = await unserve(dependencies.tailscale, row.servePort)
  const lines = [
    `Remote access is off for the profile ${profile}.`,
    removed ? 'Tailscale no longer serves this computer\'s studio.' : 'Tailscale did not confirm that it stopped serving; it serves nothing once Delo restarts.',
  ]
  if (dependencies.running(home, profile)) lines.push('Restart Delo to close the remote listener now: delorun stop, then delorun start.')
  context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}

/**
 * `delorun reach status`.
 * @param args - the options.
 * @param context - the environment and output.
 * @param dependencies - the studio client and the running check.
 * @returns the exit code.
 */
async function status(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok> {
  const values = parseOptions('reach status', args, { profile: { type: 'string' } })
  const profile = selectProfile(values.profile, context.env)
  const home = (await resolveDeloHome(context.env)).path
  const row = readReachRow(home, profile)
  const lines = [row.enabled ? `Tailscale private: on, ${row.address}` : 'Tailscale private: off']
  if (!dependencies.running(home, profile)) {
    lines.push('Delo is not running, so no remote listener is open.')
  } else {
    const reply = await dependencies.studio(studioPort(home, profile), 'GET', '/delo/reach/status').catch(() => undefined)
    const options: unknown = reply?.status === 200 && typeof reply.body === 'object' && reply.body !== null ? Reflect.get(reply.body, 'options') : undefined
    const live: readonly unknown[] = Array.isArray(options) ? options : []
    if (live.length === 0) lines.push('The running home reports no remote listener; it applies a change at its next start.')
    for (const entry of live) {
      if (typeof entry !== 'object' || entry === null) continue
      const state: unknown = Reflect.get(entry, 'state')
      const detail: unknown = Reflect.get(entry, 'detail')
      lines.push(`Running: ${String(state)}${typeof detail === 'string' ? ` — ${detail}` : ''}`)
    }
  }
  context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}
