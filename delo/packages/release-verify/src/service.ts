/**
 * The release-log check as a service of a Delo process: `ctx.releaseVerification` runs contract C18's start check,
 * records its state and the verified checkpoint under the home, and retries the online check every 15 minutes while the
 * release is `unchecked` until it passes or fails (`Behaviour per client`). The retry is an effect of the context, so it
 * stops with the service and no timer outlives a disposed context.
 *
 * The service owns no network code and no clock: the caller passes the transport and the time, which keeps every
 * answer a recorded fixture can make in the specs, and the launcher's real transport behind C18's owner gate.
 *
 * @module @delo/release-verify/service
 */
import { UNCHECKED_RETRY_INTERVAL_SECONDS } from '@delo/contract-release-log'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { advanceCheckpoint, readStoredCheckpoint, serializeStoredCheckpoint, type StoredCheckpoint } from './checkpoint.ts'
import { ReleaseLogRefusalError } from './errors.ts'
import { checkStatePath, checkpointPath } from './paths.ts'
import { checkAtStart, onlineCheckEnabled, type StartCheckInput, type StartCheckResult } from './start.ts'
import { readCheckState, recorded, serializeCheckState, type RecordedCheck } from './state.ts'
import { readProtectedFile, writeProtectedFile } from './store.ts'

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

  private last: StartCheckInput | undefined = undefined

  private lastResult: StartCheckResult | undefined = undefined

  /**
   * @param ctx - the context that owns the service and the retry.
   * @param options - the home and the timer functions.
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
   * @param input - the trusted root, the release, its manifest and bundle, the stored checkpoint, the clock, the transport
   * and the verification mode.
   * @returns the state, the warning, whether the start stops, and the checkpoint that was stored.
   */
  async start(input: StartCheckInput): Promise<StartCheckResult> {
    const stored = input.stored ?? await this.storedCheckpoint()
    const result = await this.attempt({ ...input, stored })
    this.last = { ...input, stored }
    this.lastResult = result
    this.arm(result.state === 'unchecked' && onlineCheckEnabled(input.mode) && input.transport !== undefined)
    return result
  }

  /**
   * The state recorded for a release by this process's last check, read from the record.
   * @param version - the release's version.
   * @returns the record, or `undefined` when the record holds none for that release.
   */
  async record(version: string): Promise<RecordedCheck | undefined> {
    return (await this.state()).get(version)
  }

  /**
   * The verified checkpoint the client stored, when it holds one that reads.
   * @returns the record, or `undefined` when the file is absent or does not read.
   */
  async storedCheckpoint(): Promise<StoredCheckpoint | undefined> {
    const bytes = await readProtectedFile(checkpointPath(this.options.home))
    if (bytes === undefined) return undefined
    try {
      return readStoredCheckpoint(bytes)
    } catch (error) {
      // A record this client cannot read is no record: the check starts from the bundle's own checkpoint, which is a
      // weaker guarantee, so it is not counted as the client's verified tree.
      if (error instanceof ReleaseLogRefusalError) return undefined
      throw error
    }
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
   * Run one check and persist its result.
   * @param input - the check's input, with the stored checkpoint resolved.
   * @returns the result.
   */
  private async attempt(input: StartCheckInput): Promise<StartCheckResult> {
    const result = await checkAtStart(input)
    const state = await this.state()
    state.set(input.version, recorded(input.version, result.state, input.now, result.refusal, result.detail))
    await writeProtectedFile(checkStatePath(this.options.home), serializeCheckState(state))
    if (result.checkpoint !== undefined) {
      const kept = advanceCheckpoint(input.stored, result.checkpoint)
      await writeProtectedFile(checkpointPath(this.options.home), serializeStoredCheckpoint(kept))
    }
    return result
  }

  /**
   * Arm or cancel the retry.
   * @param wanted - whether a release is `unchecked` with a transport and the online check enabled.
   * @returns nothing.
   */
  private arm(wanted: boolean): void {
    this.cancel()
    if (!wanted) return
    this.pending = this.timers.setTimeout(() => {
      this.pending = undefined
      const last = this.last
      if (last === undefined) return
      void this.retryOnce(last)
    }, UNCHECKED_RETRY_INTERVAL_SECONDS * 1000)
  }

  /**
   * Re-run the check after a retry's interval, and keep retrying while the release stays `unchecked`.
   * @param input - the input of the last check.
   * @returns the result of this attempt.
   */
  private async retryOnce(input: StartCheckInput): Promise<StartCheckResult> {
    const stored = await this.storedCheckpoint() ?? input.stored
    const result = await this.attempt({ ...input, stored })
    this.last = { ...input, stored }
    this.lastResult = result
    this.arm(result.state === 'unchecked' && onlineCheckEnabled(input.mode) && input.transport !== undefined)
    return result
  }

  /**
   * The recorded states, read from the home.
   * @returns one entry per release; empty when the record is absent or does not read.
   */
  private async state(): Promise<Map<string, RecordedCheck>> {
    const bytes = await readProtectedFile(checkStatePath(this.options.home))
    if (bytes === undefined) return new Map()
    try {
      return readCheckState(bytes)
    } catch (error) {
      if (error instanceof ReleaseLogRefusalError) return new Map()
      throw error
    }
  }
}
