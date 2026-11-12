/**
 * Contract C7's reach provider and the `reach-tailscale-private` provider.
 *
 * A provider resolves its option's configuration rows into a {@link ReachSpec} at load, connects a started reach
 * listener to the outside with `start`, disconnects with `stop`, and publishes its visibility note. It declares the
 * identity factor a session created through it records; `@delo/home-auth` reads the factor from that declaration.
 *
 * The Tailscale private provider declares `tailnet-membership`. Its `start` checks that Tailscale is installed, runs,
 * is signed in and has HTTPS certificates on, and that the configured address is this machine's `ts.net` name; reads
 * `tailscale serve status --json` and refuses while Funnel is allowed for the address; removes any rule on the serve
 * port that is not this home's own and confirms it is gone; and then configures `tailscale serve` to the fixed
 * listener port, which the service holds by then. `stop` removes whatever is served on the serve port and confirms it
 * is gone; `check` rereads the serve status for Funnel while the option is ready. Every `tailscale` call goes through
 * the injected runner, and none runs through `sudo`.
 *
 * @module @delo/reach/provider
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReachListenerId, StudioAddress } from '@delo/contract-admission'
import type { IdentityFactor } from '@delo/contract-oidc-passkeys'
import { REACH_OPTION_LISTENERS, type ReachConfigRows, type ReachOptionId } from '@delo/contract-reach-providers'
import { ReachError, readServeRules, readTailscale, removeServe, serve, serveTarget, type TailscaleRunner } from './tailscale.ts'

/** What a provider resolved from its rows: every value it would otherwise default. */
export interface ReachSpec {
  readonly option: ReachOptionId
  readonly listener: ReachListenerId
  readonly address: StudioAddress
  readonly servePort: number
  /** The fixed port on `127.0.0.1` the service holds and the outside is connected to. */
  readonly listenerPort: number
  /** How often the service runs {@link ReachProvider.check} while the option is ready. */
  readonly checkIntervalMs: number
}

/**
 * What {@link ReachProvider.check} found.
 * - `ok`: the option may stay ready.
 * - `unknown`: the provider could not tell; the option is `degraded` until a later check answers.
 * - `blocked`: the option must stop serving at once.
 */
export type ReachCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unknown'; readonly error: ReachError }
  | { readonly kind: 'blocked'; readonly error: ReachError }

/** C7's Provider. */
export interface ReachProvider {
  /** The option it serves. */
  readonly option: ReachOptionId
  /** The identity factor a session created through it records. */
  readonly factor: IdentityFactor
  /**
   * Resolve the option's rows.
   * @param rows - the plugin's configuration rows.
   * @returns the spec, or undefined when the option is off.
   * @throws {ReachError} for a row that is missing or invalid.
   */
  resolve(rows: ReachConfigRows): ReachSpec | undefined
  /**
   * Connect the fixed listener port, which the service holds when it calls this, to the outside.
   * @param spec - the resolved spec.
   * @throws {ReachError} for a check that fails.
   */
  start(spec: ReachSpec): Promise<void>
  /**
   * Disconnect, and confirm the outside no longer reaches the fixed listener port.
   * @param spec - the spec it started with.
   * @throws {ReachError} when the disconnection fails or cannot be confirmed.
   */
  stop(spec: ReachSpec): Promise<void>
  /**
   * Recheck a ready option.
   * @param spec - the spec it started with.
   * @returns what the check found.
   */
  check(spec: ReachSpec): Promise<ReachCheck>
  /**
   * The option's visibility note.
   * @returns the text the studio and setup show.
   */
  visibility(): string
}

/** C7's visibility note for Tailscale private, as this home signs in on it. */
export const TAILSCALE_PRIVATE_VISIBILITY = 'This option uses no Delo infrastructure. Only devices on your tailnet can open this address. Tailscale\'s coordination service sees this home\'s name, the IP addresses of this home and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls ts.net and obtains the certificate for this address, so no app can pin this address\'s TLS key. Every device still needs approval at this computer.'

/**
 * The studio address of a `ts.net` name and serve port.
 * @param dnsName - the machine's `ts.net` name.
 * @param servePort - the serve port.
 * @returns `https://<name>`, with the port when it is not 443.
 */
export function tailscaleAddress(dnsName: string, servePort: number): StudioAddress {
  return brandString<StudioAddress>(servePort === 443 ? `https://${dnsName}` : `https://${dnsName}:${String(servePort)}`)
}

/** The `reach-tailscale-private` provider. */
export class TailscalePrivateProvider implements ReachProvider {
  readonly option = 'tailscale-private' as const
  readonly factor = 'tailnet-membership' as const
  /** The `tailscale` runner. */
  private readonly run: TailscaleRunner

  /**
   * @param run - the `tailscale` runner.
   */
  constructor(run: TailscaleRunner) {
    this.run = run
  }

  /** @inheritdoc */
  resolve(rows: ReachConfigRows): ReachSpec | undefined {
    const row = rows.tailscalePrivate
    if (row?.enabled !== true) return undefined
    const servePort = row.servePort
    if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) {
      throw new ReachError('PORT_CONFLICT', `tailscalePrivate.servePort must be a port from 1 to 65535, got ${String(servePort)}`)
    }
    const listenerPort = row.listenerPort
    if (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65_535) {
      throw new ReachError('PORT_CONFLICT', `tailscalePrivate.listenerPort must be a port from 1 to 65535, got ${String(listenerPort)}. Run delorun reach on tailscale again to choose one`)
    }
    const address = URL.parse(row.address)
    if (address?.protocol !== 'https:' || !address.hostname.endsWith('.ts.net') || address.origin !== row.address) {
      throw new ReachError('TAILSCALE_ADDRESS_MISMATCH', `tailscalePrivate.address must be this machine's https ts.net address, got ${JSON.stringify(row.address)}`)
    }
    return { option: this.option, listener: REACH_OPTION_LISTENERS[this.option], address: row.address, servePort, listenerPort, checkIntervalMs: row.serveCheckIntervalMs }
  }

  /** @inheritdoc */
  async start(spec: ReachSpec): Promise<void> {
    const facts = await readTailscale(this.run)
    const expected = tailscaleAddress(facts.dnsName, spec.servePort)
    if (expected !== spec.address) {
      throw new ReachError('TAILSCALE_ADDRESS_MISMATCH', `The configured address ${spec.address} is not this machine's Tailscale address ${expected}. Run delorun reach on tailscale again`)
    }
    const target = serveTarget(spec.listenerPort)
    const rules = await readServeRules(this.run, facts.dnsName, spec.servePort, target)
    if (rules.funnel) throw funnelOn(facts.dnsName, spec.servePort, RESTART)
    if (rules.present && !rules.own) await removeServe(this.run, facts.dnsName, spec.servePort, target)
    await serve(this.run, spec.servePort, spec.listenerPort)
  }

  /** @inheritdoc */
  async stop(spec: ReachSpec): Promise<void> {
    await removeServe(this.run, hostOf(spec), spec.servePort, serveTarget(spec.listenerPort))
  }

  /** @inheritdoc */
  async check(spec: ReachSpec): Promise<ReachCheck> {
    try {
      const rules = await readServeRules(this.run, hostOf(spec), spec.servePort, serveTarget(spec.listenerPort))
      return rules.funnel ? { kind: 'blocked', error: funnelOn(hostOf(spec), spec.servePort, RESTART) } : { kind: 'ok' }
    } catch (error) {
      // A runner that rejects leaves the answer unknown, as a Tailscale that cannot answer does.
      return { kind: 'unknown', error: error instanceof ReachError ? error : new ReachError('TAILSCALE_NOT_LOGGED_IN', `tailscale serve status failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  /** @inheritdoc */
  visibility(): string {
    return TAILSCALE_PRIVATE_VISIBILITY
  }
}

/**
 * The refusal while Funnel is allowed for the serve address, which would publish the studio's sign-in page to the
 * internet under the phone's origin.
 * @param host - this machine's `ts.net` name.
 * @param servePort - the serve port.
 * @param next - what the person does once Funnel is off, as a clause beginning with `then`.
 * @returns the refusal, naming the command that turns Funnel off.
 */
export function funnelOn(host: string, servePort: number, next: string): ReachError {
  return new ReachError('TAILSCALE_FUNNEL_ON', `Tailscale Funnel is on for ${host}:${String(servePort)}, which would put this studio on the public internet, so remote access stays off. Turn Funnel off with tailscale funnel --https=${String(servePort)} off, ${next}`)
}

/** Where {@link checkServeAccess} checks, and what its refusals ask the person to do next. */
export interface ServeAccessRequest {
  /** This machine's `ts.net` name. */
  readonly host: string
  readonly servePort: number
  /** The fixed listener port the row records. */
  readonly listenerPort: number
  /**
   * Whether this home's own rule on the serve port stays: true while the profile's home runs with the option on and
   * holds the listener port, so its rule forwards to the home. Otherwise every rule on the port is removed, because a
   * port no home holds can be bound by any local program.
   */
  readonly keepOwn: boolean
  /** What the person does once Funnel is off, as a clause beginning with `then`. */
  readonly next: string
}

/**
 * The checks `delorun reach on tailscale` and setup's reach section run before the row is written, after
 * {@link readTailscale}: Funnel is off for the address; a rule on the serve port that is not kept is removed, and its
 * removal confirmed; and the person's user may configure `tailscale serve`, which is tested by configuring it. A kept
 * rule is configured again unchanged; otherwise the serve target is configured to the listener port and removed again,
 * and the removal confirmed, so the test leaves no rule behind.
 * @param run - the runner.
 * @param request - the address, the ports, whether the home's own rule stays, and the next step after Funnel.
 * @throws {ReachError} `TAILSCALE_FUNNEL_ON`; `TAILSCALE_SERVE_NOT_PERMITTED` with {@link TAILSCALE_OPERATOR_COMMAND}
 *   when the person's user may not configure serve; `TAILSCALE_SERVE_CONFLICT` when a removal is not confirmed; a
 *   refusal of {@link readServeRules}.
 */
export async function checkServeAccess(run: TailscaleRunner, request: ServeAccessRequest): Promise<void> {
  const target = serveTarget(request.listenerPort)
  const rules = await readServeRules(run, request.host, request.servePort, target)
  if (rules.funnel) throw funnelOn(request.host, request.servePort, request.next)
  const keep = rules.present && rules.own && request.keepOwn
  if (rules.present && !keep) await removeServe(run, request.host, request.servePort, target)
  await serve(run, request.servePort, request.listenerPort)
  if (!keep) await removeServe(run, request.host, request.servePort, target)
}

/** What the running home's refusal asks the person to do once Funnel is off. */
const RESTART = 'then restart Delo'

/**
 * The `ts.net` name of a resolved spec's address.
 * @param spec - the spec, whose address `resolve` checked.
 * @returns the host name in lower case.
 */
function hostOf(spec: ReachSpec): string {
  return new URL(spec.address).hostname
}
