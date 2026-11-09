/**
 * @delo/plugin-fetch-guard: the optional `fetchGuard` service that the HTTP
 * fetch provider consults before every hop. When the switch is on, the service
 * refuses the destinations of Delo's contract — loopback, link-local,
 * private-network, unique-local, shared (carrier-grade NAT), multicast and
 * reserved addresses, and the unspecified address — with a typed refusal the
 * model reads; every other address is allowed. When the switch is off — the
 * parity value — the plugin provides no service: the provider reads its absence
 * per hop and runs unguarded, with no per-hop resolution, byte-identical to
 * upstream's fetch.
 *
 * The service is deliberately optional at its consumer: the provider reads it
 * per hop with `ctx.get()`, so mounting or unmounting this plugin changes the
 * next request without reloading the provider. The refusal classifier and the
 * typed refusal live in [`guard.ts`](src/guard.ts), free of Cordis.
 *
 * @module @delo/plugin-fetch-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { FetchGuard, FetchGuardAddress } from '@deepseek-ai/dsh-web-fetch-http'
import z from '@deepseek-ai/schemastery'
import { FetchGuardRefusedError, refusalMessage, refusalOf } from './guard.ts'

export { classifyAddress, FetchGuardRefusedError, refusalMessage, refusalOf } from './guard.ts'
export type { FetchGuardRefusalCode } from './guard.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fetch-guard'

/** No services: the guard reads its switch and classifies resolved literals only. */
export const inject = []

/** The fetch guard plugin's configuration. */
export interface Config {
  /**
   * Refuse loopback, link-local, private-network, unique-local, shared,
   * multicast and reserved destinations, and the unspecified address, before
   * each connection opens. On, the plugin provides the `fetchGuard` service and
   * the shipped composition mounts it that way. Off — Delo's C16 switch
   * `fetch_guard`, the parity value — it provides no service, and `web_fetch`
   * behaves as stock's.
   */
  readonly enabled: boolean
}

/** The plugin's configuration schema. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * The `fetchGuard` service: it classifies each hop's resolved addresses before
 * the connection opens. The plugin's entry provides it only with the switch
 * on; mounted directly as a class plugin it always provides itself, and with
 * the switch off it refuses nothing, so the parity composition can keep it
 * mounted and still replay upstream's fetch scenarios unchanged.
 */
export class FetchGuardService extends Service implements FetchGuard {
  /** No services: the guard reads its switch and classifies literals only. */
  static inject = []

  static Config = Config

  /**
   * @param ctx - the plugin context.
   * @param config - the switch; off, the service refuses nothing.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'fetchGuard')
  }

  /** Whether the C16 switch `fetch_guard` is on. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * Refuse the hop by throwing its typed refusal, or resolve to allow it.
   * Off, the service resolves without reading the addresses at all.
   * @param url - the hop's destination URL.
   * @param addresses - the addresses the hop's hostname resolved to, as the
   *   provider resolved them before this call.
   * @throws FetchGuardRefusedError naming the host and the reason, and no
   *   resolved address beyond them, when any address is refused.
   */
  async check(url: URL, addresses: readonly FetchGuardAddress[]): Promise<void> {
    if (!this.config.enabled) return
    const code = refusalOf(addresses.map(address => address.address))
    if (code !== undefined) throw new FetchGuardRefusedError(code, url.hostname, refusalMessage(code, url.hostname))
  }
}

/**
 * Mount the plugin. On, it provides the `fetchGuard` service the provider
 * reads per hop. Off — the parity value — it provides nothing, so
 * `ctx.get('fetchGuard')` answers `undefined` and the provider runs unguarded
 * with no per-hop resolution: byte-identical to upstream's fetch.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new FetchGuardService(ctx, config)
}

export default FetchGuardService
