/**
 * The `delorun-trust` row of `@delorun/bundle-local`: where the studio reads the trust bill ({@link TrustBill}) and asks for
 * a new one. The row provides the `delorunTrust` service, to which `delorun` attaches the bill's source once the profile
 * has booted: the row serves, the CLI decides how a bill is produced. The row asks the source for the start bill once,
 * which the launcher's start check and the stored release-log record make without hashing anything again, and then
 * serves the last bill it holds, so a render never hashes.
 *
 * Two Connection Fetch routes: `GET` {@link TRUST_BILL_PATH} answers `{ bill }`, `null` while no source is attached,
 * and a device the home approved may read it; `POST` {@link TRUST_CHECK_PATH} runs the source's `check`, the `verify`
 * stage, and answers `{ bill }`, and only an owner Peer, the studio on the home's own computer, reaches it, because the
 * route declares no device admission.
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
import { REACH_DEVICE, gateByUnlock } from '@delorun/home-auth'
import { TRUST_BILL_PATH, TRUST_CHECK_PATH, type TrustBill } from './client/trust-bill.ts'

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
}

/** The check's deadline when the row sets none, in seconds. */
export const TRUST_CHECK_TIMEOUT_SECONDS = 600

/** Validated configuration. The default of `enabled` is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  checkTimeoutSeconds: z.natural().min(30).max(3600).default(TRUST_CHECK_TIMEOUT_SECONDS),
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
   * @returns the bill it produced.
   */
  check(timeoutMs: number): Promise<TrustBill>
}

/** The bill route's answer. */
export interface TrustBillResponse {
  /** The last bill, or `null` while no source is attached. */
  readonly bill: TrustBill | null
}

/** The check route's answer on success. */
export interface TrustCheckResponse {
  readonly bill: TrustBill
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
}

/** The `delorunTrust` service. */
export class TrustService extends Service {
  /** The attached source and the bills it produced, or `undefined` while none is attached. */
  private attached: Attachment | undefined

  /** How long one check may run, in milliseconds. */
  private readonly timeoutMs: number

  /**
   * @param ctx - the plugin context.
   * @param config - the check's deadline.
   */
  constructor(ctx: Context, config: Pick<Config, 'checkTimeoutSeconds'>) {
    super(ctx, 'delorunTrust')
    this.timeoutMs = config.checkTimeoutSeconds * 1000
  }

  /**
   * Attach the bill's source. Nothing is read until the studio asks.
   * @param source - the source.
   * @returns the disposer, which detaches the source and drops its bills; a check in flight finishes unobserved.
   * @throws {Error} when a source is already attached; one Host has one bill.
   */
  attach(source: TrustSource): () => void {
    if (this.attached !== undefined) throw new Error(`${name}: a source is already attached`)
    const attached: Attachment = { source, latest: undefined, running: undefined }
    this.attached = attached
    return this.ctx.effect(() => () => {
      if (this.attached === attached) this.attached = undefined
    }, `${name}: the bill's source`)
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
      reading.catch(() => {
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
   * Run the source's check, or join the one in flight, and keep its bill as the last one.
   * @returns the new bill.
   * @throws {TrustError} `TRUST_SOURCE_MISSING` when no source is attached, `TRUST_CHECK_FAILED` when the check fails;
   *   a failed check leaves the last bill in place.
   */
  async check(): Promise<TrustBill> {
    const attached = this.attached
    if (attached === undefined) throw new TrustError('TRUST_SOURCE_MISSING', 'no trust bill source is attached')
    if (attached.running === undefined) {
      const running = attached.source.check(this.timeoutMs)
      attached.running = running
      const settle = (): void => { if (attached.running === running) attached.running = undefined }
      running.then((bill) => {
        settle()
        attached.latest = Promise.resolve(bill)
      }, settle)
    }
    try {
      return await attached.running
    } catch (error) {
      throw new TrustError('TRUST_CHECK_FAILED', `the trust check failed: ${messageOf(error)}`, { cause: error })
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
          return json({ bill: await service.bill() }, 200)
        } catch (error) {
          return failure(error, 'TRUST_READ_FAILED')
        }
      },
    }), `${name}: the bill route`)
    // A check asks the network and spends the person's time, so a device needs an unlock to start one.
    scope.effect(() => scope.connection.fetch.register({
      path: TRUST_CHECK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...gateByUnlock(() => scope.get('homeAuth'), async (request) => {
        // A body-less POST passes Connection's media-type gate; requiring the JSON type keeps a cross-site page, which
        // cannot send it without a preflight, from starting a check.
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return json({ error: 'TRUST_JSON_REQUIRED', message: 'a check request declares an application/json body' }, STATUS.TRUST_JSON_REQUIRED)
        }
        try {
          return json({ bill: await service.check() }, 200)
        } catch (error) {
          return failure(error, 'TRUST_CHECK_FAILED')
        }
      }, { renews: true }),
    }), `${name}: the check route`)
  })
}
