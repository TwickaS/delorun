/**
 * The trust badge's data half: the bill and the rows' freshness the `delorun-trust` row answers on
 * {@link TRUST_BILL_PATH}, validated, and the check it runs on {@link TRUST_CHECK_PATH}. The studio reads them when it
 * starts, on each new connection generation, when the window regains focus or becomes visible, and on a timer: every
 * {@link TRUST_POLL_RUNNING_MS} while a check runs, every {@link TRUST_POLL_WAITING_MS} while the background full check
 * waits, and every {@link TRUST_POLL_IDLE_MS} otherwise, so the rows' "Checking…" and "Checked … ago" stay current. A
 * read never hashes. A 404 (the row is off), a failed request and an answer that does not validate all read as no bill,
 * which the badge shows as unknown.
 * @module @delorun/bundle-local/client/trust-api
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'
import type { HostFetch } from './devices-api.ts'
import { TRUST_BILL_PATH, TRUST_CHECK_PATH, type TrustBill, type TrustChecks } from './trust-bill.ts'
import { TrustBillSchema, TrustChecksSchema } from './trust-schema.ts'

export { TrustBillSchema, TrustChecksSchema } from './trust-schema.ts'

/**
 * The bill route's answer: the bill, or `null` while the Host has no source attached, and the rows' freshness, absent
 * from a Host that keeps none.
 */
export const TrustBillResponseSchema = z.object({ bill: TrustBillSchema.nullable(), checks: TrustChecksSchema.nullable().optional() })

/** The check route's answer on success. */
export const TrustCheckResponseSchema = z.object({ bill: TrustBillSchema, checks: TrustChecksSchema.nullable().optional() })

/** How often the studio reads again while a check runs, in milliseconds. */
export const TRUST_POLL_RUNNING_MS = 3_000

/** How often the studio reads again while the background full check waits for idle, in milliseconds. */
export const TRUST_POLL_WAITING_MS = 15_000

/** How often the studio reads again otherwise, in milliseconds. */
export const TRUST_POLL_IDLE_MS = 60_000

/** One read: the bill and how fresh each row is, each `null` when unknown. */
export interface TrustSnapshot {
  readonly bill: TrustBill | null
  readonly checks: TrustChecks | null
}

/** The snapshot of a Host with nothing to show. */
const NO_SNAPSHOT: TrustSnapshot = { bill: null, checks: null }

/**
 * Read the bill from the Host, document-relative as the studio's other routes.
 * @param fetch - the page's fetch.
 * @param signal - aborts the read.
 * @returns the bill, or `null` for none, a non-2xx answer, a failed request or an answer that does not validate.
 */
export async function fetchTrustBill(fetch: HostFetch, signal: AbortSignal): Promise<TrustBill | null> {
  return (await fetchTrustSnapshot(fetch, signal)).bill
}

/**
 * Read the bill and the rows' freshness from the Host.
 * @param fetch - the page's fetch.
 * @param signal - aborts the read.
 * @returns both, each `null` for none, a non-2xx answer, a failed request or an answer that does not validate.
 */
export async function fetchTrustSnapshot(fetch: HostFetch, signal: AbortSignal): Promise<TrustSnapshot> {
  try {
    const response = await fetch(TRUST_BILL_PATH.slice(1), { headers: { accept: 'application/json' }, signal })
    if (!response.ok) return NO_SNAPSHOT
    const parsed = TrustBillResponseSchema.safeParse(await response.json())
    return parsed.success ? { bill: parsed.data.bill, checks: parsed.data.bill === null ? null : parsed.data.checks ?? null } : NO_SNAPSHOT
  } catch (_error) {
    // A failed request or a body that is not JSON is no bill; the next read tries again.
    return NO_SNAPSHOT
  }
}

/**
 * How a check ended: the new bill, `refused` when the Host answered 403 because this page is not on the home's own
 * computer, or `failed` for any other failure, an answer that does not validate included.
 */
export type TrustCheckOutcome =
  | { readonly kind: 'checked'; readonly bill: TrustBill; readonly checks: TrustChecks | null }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed' }

/**
 * Ask the Host to run the `verify` stage.
 * @param fetch - the page's fetch.
 * @returns how the check ended.
 */
export async function postTrustCheck(fetch: HostFetch): Promise<TrustCheckOutcome> {
  try {
    const response = await fetch(TRUST_CHECK_PATH.slice(1), {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: '{}',
    })
    if (response.status === 403) return { kind: 'refused' }
    if (!response.ok) return { kind: 'failed' }
    const parsed = TrustCheckResponseSchema.safeParse(await response.json())
    return parsed.success ? { kind: 'checked', bill: parsed.data.bill, checks: parsed.data.checks ?? null } : { kind: 'failed' }
  } catch (_error) {
    // The request failed or the body is not JSON: the check's outcome is unknown, which the panel reports as failed.
    return { kind: 'failed' }
  }
}

/** The state of Check now: idle, running, or how the last run failed. */
export type TrustCheckState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'failed'; readonly reason: 'refused' | 'failed' }

/** What the store reads from and writes to the Host. */
export interface TrustApi {
  /**
   * Read the bill and the rows' freshness.
   * @param signal - aborts the read.
   * @returns both, each `null` for none.
   */
  read(signal: AbortSignal): Promise<TrustSnapshot>
  /**
   * Run the check.
   * @returns how it ended.
   */
  check(): Promise<TrustCheckOutcome>
}

/**
 * The page's API over a fetch.
 * @param fetch - the page's fetch.
 * @returns the API.
 */
export function trustApi(fetch: HostFetch): TrustApi {
  return { read: signal => fetchTrustSnapshot(fetch, signal), check: () => postTrustCheck(fetch) }
}

/**
 * How long until the next timed read.
 * @param checks - the rows' freshness the Host last answered.
 * @returns {@link TRUST_POLL_RUNNING_MS} while a check runs, {@link TRUST_POLL_WAITING_MS} while the background full
 *   check waits, {@link TRUST_POLL_IDLE_MS} otherwise.
 */
export function trustPollDelay(checks: TrustChecks | null): number {
  if (checks === null) return TRUST_POLL_IDLE_MS
  if ([checks.release, checks.releaseLog, checks.plugins, checks.changes].some(row => row.running)) return TRUST_POLL_RUNNING_MS
  return checks.release.full.state === 'waiting' ? TRUST_POLL_WAITING_MS : TRUST_POLL_IDLE_MS
}

/** The bill the Host last answered, how fresh each row is, and the state of Check now. */
export class TrustStore {
  /** The last bill, or `null` while none could be read. */
  readonly bill = createSnapshotStore<TrustBill | null>(null)
  /** How fresh each row is, or `null` while the Host reports none. */
  readonly checks = createSnapshotStore<TrustChecks | null>(null)
  /** The state of Check now. */
  readonly checking = createSnapshotStore<TrustCheckState>({ kind: 'idle' })

  /** Numbers each read, so only the latest read's answer is kept and a check's bill is never replaced by an older read. */
  #reads = 0
  /** Sets the next timed read again, while {@link start}'s reads run. */
  #reschedule: (() => void) | undefined
  /** The Host's routes. */
  private readonly api: TrustApi

  /**
   * @param api - the Host's routes.
   */
  constructor(api: TrustApi) {
    this.api = api
  }

  /**
   * Run the check unless one is running; its bill replaces the shown one, and a failure keeps the shown bill.
   * @returns once the check ended.
   */
  async check(): Promise<void> {
    if (this.checking.getSnapshot().kind === 'running') return
    this.checking.set({ kind: 'running', startedAt: Date.now() })
    const outcome = await this.api.check()
    if (outcome.kind === 'checked') {
      this.#reads++
      this.bill.set(outcome.bill)
      this.checks.set(outcome.checks)
      this.#reschedule?.()
      this.checking.set({ kind: 'idle' })
    } else {
      this.checking.set({ kind: 'failed', reason: outcome.kind })
    }
  }

  /**
   * Read the bill now, then on each reset, focus, return to visibility and timed read ({@link trustPollDelay}) until the
   * disposer runs.
   * @param onReset - subscribes to new connection generations.
   * @returns the disposer that stops reading and drops every listener.
   */
  start(onReset: (listener: () => void) => () => void): () => void {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = lifetime.signal.aborted ? undefined : setTimeout(refresh, trustPollDelay(this.checks.getSnapshot()))
    }
    const refresh = (): void => {
      const number = ++this.#reads
      void this.api.read(lifetime.signal).then(({ bill, checks }) => {
        if (lifetime.signal.aborted || number !== this.#reads) return
        this.bill.set(bill)
        this.checks.set(checks)
        schedule()
      })
    }
    const visible = (): void => { if (document.visibilityState === 'visible') refresh() }
    this.#reschedule = schedule
    refresh()
    const stopReset = onReset(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      lifetime.abort()
      if (timer !== undefined) clearTimeout(timer)
      if (this.#reschedule === schedule) this.#reschedule = undefined
      stopReset()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }
}
