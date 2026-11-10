/**
 * The release-log check as a service of a Delo process: `ctx.releaseVerification` runs contract C18's start check,
 * records its state and the verified checkpoint under the home, and retries the online check every 15 minutes while the
 * release is `unchecked` until it passes or fails (`Behaviour per client`). The retry is an effect of the context, so it
 * stops with the service and no timer outlives a disposed context. A retry whose own work throws, such as a record the
 * home refuses, is logged and the next retry is armed on the same schedule.
 *
 * The service owns no network code and no clock: the caller passes the transport and the time, which keeps every
 * answer a recorded fixture can make in the specs.
 *
 * @module @delo/release-verify/service
 */
import { UNCHECKED_RETRY_INTERVAL_SECONDS } from '@delo/contract-release-log'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { DeloLogger } from '@delo/logs'
import type { StoredCheckpoint } from './checkpoint.ts'
import { checkAndRecord, readCheckpointRecord, readCheckRecords, type CheckInput } from './record.ts'
import { onlineCheckEnabled, type StartCheckResult } from './start.ts'
import type { RecordedCheck } from './state.ts'

/** The timer functions the retry uses; the specs pass their own, so no spec waits 15 minutes. */
export interface RetryTimers {
  /**
   * Run a callback once after a delay.
   * @param callback - the callback.
   * @param milliseconds - the delay.
   * @returns a handle for {@link RetryTimers.clearTimeout}.
   */
  setTimeout(callback: () => void, milliseconds: number): unknown
  /**
   * Cancel a scheduled callback.
   * @param handle - the handle {@link RetryTimers.setTimeout} returned.
   */
  clearTimeout(handle: unknown): void
}

/** What the service needs. */
export interface ReleaseVerificationOptions {
  /** The resolved Delo home, whose `trust/` holds both records. */
  readonly home: string
  /** Where a retry that throws is reported. */
  readonly logger: DeloLogger
  /** The retry's timer functions; the platform's timers by default. */
  readonly timers?: RetryTimers
}

const DEFAULT_TIMERS: RetryTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The release-log check of one Delo process.
 */
export class ReleaseVerification extends Service {
  private readonly options: ReleaseVerificationOptions

  private readonly timers: RetryTimers

  private pending: unknown = undefined

  private lastResult: StartCheckResult | undefined = undefined

  /**
   * @param ctx - the context that owns the service and the retry.
   * @param options - the home, the logger and the timer functions.
   */
  constructor(ctx: Context, options: ReleaseVerificationOptions) {
    super(ctx, 'releaseVerification')
    this.options = options
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.ctx.effect(() => () => this.cancel(), 'release-verify: the unchecked retry')
  }

  /**
   * Run contract C18's start check once, record its state, store a checkpoint that verified, and arm the retry while the
   * release is `unchecked`.
   * @param input - the trusted root, the release, its manifest and bundle, the clock, the transport and the mode.
   * @returns the state, the warning, whether the start stops, and the checkpoint that was stored.
   */
  async start(input: CheckInput): Promise<StartCheckResult> {
    const result = await checkAndRecord(this.options.home, input)
    this.lastResult = result
    this.arm(input, result)
    return result
  }

  /**
   * The state last recorded for a release, read from the record on disk without checking anything: what a display shows
   * as "last recorded", with the record's `lastAttempt` as its time.
   * @param version - the release's version.
   * @returns the record, or `undefined` when the record holds none for that release.
   */
  async lastRecorded(version: string): Promise<RecordedCheck | undefined> {
    return (await readCheckRecords(this.options.home)).get(version)
  }

  /**
   * The verified checkpoint the client stored, when it holds a signed record that reads.
   * @returns the record, or `undefined` when the file is absent or does not read.
   */
  async storedCheckpoint(): Promise<StoredCheckpoint | undefined> {
    return readCheckpointRecord(this.options.home)
  }

  /**
   * Cancel the pending retry, as the context's disposal does.
   * @returns nothing.
   */
  cancel(): void {
    if (this.pending !== undefined) {
      this.timers.clearTimeout(this.pending)
      this.pending = undefined
    }
  }

  /**
   * The result of the last check this process ran.
   * @returns the result, or `undefined` before the first check.
   */
  get lastStartResult(): StartCheckResult | undefined {
    return this.lastResult
  }

  /**
   * Arm the retry while the release is `unchecked` with a transport and the online check enabled, and cancel it
   * otherwise.
   * @param input - the input of the check that just ran.
   * @param result - its result, or `undefined` when the attempt threw, which keeps the schedule.
   * @returns nothing.
   */
  private arm(input: CheckInput, result: StartCheckResult | undefined): void {
    this.cancel()
    if (result !== undefined && (result.state !== 'unchecked' || !onlineCheckEnabled(input.mode) || input.transport === undefined)) return
    this.pending = this.timers.setTimeout(() => {
      this.pending = undefined
      void this.retryOnce(input)
    }, UNCHECKED_RETRY_INTERVAL_SECONDS * 1000)
  }

  /**
   * Re-run the check after a retry's interval, and keep retrying while the release stays `unchecked` or the attempt
   * throws.
   * @param input - the input of the last check.
   * @returns when the attempt and the next arming are done.
   */
  private async retryOnce(input: CheckInput): Promise<void> {
    let result: StartCheckResult | undefined
    try {
      result = await checkAndRecord(this.options.home, input)
      this.lastResult = result
    } catch (error) {
      this.options.logger.error('the release-log check retry failed; the next retry runs on schedule', { err: error })
    }
    this.arm(input, result)
  }
}
