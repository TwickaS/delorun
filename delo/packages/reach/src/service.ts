/**
 * The `reach` service: contract C7's Service Definition with its provider registry, as a Cordis plugin over the
 * `@delo/reach` configuration rows.
 *
 * Mounting it registers the Tailscale private provider. For each option whose row is enabled it asks `homeAuth` to
 * serve the option's listener with the factor the provider declares, opens the reach listener through
 * `ctx.connection.openReachListener` on a port the operating system assigns, and starts the provider on that port. A
 * provider that fails a check leaves the option `blocked` with C7's code, and the listener closed. Disposing the plugin
 * stops each provider, closes its listener and stops serving it, in that order. Every option is off by default.
 *
 * @module @delo/reach/service
 */
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { DEFAULT_SERVE_PORT, type ReachConfigRows, type ReachErrorCode, type ReachOptionId, type ReachState, type ReachStateChange } from '@delo/contract-reach-providers'
import { TailscalePrivateProvider, type ReachProvider, type ReachSpec } from './provider.ts'
import { ReachError, systemTailscale, type TailscaleRunner } from './tailscale.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Contract C7's reach providers. */
    reach: ReachService
  }
  interface Events {
    /**
     * A reach option changed state.
     * @param change - the option, its state and the cause of `blocked` or `failed`.
     * @mode emit
     */
    'reach/state'(change: ReachStateChange): void
  }
}

/** The plugin's configuration: C7's rows for the options this home builds. */
export interface Config {
  readonly tailscalePrivate: {
    readonly enabled: boolean
    readonly address: string
    readonly servePort: number
  }
}

/** The plugin's configuration schema. */
export const Config: schema<Config> = schema.object({
  tailscalePrivate: schema.object({
    enabled: schema.boolean().default(false).description('Whether this home is reachable on its Tailscale private address.'),
    address: schema.string().default('').description('This machine\'s https ts.net address, as delorun reach on tailscale writes it.'),
    servePort: schema.natural().default(DEFAULT_SERVE_PORT).description('The port Tailscale serves HTTPS on.'),
  }).default({ enabled: false, address: '', servePort: DEFAULT_SERVE_PORT }),
})

/** One option's state as the studio and the commands show it. */
export interface ReachStatus {
  readonly option: ReachOptionId
  readonly state: ReachState
  readonly address?: StudioAddress
  readonly cause?: ReachErrorCode
  readonly detail?: string
}

/** The `reach` service. */
export class ReachService extends Service {
  static inject = ['homeAuth', 'connection']
  static Config = Config

  private readonly providers = new Map<ReachOptionId, ReachProvider>()
  private readonly states = new Map<ReachOptionId, ReachStatus>()

  /**
   * @param ctx - the plugin context, which injects `homeAuth` and `connection`.
   * @param config - the rows.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'reach')
  }

  /**
   * Register a provider for one option.
   * @param provider - the provider.
   * @returns the disposer.
   * @throws Error when the option has a provider already.
   */
  register(provider: ReachProvider): () => void {
    if (this.providers.has(provider.option)) throw new Error(`reach: the option ${provider.option} has a provider already`)
    this.providers.set(provider.option, provider)
    return () => {
      if (this.providers.get(provider.option) === provider) this.providers.delete(provider.option)
    }
  }

  /**
   * Every registered option's state.
   * @returns the states.
   */
  status(): readonly ReachStatus[] {
    return [...this.providers.keys()].map(option => this.states.get(option) ?? { option, state: 'off' })
  }

  /**
   * The `tailscale` runner the Tailscale provider uses.
   * @returns the system's `tailscale`, started without a shell.
   */
  protected tailscale(): TailscaleRunner {
    return systemTailscale()
  }

  /**
   * Register the providers and start each enabled option.
   * @throws {ReachError} at load for an enabled row that is invalid.
   */
  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => this.register(new TailscalePrivateProvider(this.tailscale())), 'reach tailscale-private provider')
    const rows: ReachConfigRows = {
      tailscalePrivate: { ...this.config.tailscalePrivate, address: brandString<StudioAddress>(this.config.tailscalePrivate.address) },
    }
    for (const provider of this.providers.values()) {
      const spec = provider.resolve(rows)
      if (spec !== undefined) await this.startOption(provider, spec)
    }
  }

  /**
   * Start one option: serve its listener, open it and connect it; stop it when the plugin is disposed.
   * @param provider - the option's provider.
   * @param spec - the resolved spec.
   */
  private async startOption(provider: ReachProvider, spec: ReachSpec): Promise<void> {
    this.change({ option: spec.option, state: 'starting', address: spec.address })
    const unserve = this.ctx.homeAuth.serve({ listener: spec.listener, address: spec.address, factor: provider.factor })
    let listener: Awaited<ReturnType<typeof this.ctx.connection.openReachListener>> | undefined
    try {
      listener = await this.ctx.connection.openReachListener({ listener: spec.listener, bind: { kind: 'loopback' } })
      const port = listener.address?.port
      if (port === undefined) throw new Error(`reach: the ${spec.listener} listener opened without a port`)
      await provider.start(spec, port)
    } catch (error) {
      await listener?.close()
      unserve()
      const cause = error instanceof ReachError ? error : undefined
      this.change({
        option: spec.option,
        state: cause === undefined ? 'failed' : 'blocked',
        address: spec.address,
        cause: cause?.code ?? 'TAILSCALE_NOT_LOGGED_IN',
        detail: error instanceof Error ? (cause?.detail ?? error.message) : String(error),
      })
      return
    }
    const open = listener
    this.change({ option: spec.option, state: 'ready', address: spec.address })
    this.ctx.effect(() => async () => {
      this.change({ option: spec.option, state: 'stopping', address: spec.address })
      try {
        await provider.stop(spec)
      } finally {
        await open.close()
        unserve()
        this.change({ option: spec.option, state: 'off' })
      }
    }, `reach ${spec.option}`)
  }

  /**
   * Record and announce one option's state.
   * @param status - the new state.
   */
  private change(status: ReachStatus): void {
    this.states.set(status.option, status)
    this.ctx.emit('reach/state', { option: status.option, state: status.state, ...(status.cause === undefined ? {} : { cause: status.cause }) })
  }
}

export default ReachService
