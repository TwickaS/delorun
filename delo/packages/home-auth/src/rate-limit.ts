/**
 * A per-source attempt limit over a sliding window: C5's "10 owner claim attempts a minute per source", counted without
 * a lockout, because a code carries 128 bits of entropy.
 *
 * The window slides rather than resets on a fixed boundary, so an attacker who spends the limit at the end of one
 * minute gains nothing at the start of the next. The counter lives in memory: it is a bound on work per source, not a
 * record a restart must keep.
 *
 * @module @delo/home-auth/rate-limit
 */

/** What an attempt limiter counts. */
export interface AttemptLimiterOptions {
  /** How many attempts one source may make in one window. */
  readonly limit: number
  /** The window's length, in milliseconds. */
  readonly windowMs: number
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
}

/** A sliding-window count of attempts per source. */
export class AttemptLimiter {
  private readonly now: () => number
  private readonly attempts = new Map<string, number[]>()

  /**
   * @param options - the limit, the window and the clock.
   */
  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Count one attempt from a source.
   * @param source - the source's key, such as the socket peer address.
   * @returns whether the attempt is within the limit; a `false` means the source is over it.
   */
  take(source: string): boolean {
    const at = this.now()
    const since = at - this.options.windowMs
    const recent = (this.attempts.get(source) ?? []).filter(attempt => attempt > since)
    if (recent.length >= this.options.limit) {
      this.attempts.set(source, recent)
      return false
    }
    recent.push(at)
    this.attempts.set(source, recent)
    return true
  }
}
