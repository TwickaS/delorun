/**
 * `delorun reach status | on tailscale | off` (contract C7): remote access to the studio over the person's own tailnet.
 *
 * - `on tailscale` checks that Tailscale is installed, running and signed in, that the tailnet has HTTPS certificates
 *   on, and that the person's user may configure `tailscale serve`; for the last it prints the one command the person
 *   runs and runs nothing through `sudo`. It refuses while Tailscale Funnel is on for the address, and removes any rule
 *   on the serve port that is not this home's own, or every rule there while Delo is stopped, confirming each removal.
 *   It then writes the profile's `delo-reach` row with this machine's `ts.net` address and the fixed listener port,
 *   chosen once, and prints the address and the trust statement. The running home applies it at its next start.
 * - `off` turns the option off in the row, removes whatever Tailscale serves on the serve port at once, and confirms it
 *   is gone; a removal it cannot confirm exits non-zero with the reason.
 * - `status` prints the row, and whether the home runs; the studio's Devices section shows the live state.
 *
 * Every `tailscale` call goes through the injected runner.
 *
 * @module @delo/cli/reach/command
 */
import { DEFAULT_SERVE_PORT } from '@delo/contract-reach-providers'
import { funnelOn, ReachError, readServeRules, readTailscale, removeServe, serveTarget, systemTailscale, tailscaleAddress, type TailscaleRunner } from '@delo/reach'
import { resolveDeloHome } from '@delo/home'
import { profileRuns } from '@delo/home-process/permission-peers'
import { CliError, EXIT } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext } from '../command.ts'
import { hasCliProfile, selectProfile } from '../profile.ts'
import { listenerPortFor, readReachRow, writeReachRow } from './row.ts'
import { TRUST_STATEMENT } from './trust.ts'

/** What the command runs against. */
export interface ReachDependencies {
  /** Runs `tailscale`. */
  readonly tailscale: TailscaleRunner
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
 * Whether a profile's home process runs: `@delo/home-process`'s {@link profileRuns}.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns true when a live process holds the lock.
 */
export function homeRuns(home: string, profile: string): boolean {
  return profileRuns(home, profile)
}

/**
 * Build the command over its dependencies.
 * @param dependencies - the runner and the running check.
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

/** `delorun reach`, over the system's `tailscale` and the home lock. */
export const reachCommand: CliCommand = createReachCommand({ tailscale: systemTailscale(), running: homeRuns })

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
  const running = dependencies.running(home, profile)
  let dnsName: string
  let listenerPort: number
  try {
    ({ dnsName } = await readTailscale(dependencies.tailscale))
    listenerPort = await listenerPortFor(readReachRow(home, profile).listenerPort, running)
    const target = serveTarget(listenerPort)
    const rules = await readServeRules(dependencies.tailscale, dnsName, DEFAULT_SERVE_PORT, target)
    if (rules.funnel) throw funnelOn(dnsName, DEFAULT_SERVE_PORT, 'then run delorun reach on tailscale again')
    // A stopped home holds no port, so even its own rule would forward to a port any local program could bind.
    if (rules.present && (!rules.own || !running)) await removeServe(dependencies.tailscale, dnsName, DEFAULT_SERVE_PORT, target)
  } catch (error) {
    if (!(error instanceof ReachError)) throw error
    context.stderr(`delorun reach: ${error.detail} (${error.code})\n`)
    return EXIT.failed
  }
  const address = tailscaleAddress(dnsName, DEFAULT_SERVE_PORT)
  writeReachRow(home, profile, { ...readReachRow(home, profile), enabled: true, address, servePort: DEFAULT_SERVE_PORT, listenerPort })
  context.stdout([
    `Remote access is on for the profile ${profile} at ${address}`,
    '',
    ...TRUST_STATEMENT,
    '',
    running
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
async function turnOff(args: readonly string[], context: CommandContext, dependencies: ReachDependencies): Promise<typeof EXIT.ok | typeof EXIT.failed> {
  const { home, profile } = await preparedProfile('off', args, context)
  const row = readReachRow(home, profile)
  writeReachRow(home, profile, { ...row, enabled: false })
  const running = dependencies.running(home, profile)
  const lines = [`Remote access is off for the profile ${profile}.`]
  try {
    const host = URL.parse(row.address)?.hostname ?? (await readTailscale(dependencies.tailscale)).dnsName
    await removeServe(dependencies.tailscale, host, row.servePort, serveTarget(row.listenerPort))
    lines.push('Tailscale no longer serves this computer\'s studio.')
  } catch (error) {
    if (!(error instanceof ReachError)) throw error
    if (error.code !== 'TAILSCALE_NOT_INSTALLED') {
      context.stdout(`${lines.join('\n')}\n`)
      context.stderr(`delorun reach: Tailscale may still serve this computer's studio. ${error.detail} (${error.code})\n`)
      return EXIT.failed
    }
    lines.push('Tailscale is not installed, so nothing serves this computer\'s studio.')
  }
  if (running) lines.push('Restart Delo to close the remote listener now: delorun stop, then delorun start.')
  context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}

/**
 * `delorun reach status`.
 * @param args - the options.
 * @param context - the environment and output.
 * @param dependencies - the running check.
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
    // The live state answers only the studio's own page, so the command points there instead of asking over HTTP.
    lines.push('Delo is running. Settings → Devices in the studio on this computer shows whether the address is ready; a change applies at the next start.')
  }
  context.stdout(`${lines.join('\n')}\n`)
  return EXIT.ok
}
