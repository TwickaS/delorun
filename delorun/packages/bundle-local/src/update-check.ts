/**
 * The `delorun-update-check` row of `@delorun/bundle-local`: when the update check runs and where its notice is served
 * (design `delorun/docs/design/update-notice.md`). The row provides the `delorunUpdateCheck` service, to which `delorun`
 * attaches the check itself once the profile has booted: the row decides when, the CLI decides how. With a source
 * attached, the row checks at once when the last check is at least {@link Config.intervalHours} old; while the Host
 * runs it wakes hourly and checks again once the wall clock shows the interval has passed, or sooner after a failure,
 * and serves the notice to the studio over the Connection Fetch route
 * {@link UPDATE_NOTICE_PATH}.
 *
 * Every registration sits behind the C16 switch `update_check` ({@link Config.enabled}), off by default: off, the
 * plugin provides no service, registers no route and no check runs, which is the parity value, because stock DSH makes
 * no such request.
 *
 * @module @delorun/bundle-local/update-check
 */
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { REACH_DEVICE } from '@delorun/home-auth'
import { readChannelRecord } from '@delorun/install'
import { UPDATE_CHANNEL_PATH, UPDATE_NOTES_PATH, UPDATE_NOTICE_PATH, type UpdateChannelResponse, type UpdateNotesResponse, type UpdateNotice, type UpdateNoticeResponse } from '@delorun/contract-update-report'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** When Delorun's update check runs, and its notice; present while the `delorun-update-check` row is mounted with its switch on. */
    delorunUpdateCheck: UpdateCheckService
  }
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-update-check'

/** The interval and the deadline a row that sets neither runs with. */
export const UPDATE_CHECK_DEFAULTS = { intervalHours: 24, timeoutSeconds: 15 } as const

/** The longest interval, 20 days. */
export const MAX_INTERVAL_HOURS = 480

/** How often a running Host wakes to compare the wall clock with the last check: hourly, never more often. */
export const HOUR_MS = 3_600_000

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `update_check`: whether the row provides the `delorunUpdateCheck` service and serves its notice. Off, the
   * parity value and the default, it mounts nothing and no check runs. Delorun's composition turns it on, and
   * Settings → General → Updates turns it off.
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
  /** Whether the last check failed, which brings the next one forward. */
  readonly failed?: boolean
  /** The notice to show, or absent when no newer release is known. */
  readonly notice?: UpdateNotice
}

/** Verified release notes with the release they belong to. */
export interface UpdateNotes {
  /** The release version. */
  readonly version: UpdateNotice['release']['delorun']
  /** The plain-text notes. */
  readonly text: string
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
  /**
   * The release notes of the notice's release, as the check verified them.
   * @returns the plain-text notes and the release they belong to, or `undefined` when there are none or the stored file no longer matches what was verified.
   */
  notes(): Promise<UpdateNotes | undefined>
}

/** The `delorunUpdateCheck` service. */
export class UpdateCheckService extends Service {
  private source: UpdateCheckSource | undefined
  /** The interval and the deadline. */
  private readonly config: Config

  /**
   * @param ctx - the plugin context, which owns the schedule's timer.
   * @param config - the interval and the deadline.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'delorunUpdateCheck')
    this.config = config
  }

  /**
   * Attach the check and start its schedule: one check at once when the last is at least the interval old; then an
   * hourly wake that checks when the wall clock shows the interval has passed since the last check, or, after a failed
   * check, one hour, two, four and so on up to the interval. Nothing waits for a check.
   * @param source - the check.
   * @returns the disposer, which stops the schedule and detaches the source; a check in flight finishes unobserved.
   * @throws {Error} when a source is already attached; one Host runs one check.
   */
  attach(source: UpdateCheckSource): () => void {
    if (this.source !== undefined) throw new Error(`${name}: a check is already attached`)
    this.source = source
    const intervalMs = this.config.intervalHours * HOUR_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let checked: number | undefined
    let failures = 0
    const note = (state: UpdateCheckState): void => {
      checked = state.checked
      failures = state.failed === true ? failures + 1 : 0
    }
    // The wall clock decides, not the time this process slept through: a machine that slept past the interval checks
    // at its next wake. A failed check is tried again sooner, one hour, then two, four and so on, up to the interval.
    const due = (): boolean => checked === undefined || Date.now() - checked >= (failures === 0 ? intervalMs : Math.min(intervalMs, HOUR_MS * 2 ** (failures - 1)))
    const tick = async (first: boolean): Promise<void> => {
      try {
        if (first) note(await source.read())
        if (!stopped && due()) note(await source.check(this.config.timeoutSeconds * 1000))
      } catch (error) {
        // The source records its own failures; one that escapes is logged and counts as a failed check.
        this.ctx.logger.warn(`${name}: the update check failed: ${error instanceof Error ? error.message : String(error)}`)
        checked = Date.now()
        failures++
      }
      if (stopped) return
      timer = setTimeout(() => { void tick(false) }, HOUR_MS)
      // The schedule never keeps a Host that is otherwise stopping alive.
      timer.unref()
    }
    void tick(true)
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

  /**
   * The verified release notes for the notice's release.
   * @returns the notes with their release, or `undefined` when no check is attached or no verified notes are stored.
   */
  async notes(): Promise<UpdateNotes | undefined> {
    return this.source?.notes()
  }
}

/** Admits a signed-in reach device to the channel route: it names the release host alone, no secret, and changes nothing. */
const admitsReachDevice: NonNullable<ConnectionFetchRoute['admitPeer']> = (_request, peer) => peer.principal.kind === REACH_DEVICE

/**
 * Serve the channel route, then, with the `update_check` switch on, mount the `delorunUpdateCheck` service and serve its notice. Off, mount nothing else.
 * @param ctx - the plugin context.
 * @param config - the switch, the interval and the deadline, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: UPDATE_CHANNEL_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      admitPeer: admitsReachDevice,
      fetch: async () => {
        const home = scope.get('profileContext')?.home
        // A record that cannot be read is reported by `delorun doctor`; the copy then names the production hosts.
        const record = home === undefined ? undefined : await readChannelRecord(home).catch(() => undefined)
        const body: UpdateChannelResponse = { host: record?.channelOrigin === undefined ? null : new URL(record.channelOrigin).host }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    }), `${name}: the channel route`)
  })
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
    scope.effect(() => scope.connection.fetch.register({
      path: UPDATE_NOTES_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const found = await service.notes()
        const body: UpdateNotesResponse = { version: found?.version ?? null, notes: found?.text ?? null }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    }), `${name}: the notes route`)
  })
}
