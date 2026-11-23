/**
 * The `delorun-trust` row of `@delorun/bundle-local`: where the studio reads the trust bill ({@link TrustBill}) and asks for
 * a new one. The row provides the `delorunTrust` service, to which `delorun` attaches the bill's source once the profile
 * has booted: the row serves, the CLI decides how a bill is produced. On attach the row reads the start bill, which the
 * launcher's start check and the stored release-log record make without hashing anything again, and then serves the
 * last bill it holds, so a render never hashes.
 *
 * The row also runs the checks by itself ({@link TrustSchedule}, A628): once the studio has started and no turn has run
 * for {@link Config.idleSeconds}, the background full check, the same launcher path Check now takes, at low priority,
 * which a starting turn stops; and after a key moment (`loader/volatile-update`: a plugin added, updated, switched on or
 * off or removed, or the person's changes loaded) a re-read of the plugins and changes sections, debounced by
 * {@link Config.keyMomentSeconds}. It keeps how fresh each row is ({@link TrustChecks}) and serves it beside the bill.
 *
 * Two Connection Fetch routes: `GET` {@link TRUST_BILL_PATH} answers `{ bill, checks }`, both `null` while no source is
 * attached, and a device the home approved may read it; `POST` {@link TRUST_CHECK_PATH} runs the source's `check`, the
 * `verify` stage, or joins the background one, and answers `{ bill, checks }`.
 *
 * Every registration sits behind {@link Config.enabled}, off by default: off, the plugin provides no service and
 * registers no route, which is the parity value, because stock DSH has no such route.
 *
 * @module @delorun/bundle-local/trust
 */
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and the Peer's type.
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { REACH_DEVICE, admitApprovedDevice } from '@delorun/home-auth'
// Type-only: the `agent/status` and `agent/disposed` events.
import type {} from '@deepseek-ai/dsh-agent'
import {
  TRUST_BILL_PATH, TRUST_CHECK_PATH,
  type TrustBill, type TrustChecks, type TrustFullCheck,
} from './client/trust-bill.ts'
import { TrustSchedule } from './trust-schedule.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The trust bill the studio shows; present while the `delorun-trust` row is mounted with its switch on. */
    delorunTrust: TrustService
  }
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-trust'

/** The plugin's configuration. */
export interface Config {
  /**
   * Whether the row provides the `delorunTrust` service and serves the bill. Off, the parity value and the default, it
   * mounts nothing. Delorun's composition turns it on.
   */
  readonly enabled: boolean
  /**
   * How long one Check now may run, in seconds, before it is stopped and reported as not finished: it hashes every
   * runtime file twice and runs the online release-log check.
   */
  readonly checkTimeoutSeconds: number
  /**
   * Whether the row runs the full check by itself once the studio has started and is idle. Off, the release stays
   * checked at start until the person presses Check now.
   */
  readonly autoCheck: boolean
  /** How long no turn may have run before the background full check starts, in seconds. */
  readonly idleSeconds: number
  /** How long after the last key moment the plugins and changes sections are read again, in seconds. */
  readonly keyMomentSeconds: number
}

/** The check's deadline when the row sets none, in seconds. */
export const TRUST_CHECK_TIMEOUT_SECONDS = 600

/** How long the studio must be idle before the background full check, when the row sets none, in seconds. */
export const TRUST_IDLE_SECONDS = 45

/** The key moments' debounce when the row sets none, in seconds. */
export const TRUST_KEY_MOMENT_SECONDS = 60

/** Validated configuration. The default of `enabled` is the parity value. */
export const Config: z<Partial<Config>, Config> = z.object({
  enabled: z.boolean().default(false),
  checkTimeoutSeconds: z.natural().min(30).max(3600).default(TRUST_CHECK_TIMEOUT_SECONDS),
  autoCheck: z.boolean().default(true),
  idleSeconds: z.natural().min(5).max(3600).default(TRUST_IDLE_SECONDS),
  keyMomentSeconds: z.natural().min(60).max(600).default(TRUST_KEY_MOMENT_SECONDS),
})

/** What `delorun` attaches: it owns how a bill is produced. */
export interface TrustSource {
  /**
   * The start bill: from the launcher's start check and the stored release-log record, with no hashing and no request.
   * @returns the bill.
   */
  read(): Promise<TrustBill>
  /**
   * Run the `verify` stage: hash every runtime file and run the online release-log check.
   * @param timeoutMs - how long the check may run before it is stopped.
   * @param options - for the background check: low priority, and the signal that stops it.
   * @returns the bill it produced.
   */
  check(timeoutMs: number, options?: TrustCheckOptions): Promise<TrustBill>
  /**
   * A new start bill, read again rather than answered from the first read: its plugins, changes, patches, skills and
   * MCP sections are current, and it hashes no runtime file and makes no request.
   * @returns the bill.
   */
  refresh(): Promise<TrustBill>
}

/** How the background check runs. */
export interface TrustCheckOptions {
  /** Run at low priority: `nice` 10, which on Linux also lowers the I/O priority, and below normal on Windows. */
  readonly lowPriority?: boolean
  /** Stops the check: its process is ended and the call rejects. */
  readonly signal?: AbortSignal
}

/** The bill route's answer. */
export interface TrustBillResponse {
  /** The last bill, or `null` while no source is attached. */
  readonly bill: TrustBill | null
  /** How fresh each row is, or `null` while no source is attached. */
  readonly checks: TrustChecks | null
}

/** The check route's answer on success. */
export interface TrustCheckResponse {
  readonly bill: TrustBill
  /** How fresh each row is; `null` when the source was detached while the check ran. */
  readonly checks: TrustChecks | null
}

/**
 * Why a route answered with an error: `TRUST_SOURCE_MISSING` (503) when no source is attached,
 * `TRUST_READ_FAILED` (500) when the start bill did not read, `TRUST_CHECK_FAILED` (500) when the check did not run to
 * a bill, `TRUST_JSON_REQUIRED` (415) when a check request does not declare a JSON body.
 */
export type TrustErrorCode = 'TRUST_SOURCE_MISSING' | 'TRUST_READ_FAILED' | 'TRUST_CHECK_FAILED' | 'TRUST_JSON_REQUIRED'

/** A route's error answer. */
export interface TrustErrorResponse {
  readonly error: TrustErrorCode
  /** One line for the log reader; the studio words the failure through its own dictionaries. */
  readonly message: string
}

/** A failure the service reports with its code. */
export class TrustError extends Error {
  /** The route's code. */
  readonly code: TrustErrorCode

  /**
   * @param code - the route's code.
   * @param message - one line naming what failed.
   * @param options - the cause.
   */
  constructor(code: TrustErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TrustError'
    this.code = code
  }
}

/** The status each code answers with. */
const STATUS: Readonly<Record<TrustErrorCode, number>> = {
  TRUST_SOURCE_MISSING: 503,
  TRUST_READ_FAILED: 500,
  TRUST_CHECK_FAILED: 500,
  TRUST_JSON_REQUIRED: 415,
}

/**
 * The message of a thrown value.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A JSON answer that no cache keeps.
 * @param body - the answer.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(body: TrustBillResponse | TrustCheckResponse | TrustErrorResponse, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/** One attached source and the bills it produced. */
interface Attachment {
  readonly source: TrustSource
  /** The last bill: the start bill until a check completes, then that check's. */
  latest: Promise<TrustBill> | undefined
  /** The check in flight, which every concurrent request shares. */
  running: Promise<TrustBill> | undefined
  /** The background full check. */
  full: TrustFullCheck
  /** When a full check through the launcher last produced the bill, RFC 3339 UTC. */
  fullAt: string | null
  /** When the plugins and changes sections were last read, RFC 3339 UTC. */
  sectionsAt: string | null
  /** Whether a re-read of the plugins and changes sections runs. */
  refreshing: boolean
  /** The schedule of the background checks. */
  readonly schedule: TrustSchedule
  /** Whether the schedule started, which it does once, after the first start bill that read. */
  started: boolean
}

/** What the service needs beyond its context. */
export type TrustServiceConfig = Pick<Config, 'checkTimeoutSeconds' | 'autoCheck' | 'idleSeconds' | 'keyMomentSeconds'>

/** The `delorunTrust` service. */
export class TrustService extends Service {
  /** The attached source and the bills it produced, or `undefined` while none is attached. */
  private attached: Attachment | undefined

  /** How long one check may run, in milliseconds. */
  private readonly timeoutMs: number

  /** The schedule's settings. */
  private readonly settings: TrustServiceConfig

  /** The agents whose turn runs now, kept while no source is attached so an attach starts with the right state. */
  private readonly turns = new Set<unknown>()

  /**
   * @param ctx - the plugin context.
   * @param config - the check's deadline and the schedule's settings.
   */
  constructor(ctx: Context, config: TrustServiceConfig) {
    super(ctx, 'delorunTrust')
    this.timeoutMs = config.checkTimeoutSeconds * 1000
    this.settings = config
  }

  /**
   * Attach the bill's source, which `delorun` does once the studio has started: the row reads the start bill and, when
   * the release's files were not all hashed at start and the launcher can run the check, schedules the background full
   * check.
   * @param source - the source.
   * @returns the disposer, which detaches the source, stops the schedule and drops its bills; a check in flight finishes
   *   unobserved, and the background one is stopped.
   * @throws {Error} when a source is already attached; one Host has one bill.
   */
  attach(source: TrustSource): () => void {
    if (this.attached !== undefined) throw new Error(`${name}: a source is already attached`)
    const schedule = new TrustSchedule({
      full: signal => this.runBackground(attached, signal),
      refresh: () => this.refreshSections(attached),
    }, { idleMs: this.settings.idleSeconds * 1000, debounceMs: this.settings.keyMomentSeconds * 1000 })
    const attached: Attachment = {
      source, latest: undefined, running: undefined, full: { state: 'waiting' }, fullAt: null, sectionsAt: null, refreshing: false, schedule, started: false,
    }
    this.attached = attached
    for (const agent of this.turns) schedule.turn(agent, true)
    // A start bill that does not read leaves the schedule to the first read that succeeds, from the studio's next poll.
    void this.bill().catch((error: unknown) => {
      if (this.attached === attached && !attached.started) attached.full = { state: 'unavailable', reason: 'failed', detail: messageOf(error) }
    })
    return this.ctx.effect(() => () => {
      schedule.close()
      if (this.attached === attached) this.attached = undefined
    }, `${name}: the bill's source`)
  }

  /**
   * Start the schedule after the first start bill that read: the background full check waits for idle when that bill
   * needs one.
   * @param attached - the attachment.
   * @param bill - the start bill.
   */
  private begin(attached: Attachment, bill: TrustBill): void {
    if (attached.started || this.attached !== attached) return
    attached.started = true
    attached.full = this.firstFull(bill)
    attached.schedule.start(attached.full.state === 'waiting')
  }

  /**
   * The background full check's state once the start bill read: `done` when the start check hashed every file;
   * `unavailable` when the row's switch is off, or the check would run inside the Host because no launcher can run it;
   * `waiting` otherwise.
   * @param bill - the start bill.
   * @returns the state.
   */
  private firstFull(bill: TrustBill): TrustFullCheck {
    if (bill.release.startCheck?.full === true) return { state: 'done' }
    if (!this.settings.autoCheck) return { state: 'unavailable', reason: 'off' }
    const route = bill.checkNow ?? { via: 'host', reason: 'no-launcher' }
    return route.via === 'launcher' ? { state: 'waiting' } : { state: 'unavailable', reason: route.reason }
  }

  /**
   * An agent's turn started or ended: the schedule waits for idle and stops the background check while one runs.
   * @param agent - the agent.
   * @param running - whether its turn runs now.
   */
  turn(agent: unknown, running: boolean): void {
    if (running) this.turns.add(agent)
    else this.turns.delete(agent)
    this.attached?.schedule.turn(agent, running)
  }

  /**
   * A key moment: the plugins and changes sections are read again, debounced, once no turn runs; `release` asks for
   * another background full check, which waits for idle.
   * @param moment - what changed.
   */
  keyMoment(moment: 'plugins' | 'changes' | 'release'): void {
    const attached = this.attached
    if (attached === undefined) return
    if (moment === 'release') {
      if (attached.full.state === 'unavailable' && attached.full.reason !== 'failed') return
      attached.full = { state: 'waiting' }
    }
    attached.schedule.keyMoment(moment)
  }

  /**
   * The last bill, read from the source's start bill on the first call; a read that failed is tried again next time.
   * @returns the bill, or `null` while no source is attached.
   * @throws {TrustError} `TRUST_READ_FAILED` when the start bill does not read.
   */
  async bill(): Promise<TrustBill | null> {
    const attached = this.attached
    if (attached === undefined) return null
    if (attached.latest === undefined) {
      const reading = attached.source.read()
      attached.latest = reading
      reading.then((bill) => {
        attached.sectionsAt ??= new Date().toISOString()
        this.begin(attached, bill)
      }, () => {
        // The failure is answered to this caller below; the next caller reads again.
        if (attached.latest === reading) attached.latest = undefined
      })
    }
    try {
      return await attached.latest
    } catch (error) {
      throw new TrustError('TRUST_READ_FAILED', `the trust bill did not read: ${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * How fresh each row is, from the last bill and the schedule.
   * @param bill - the last bill.
   * @returns the rows' freshness, or `null` while no source is attached.
   */
  checks(bill: TrustBill | null): TrustChecks | null {
    const attached = this.attached
    if (attached === undefined || bill === null) return null
    const checking = attached.running !== undefined
    const releaseAt = bill.stage === 'verify' ? attached.fullAt ?? bill.generatedAt : bill.release.startCheck?.at ?? null
    const sections = { at: attached.sectionsAt, running: checking || attached.refreshing }
    return {
      release: { at: releaseAt, running: checking, full: attached.full },
      releaseLog: { at: bill.releaseLog.lastAttempt, running: checking },
      plugins: sections,
      changes: sections,
    }
  }

  /**
   * Run the source's check, or join the one in flight, and keep its bill as the last one. Joining the background check
   * makes it the person's: no turn stops it.
   * @returns the new bill.
   * @throws {TrustError} `TRUST_SOURCE_MISSING` when no source is attached, `TRUST_CHECK_FAILED` when the check fails;
   *   a failed check leaves the last bill in place.
   */
  async check(): Promise<TrustBill> {
    const attached = this.attached
    if (attached === undefined) throw new TrustError('TRUST_SOURCE_MISSING', 'no trust bill source is attached')
    attached.schedule.hold()
    try {
      return await (attached.running ?? this.start(attached, {}))
    } catch (error) {
      throw new TrustError('TRUST_CHECK_FAILED', `the trust check failed: ${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * Start a check and keep its bill as the last one when it completes.
   * @param attached - the attachment.
   * @param options - the background check's priority and signal.
   * @returns the check.
   */
  private start(attached: Attachment, options: TrustCheckOptions): Promise<TrustBill> {
    const running = attached.source.check(this.timeoutMs, options)
    attached.running = running
    const settle = (): void => { if (attached.running === running) attached.running = undefined }
    running.then((bill) => {
      settle()
      attached.latest = Promise.resolve(bill)
      const now = new Date().toISOString()
      attached.sectionsAt = now
      if (bill.checkedBy?.via !== 'host') {
        attached.fullAt = now
        attached.full = { state: 'done' }
      }
      // A check that finished before any start bill read starts the schedule itself, with no full check to wait for.
      if (!attached.started && this.attached === attached) {
        attached.started = true
        if (bill.checkedBy?.via === 'host') attached.full = { state: 'unavailable', reason: bill.checkedBy.reason }
        attached.schedule.start(false)
      }
    }, settle)
    return running
  }

  /**
   * The background full check: through the launcher at low priority, stopped when a turn starts. A stopped run waits
   * for the next idle stretch; a failed one leaves the last bill and says why.
   * @param attached - the attachment.
   * @param signal - stops the run.
   * @returns once the run ended.
   */
  private async runBackground(attached: Attachment, signal: AbortSignal): Promise<void> {
    if (attached.running !== undefined) {
      await attached.running.catch(() => undefined)
      return
    }
    attached.full = { state: 'running' }
    try {
      await this.start(attached, { lowPriority: true, signal })
    } catch (error) {
      if (this.attached !== attached) return
      attached.full = signal.aborted ? { state: 'waiting' } : { state: 'unavailable', reason: 'failed', detail: messageOf(error) }
      if (!signal.aborted) this.ctx.logger.warn(`${name}: the background full check did not finish: ${messageOf(error)}`)
    }
  }

  /**
   * Read the plugins, changes, patches, skills and MCP sections again into the last bill.
   * @param attached - the attachment.
   * @returns once the re-read ended; a failed one leaves the last bill.
   */
  private async refreshSections(attached: Attachment): Promise<void> {
    // A check in flight reads these sections too, and its bill replaces the last one: the re-read is not needed.
    if (attached.running !== undefined) {
      await attached.running.catch(() => undefined)
      return
    }
    attached.refreshing = true
    const before = attached.latest
    try {
      const [fresh, last] = await Promise.all([attached.source.refresh(), before])
      // A check that started or finished meanwhile holds the newer bill; the re-read must not overwrite it.
      if (this.attached !== attached || attached.running !== undefined || attached.latest !== before) return
      const base = last ?? fresh
      attached.latest = Promise.resolve({ ...base, plugins: fresh.plugins, changes: fresh.changes, patches: fresh.patches, skills: fresh.skills, mcp: fresh.mcp })
      attached.sectionsAt = new Date().toISOString()
    } catch (error) {
      this.ctx.logger.warn(`${name}: the plugins and changes did not read again: ${messageOf(error)}`)
    } finally {
      attached.refreshing = false
    }
  }
}

/**
 * Whether a Peer other than the owner may read the bill: a device the home approved, over a reach listener, reading.
 * @param request - the request.
 * @param peer - the Peer.
 * @returns true for a `GET` from a reach device.
 */
export function admitsBillReader(request: Request, peer: PeerScope): boolean {
  return request.method === 'GET' && peer.principal.kind === REACH_DEVICE
}

/**
 * With the switch on, mount the `delorunTrust` service and serve the bill and the check. Off, mount nothing.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const service = new TrustService(ctx, config)
  ctx.on('agent/status', ({ agent, status }) => { service.turn(agent, status === 'running') })
  ctx.on('agent/disposed', ({ agent }) => { service.turn(agent, false) })
  ctx.on('loader/volatile-update', () => { service.keyMoment('plugins') })
  const failure = (error: unknown, fallback: TrustErrorCode): Response => {
    const code = error instanceof TrustError ? error.code : fallback
    const message = messageOf(error)
    ctx.logger.warn(`${name}: ${message}`)
    return json({ error: code, message }, STATUS[code])
  }
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: TRUST_BILL_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      admitPeer: admitsBillReader,
      fetch: async () => {
        try {
          const bill = await service.bill()
          return json({ bill, checks: service.checks(bill) }, 200)
        } catch (error) {
          return failure(error, 'TRUST_READ_FAILED')
        }
      },
    }), `${name}: the bill route`)
    // A check only reads and asks the network, bounded by the service, so any approved device may start one (class `free`).
    scope.effect(() => scope.connection.fetch.register({
      path: TRUST_CHECK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      admitPeer: admitApprovedDevice(),
      fetch: async (request) => {
        // A body-less POST passes Connection's media-type gate; requiring the JSON type keeps a cross-site page, which
        // cannot send it without a preflight, from starting a check.
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return json({ error: 'TRUST_JSON_REQUIRED', message: 'a check request declares an application/json body' }, STATUS.TRUST_JSON_REQUIRED)
        }
        try {
          const bill = await service.check()
          return json({ bill, checks: service.checks(bill) }, 200)
        } catch (error) {
          return failure(error, 'TRUST_CHECK_FAILED')
        }
      },
    }), `${name}: the check route`)
  })
}
