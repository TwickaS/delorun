/**
 * Contract C7's reach provider and the `reach-tailscale-private` provider.
 *
 * A provider resolves its option's configuration rows into a {@link ReachSpec} at load, connects a started reach
 * listener to the outside with `start`, disconnects with `stop`, and publishes its visibility note. It declares the
 * identity factor a session created through it records; `@delo/home-auth` reads the factor from that declaration.
 *
 * The Tailscale private provider declares `tailnet-membership`. Its `start` checks that Tailscale is installed, runs,
 * is signed in and has HTTPS certificates on, that the configured address is this machine's `ts.net` name, and then
 * configures `tailscale serve` to the listener's bound port; `stop` removes the serve target. Every `tailscale` call goes
 * through the injected runner, and none runs through `sudo`.
 *
 * @module @delo/reach/provider
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReachListenerId, StudioAddress } from '@delo/contract-admission'
import type { IdentityFactor } from '@delo/contract-oidc-passkeys'
import { REACH_OPTION_LISTENERS, type ReachConfigRows, type ReachOptionId } from '@delo/contract-reach-providers'
import { ReachError, readTailscale, serve, unserve, type TailscaleRunner } from './tailscale.ts'

/** What a provider resolved from its rows: every value it would otherwise default. */
export interface ReachSpec {
  readonly option: ReachOptionId
  readonly listener: ReachListenerId
  readonly address: StudioAddress
  readonly servePort: number
}

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
   * Connect a started listener to the outside.
   * @param spec - the resolved spec.
   * @param port - the listener's bound port on `127.0.0.1`.
   * @throws {ReachError} for a check that fails.
   */
  start(spec: ReachSpec, port: number): Promise<void>
  /**
   * Disconnect.
   * @param spec - the spec it started with.
   */
  stop(spec: ReachSpec): Promise<void>
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

  /**
   * @param run - the `tailscale` runner.
   */
  constructor(private readonly run: TailscaleRunner) {}

  /** @inheritdoc */
  resolve(rows: ReachConfigRows): ReachSpec | undefined {
    const row = rows.tailscalePrivate
    if (row?.enabled !== true) return undefined
    const servePort = row.servePort
    if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) {
      throw new ReachError('PORT_CONFLICT', `tailscalePrivate.servePort must be a port from 1 to 65535, got ${String(servePort)}`)
    }
    const address = URL.parse(row.address)
    if (address?.protocol !== 'https:' || !address.hostname.endsWith('.ts.net') || address.origin !== row.address) {
      throw new ReachError('TAILSCALE_ADDRESS_MISMATCH', `tailscalePrivate.address must be this machine's https ts.net address, got ${JSON.stringify(row.address)}`)
    }
    return { option: this.option, listener: REACH_OPTION_LISTENERS[this.option], address: row.address, servePort }
  }

  /** @inheritdoc */
  async start(spec: ReachSpec, port: number): Promise<void> {
    const facts = await readTailscale(this.run)
    const expected = tailscaleAddress(facts.dnsName, spec.servePort)
    if (expected !== spec.address) {
      throw new ReachError('TAILSCALE_ADDRESS_MISMATCH', `The configured address ${spec.address} is not this machine's Tailscale address ${expected}. Run delorun reach on tailscale again`)
    }
    await serve(this.run, spec.servePort, port)
  }

  /** @inheritdoc */
  async stop(spec: ReachSpec): Promise<void> {
    await unserve(this.run, spec.servePort)
  }

  /** @inheritdoc */
  visibility(): string {
    return TAILSCALE_PRIVATE_VISIBILITY
  }
}
