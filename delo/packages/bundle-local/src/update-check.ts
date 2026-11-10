/**
 * The `delo-update-check` row of `@delo/bundle-local`: when the update check runs and where its notice is served
 * (design `delo/docs/design/update-notice.md`). The row provides the `deloUpdateCheck` service, to which `delorun`
 * attaches the check itself once the profile has booted: the row decides when, the CLI decides how. With a source
 * attached, the row checks at once when the last check is at least {@link Config.intervalHours} old, then again each
 * interval while the Host runs, and serves the notice to the studio over the Connection Fetch route
 * {@link UPDATE_NOTICE_PATH}.
 *
 * Every registration sits behind the C16 switch `update_check` ({@link Config.enabled}), off by default: off, the
 * plugin provides no service, registers no route and no check runs, which is the parity value, because stock DSH makes
 * no such request.
 *
 * @module @delo/bundle-local/update-check
 */
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { UPDATE_NOTICE_PATH, type UpdateNotice, type UpdateNoticeResponse } from '@delo/contract-update-report'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** When Delo's update check runs, and its notice; present while the `delo-update-check` row is mounted with its switch on. */
    deloUpdateCheck: UpdateCheckService
  }
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'delo-update-check'

/** The interval and the deadline a row that sets neither runs with. */
export const UPDATE_CHECK_DEFAULTS = { intervalHours: 24, timeoutSeconds: 15 } as const

/** The longest interval: one timer must fire within it, and a timer's delay cannot pass 2^31 - 1 milliseconds. */
export const MAX_INTERVAL_HOURS = 480

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `update_check`: whether the row provides the `deloUpdateCheck` service and serves its notice. Off, the
   * parity value and the default, it mounts nothing and no check runs. Delo's composition turns it on, and
   * Settings → Privacy turns it off.
   */
  readonly enabled: boolean
  /** How long after one check, successful or not, the next one runs, in hours. */
  readonly intervalHours: number
  /** How long one check may take in all, in seconds; a check that takes longer fails and shows nothing. */
  readonly timeoutSeconds: number
}

/** Validated configuration. The default of `enabled` is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  intervalHours: z.natural().min(1).max(MAX_INTERVAL_HOURS).default(UPDATE_CHECK_DEFAULTS.intervalHours),
  timeoutSeconds: z.natural().min(1).max(120).default(UPDATE_CHECK_DEFAULTS.timeoutSeconds),
})

/** What the check knows at one moment. */
export interface UpdateCheckState {
  /** When the last check ran, in milliseconds since the epoch; absent before the first. */
  readonly checked?: number
  /** The notice to show, or absent when no newer release is known. */
  readonly notice?: UpdateNotice
}

/** The check `delorun` attaches: it owns the channel, the verification and the record. */
export interface UpdateCheckSource {
  /**
   * What the home holds now, without a request.
   * @returns the last check's time and the notice it supports for the profile as it is installed now.
   */
  read(): Promise<UpdateCheckState>
  /**
   * Run one check and record it; a check that fails is recorded as failed and resolves.
   * @param timeoutMs - how long the check may take in all.
   * @returns the state after it.
   */
  check(timeoutMs: number): Promise<UpdateCheckState>
}

/** The `deloUpdateCheck` service. */
export class UpdateCheckService extends Service {
  private source: UpdateCheckSource | undefined
  /** The interval and the deadline. */
  private readonly config: Config

  /**
   * @param ctx - the plugin context, which owns the schedule's timer.
   * @param config - the interval and the deadline.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'deloUpdateCheck')
    this.config = config
  }

  /**
   * Attach the check and start its schedule: one check at once when the last is at least the interval old, then one
   * each interval. Nothing waits for a check.
   * @param source - the check.
   * @returns the disposer, which stops the schedule and detaches the source; a check in flight finishes unobserved.
   * @throws {Error} when a source is already attached; one Host runs one check.
   */
  attach(source: UpdateCheckSource): () => void {
    if (this.source !== undefined) throw new Error(`${name}: a check is already attached`)
    this.source = source
    const intervalMs = this.config.intervalHours * 3_600_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const schedule = (checked: number | undefined): void => {
      if (stopped) return
      const delay = checked === undefined ? 0 : Math.max(0, checked + intervalMs - Date.now())
      timer = setTimeout(() => { void run(true) }, delay)
      // The schedule never keeps a Host that is otherwise stopping alive.
      timer.unref()
    }
    const run = async (due: boolean): Promise<void> => {
      let checked: number | undefined
      try {
        const state = due ? await source.check(this.config.timeoutSeconds * 1000) : await source.read()
        checked = state.checked
      } catch (error) {
        // The source records its own failures; one that escapes is logged so the schedule keeps its interval.
        this.ctx.logger.warn(`${name}: the update check failed: ${error instanceof Error ? error.message : String(error)}`)
        checked = Date.now()
      }
      schedule(checked)
    }
    void run(false)
    const dispose = (): void => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      this.source = undefined
    }
    return this.ctx.effect(() => dispose, `${name}: the update check's schedule`)
  }

  /**
   * The notice for the profile as it is installed now.
   * @returns the notice, or `undefined` when no check is attached or no newer release is known.
   */
  async notice(): Promise<UpdateNotice | undefined> {
    return (await this.source?.read())?.notice
  }
}

/**
 * With the `update_check` switch on, mount the `deloUpdateCheck` service and serve its notice. Off, mount nothing.
 * @param ctx - the plugin context.
 * @param config - the switch, the interval and the deadline, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const service = new UpdateCheckService(ctx, config)
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: UPDATE_NOTICE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const body: UpdateNoticeResponse = { notice: await service.notice() ?? null }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    }), `${name}: the notice route`)
  })
}
