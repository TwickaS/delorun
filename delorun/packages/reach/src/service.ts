/**
 * The `reach` service: contract C7's Service Definition with its provider registry, as a Cordis plugin over the
 * `@delorun/reach` configuration rows.
 *
 * Mounting it registers the Tailscale private provider. For each option whose row is enabled it asks `homeAuth` to
 * serve the option's listener with the factor the provider declares, binds the option's fixed listener port on
 * `127.0.0.1` ({@link openFront}), opens the reach listener through `ctx.connection.openReachListener` on a port the
 * operating system assigns, relays the fixed port to it, and starts the provider, which connects the fixed port to the
 * outside. A fixed port that does not bind, or a provider that fails a check, leaves the option `blocked` with C7's
 * code; the provider's stop runs first, so the outside reaches no port this home released, and its failure is added to
 * the state's sentence. While the option is ready the service runs the provider's check every `checkIntervalMs` on an
 * unreferenced timer: an unknown answer makes it `degraded`, and a blocking one stops it as a failed start does.
 * Disposing the plugin stops each provider, closes its listeners and stops serving it, in that order, and logs a stop
 * that failed. {@link ReachService.apply} restarts every option from new rows while the home runs, which the update
 * channel's `reach.apply` drives after `delorun reach on|off` wrote them; starts, applies and disposal run one at a
 * time. Each state change is logged to the home log with its code and sentence, never a secret. Every option is off by
 * default.
 *
 * @module @delorun/reach/service
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { isLoopbackHost } from '@delorun/home-auth'
import schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { ELEVATION_LIMITS } from '@delorun/contract-oidc-passkeys'
import {
  DEFAULT_SERVE_CHECK_INTERVAL_MS, DEFAULT_SERVE_PORT, MIN_SERVE_CHECK_INTERVAL_MS, type ReachConfigRows, type ReachErrorCode, type ReachOptionId, type ReachState, type ReachStateChange,
} from '@delorun/contract-reach-providers'
import { openFront, type LoopbackFront } from './front.ts'
import { MAX_SERVE_CHECK_INTERVAL_MS, TailscalePrivateProvider, type ReachProvider, type ReachSpec } from './provider.ts'
import { ReachError, readComputerUser, systemTailscale, type TailscaleRunner } from './tailscale.ts'
import { checkTailnetPeer } from './tailnet-peer.ts'

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
  /**
   * C16 switch `reach`: whether the reach service mounts at all. Off, which is the parity value and the schema's
   * default, it registers no provider, opens no listener and answers no route. Delorun's composition turns it on; each
   * option stays off until the person turns it on.
   */
  readonly enabled: boolean
  readonly tailscalePrivate: {
    readonly enabled: boolean
    readonly address: string
    readonly servePort: number
    /** The fixed port on `127.0.0.1` the serve target names; `0` until `delorun reach on tailscale` chooses one. */
    readonly listenerPort: number
    /** How often a ready option rereads the serve status for Funnel, in milliseconds. */
    readonly serveCheckIntervalMs: number
    /** How many minutes an elevation approved for a device lasts. */
    readonly elevationMinutes: number
  }
}

/** The plugin's configuration schema. */
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().description('C16 switch reach: whether the reach service mounts at all.').default(false),
  tailscalePrivate: schema.object({
    enabled: schema.boolean().description('Whether this home is reachable on its Tailscale private address.').default(false),
    address: schema.string().default('').description('This machine\'s https ts.net address, as delorun reach on tailscale writes it.'),
    servePort: schema.natural().max(65_535).default(DEFAULT_SERVE_PORT).description('The port Tailscale serves HTTPS on.'),
    listenerPort: schema.natural().max(65_535).default(0)
      .description('The fixed port on 127.0.0.1 that tailscale serve forwards to, which delorun reach on tailscale chooses once and writes here. 0 means none is chosen, and an enabled option then fails at load.'),
    serveCheckIntervalMs: schema.natural().min(MIN_SERVE_CHECK_INTERVAL_MS).max(MAX_SERVE_CHECK_INTERVAL_MS).default(DEFAULT_SERVE_CHECK_INTERVAL_MS)
      .description('How often, in milliseconds, a ready option rereads tailscale serve status for Funnel, from 1000 to 2147483647.'),
    elevationMinutes: schema.natural().min(1).max(ELEVATION_LIMITS.maxMinutes).default(ELEVATION_LIMITS.defaultMinutes)
      .description('How many minutes sensitive actions stay unlocked on a device after the person approves it at this computer, from 1 to 60.'),
  }).default({ enabled: false, address: '', servePort: DEFAULT_SERVE_PORT, listenerPort: 0, serveCheckIntervalMs: DEFAULT_SERVE_CHECK_INTERVAL_MS, elevationMinutes: ELEVATION_LIMITS.defaultMinutes }),
})

/**
 * The path of the reach status, which the studio's settings and onboarding read: `GET` answers {@link ReachSummary}.
 * A profile without the reach service answers it 404, which a reader takes as "no reach in this profile".
 */
export const REACH_STATUS_PATH = '/delorun/reach/status' as const

/** What `GET /delorun/reach/status` answers. */
export interface ReachSummary {
  /** Always true: the route exists only where the reach service runs. */
  readonly available: true
  /** Whether the owner has claimed this home; the device list refuses with `NO_OWNER` until then. */
  readonly hasOwner: boolean
  /** Each option this home builds, with its state; `ready` means it is set up and reachable. */
  readonly options: readonly ReachStatus[]
}

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
  static inject = ['homeAuth', 'connection', 'webServer']
  static Config = Config

  private readonly providers = new Map<ReachOptionId, ReachProvider>()
  private readonly states = new Map<ReachOptionId, ReachStatus>()
  /** How to stop each started option: its provider, listeners and serving, in that order. */
  private readonly stops = new Map<ReachOptionId, () => Promise<void>>()
  /** The last start, apply or disposal; each waits for the one before it. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The rows. */
  private readonly config: Config

  /**
   * @param ctx - the plugin context, which injects `homeAuth` and `connection`.
   * @param config - the rows.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'reach')
    this.config = config
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
   * Whether the service runs: the C16 switch `reach` was on when the plugin loaded.
   * @returns the switch.
   */
  get mounted(): boolean {
    return this.config.enabled
  }

  /**
   * Apply new rows to a running home: stop each started option, then start each option whose row is on, as a start
   * does. A row that does not resolve leaves its option `blocked` with the resolver's code.
   * @param rows - the rows, as the profile now holds them.
   * @returns every registered option's state once its start settled, or undefined when the switch `reach` was off at
   *   load, so no option can start before the next start.
   */
  async apply(rows: ReachConfigRows): Promise<readonly ReachStatus[] | undefined> {
    if (!this.config.enabled) return undefined
    return this.serialize(async () => {
      await this.stopAll()
      for (const provider of this.providers.values()) {
        let spec: ReachSpec | undefined
        try {
          spec = provider.resolve(rows)
        } catch (error) {
          if (!(error instanceof ReachError)) throw error
          this.change({ option: provider.option, state: 'blocked', cause: error.code, detail: error.detail })
          continue
        }
        if (spec === undefined) this.change({ option: provider.option, state: 'off' })
        else await this.startOption(provider, spec)
      }
      return this.status()
    })
  }

  /**
   * Run one start, apply or disposal after the one before it.
   * @param task - the work.
   * @returns its result.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch((_failed: unknown) => {
      // The failure reaches the caller of this task; the next task runs regardless.
    })
    return next
  }

  /** Stop every started option. */
  private async stopAll(): Promise<void> {
    for (const stop of [...this.stops.values()]) await stop()
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
    if (!this.config.enabled) return
    this.ctx.effect(() => this.ctx.webServer.register({ kind: 'exact', path: REACH_STATUS_PATH, handler: (request, response) => { this.answerStatus(request, response).catch((error: unknown) => { this.statusFailed(response, error) }) } }), 'reach status route')
    this.ctx.effect(() => this.register(new TailscalePrivateProvider(this.tailscale())), 'reach tailscale-private provider')
    // A666, A667: the Tailscale private listener is the only one whose connections Tailscale can name, so this provider
    // supplies the local API check the home corroborates a forwarded address with. A home without it corroborates no
    // address, and every device keeps today's behaviour.
    this.ctx.effect(() => this.ctx.homeAuth.supplyTailnetCheck(address => checkTailnetPeer(address)), 'reach tailnet peer check')
    this.ctx.effect(() => async () => { await this.serialize(() => this.stopAll()) }, 'reach options')
    const rows: ReachConfigRows = {
      tailscalePrivate: { ...this.config.tailscalePrivate, address: brandString<StudioAddress>(this.config.tailscalePrivate.address) },
    }
    await this.serialize(async () => {
      for (const provider of this.providers.values()) {
        const spec = provider.resolve(rows)
        if (spec !== undefined) await this.startOption(provider, spec)
      }
    })
  }

  /**
   * Answer `GET /delorun/reach/status` with {@link ReachSummary}: on the loopback listener under a loopback `Host` to the
   * studio's own credential, and to a session a reach listener admitted; both are what upstream's
   * `connection.requestRejection` accepts. The summary names the tailnet address and each option's failure, so a local
   * program without the credential, another arrival, and a phone that has not signed in are refused: `421 HOST_MISMATCH`
   * for a foreign arrival, `401 NOT_SIGNED_IN` without the credential or session, `403 ORIGIN_MISMATCH` for a request
   * the Host and Origin fence refuses.
   * @param request - the request.
   * @param response - the response.
   */
  private async answerStatus(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const arrival = this.ctx.homeAuth.arrivalOf(request)
    const loopback = arrival.listener === 'loopback' && isLoopbackHost(arrival.host)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    if (!loopback && (arrival.listener === undefined || arrival.listener === 'loopback')) {
      response.statusCode = 421
      response.end(JSON.stringify({ error: 'HOST_MISMATCH', message: 'The reach status answers the studio only' }))
      return
    }
    const rejection = this.ctx.connection.requestRejection(request)
    if (rejection !== undefined) {
      response.statusCode = rejection
      response.end(JSON.stringify(rejection === 401
        ? { error: 'NOT_SIGNED_IN', message: 'The reach status answers the studio open on this computer, or a signed-in device' }
        : { error: 'ORIGIN_MISMATCH', message: 'The reach status answers the studio\'s own page only' }))
      return
    }
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Read the reach status with a GET' }))
      return
    }
    const summary: ReachSummary = { available: true, hasOwner: await this.ctx.homeAuth.owner() !== undefined, options: this.status() }
    response.statusCode = 200
    response.end(JSON.stringify(summary))
  }

  /**
   * Answer a status request whose handler threw: log it and send `500` unless the response already started.
   * @param response - the response.
   * @param error - what the handler threw, such as an unreadable owner record.
   */
  private statusFailed(response: ServerResponse, error: unknown): void {
    this.ctx.logger.warn(`reach: the status request failed: ${error instanceof Error ? error.message : String(error)}`)
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'STATUS_UNAVAILABLE', message: 'The reach status could not be read; the Host log says why' }))
  }

  /**
   * Start one option: serve its listener, hold its fixed port, open the reach listener, relay the fixed port to it and
   * connect the provider; watch it while ready, and record how {@link stopAll} stops it.
   * @param provider - the option's provider.
   * @param spec - the resolved spec.
   */
  private async startOption(provider: ReachProvider, spec: ReachSpec): Promise<void> {
    this.change({ option: spec.option, state: 'starting', address: spec.address })
    // Only the private option sits behind `tailscale serve`, whose `Tailscale-User-*` headers name the person; another
    // option's clients could send any value, so its listener neither reads them nor compares them with the computer's user.
    const readsTailscaleIdentity = spec.option === 'tailscale-private'
    let unserve: () => void
    try {
      const computerUser = readsTailscaleIdentity ? await readComputerUser(this.tailscale()) : undefined
      unserve = this.ctx.homeAuth.serve({
        listener: spec.listener, address: spec.address, factor: provider.factor, elevationMinutes: spec.elevationMinutes,
        ...(readsTailscaleIdentity ? { readsTailscaleIdentity } : {}),
        ...(computerUser === undefined ? {} : { computerUser }),
      })
    } catch (error) {
      // Home auth refuses a row whose elevation passes its cap, or a listener it serves already; nothing is held yet.
      this.refuse(spec, error, undefined)
      return
    }
    let front: LoopbackFront
    try {
      front = await openFront(spec.listenerPort, (error) => { this.ctx.logger.warn(`reach: the ${spec.option} fixed port server failed: ${error.message}`) })
    } catch (error) {
      // A rule left by an earlier run would point at a port another program holds.
      const removal = await stopProvider(provider, spec)
      unserve()
      this.refuse(spec, error, removal)
      return
    }
    let listener: Awaited<ReturnType<typeof this.ctx.connection.openReachListener>> | undefined
    try {
      listener = await this.ctx.connection.openReachListener({ listener: spec.listener, bind: { kind: 'loopback' } })
      const port = listener.address?.port
      if (port === undefined) throw new Error(`reach: the ${spec.listener} listener opened without a port`)
      front.connect(port)
      await provider.start(spec)
    } catch (error) {
      const removal = await stopProvider(provider, spec)
      await listener?.close()
      await front.close()
      unserve()
      this.refuse(spec, error, removal)
      return
    }
    const open = listener
    this.change({ option: spec.option, state: 'ready', address: spec.address })
    // `disposing` makes a check that answers after disposal began change nothing; `released` records that the option
    // stopped serving, by a blocking check or by disposal.
    const watch: { disposing: boolean; released: boolean; checking: Promise<void> | undefined } = { disposing: false, released: false, checking: undefined }
    const release = async (): Promise<ReachError | undefined> => {
      watch.released = true
      clearInterval(timer)
      const removal = await stopProvider(provider, spec)
      await open.close()
      await front.close()
      unserve()
      return removal
    }
    const check = async (): Promise<void> => {
      const result = await provider.check(spec)
      if (watch.disposing) return
      const current = this.states.get(spec.option)
      switch (result.kind) {
        case 'ok':
          if (current?.state === 'degraded') this.change({ option: spec.option, state: 'ready', address: spec.address })
          return
        case 'unknown':
          if (current?.state !== 'degraded') {
            this.change({ option: spec.option, state: 'degraded', address: spec.address, cause: result.error.code, detail: result.error.detail })
          }
          return
        case 'blocked': {
          const removal = await release()
          this.change({ option: spec.option, state: 'blocked', address: spec.address, cause: result.error.code, detail: withRemoval(result.error.detail, removal) })
          return
        }
        /* v8 ignore next 4 -- ReachCheck is a closed union, so the default holds no reachable statement. */
        default: {
          const unexpected: never = result
          throw new Error(`reach: unknown check result ${JSON.stringify(unexpected)}`)
        }
      }
    }
    const timer = setInterval(() => {
      if (watch.checking !== undefined) return
      watch.checking = check()
        .catch((error: unknown) => { this.ctx.logger.warn(`reach: the ${spec.option} check failed: ${error instanceof Error ? error.message : String(error)}`) })
        .finally(() => { watch.checking = undefined })
    }, spec.checkIntervalMs)
    timer.unref()
    this.stops.set(spec.option, async () => {
      this.stops.delete(spec.option)
      watch.disposing = true
      clearInterval(timer)
      await watch.checking
      this.change({ option: spec.option, state: 'stopping', address: spec.address })
      if (!watch.released) {
        const removal = await release()
        if (removal !== undefined) this.ctx.logger.error(`reach: ${spec.option} stopped, but ${removal.detail} (${removal.code})`)
      }
      this.change({ option: spec.option, state: 'off' })
    })
  }

  /**
   * Record a start that did not reach `ready`: `blocked` for a provider refusal, `failed` for any other error.
   * @param spec - the spec.
   * @param error - what stopped it.
   * @param removal - the provider stop's failure, if it failed.
   */
  private refuse(spec: ReachSpec, error: unknown, removal: ReachError | undefined): void {
    const cause = error instanceof ReachError ? error : undefined
    const detail = cause?.detail ?? (error instanceof Error ? error.message : String(error))
    this.change({
      option: spec.option,
      state: cause === undefined ? 'failed' : 'blocked',
      address: spec.address,
      cause: cause?.code ?? 'TAILSCALE_NOT_LOGGED_IN',
      detail: withRemoval(detail, removal),
    })
  }

  /**
   * Record, log and announce one option's state. The log line names the option, the state, and for `blocked`,
   * `failed` and `degraded` the code and sentence, which name no secret.
   * @param status - the new state.
   */
  private change(status: ReachStatus): void {
    this.states.set(status.option, status)
    const line = ['reach:', status.option, status.state, ...status.cause === undefined ? [] : [`(${status.cause}):`, status.detail]].join(' ')
    if (status.state === 'failed') this.ctx.logger.error(line)
    else if (status.state === 'blocked' || status.state === 'degraded') this.ctx.logger.warn(line)
    else this.ctx.logger.info(line)
    this.ctx.emit('reach/state', { option: status.option, state: status.state, ...(status.cause === undefined ? {} : { cause: status.cause }) })
  }
}


/**
 * Stop a provider, keeping its failure as a value.
 * @param provider - the provider.
 * @param spec - the spec it started with, or tried to.
 * @returns the failure, or undefined when the stop was confirmed; a missing `tailscale` counts as confirmed, because
 *   nothing serves without it.
 */
async function stopProvider(provider: ReachProvider, spec: ReachSpec): Promise<ReachError | undefined> {
  try {
    await provider.stop(spec)
    return undefined
  } catch (error) {
    if (error instanceof ReachError) return error.code === 'TAILSCALE_NOT_INSTALLED' ? undefined : error
    return new ReachError('TAILSCALE_SERVE_CONFLICT', `the serve rule could not be removed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A state's sentence with the provider stop's failure after it.
 * @param detail - the sentence.
 * @param removal - the stop's failure, if any.
 * @returns the sentence, followed by the failure's unless it says the same.
 */
function withRemoval(detail: string, removal: ReachError | undefined): string {
  return removal === undefined || removal.detail === detail ? detail : `${detail}. ${removal.detail}`
}

export default ReachService
