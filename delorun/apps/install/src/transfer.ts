/**
 * How a download's size, speed and time left read, and how the speed is measured: the one source the terminal's
 * install display (`./render.ts`) and the studio's download rows share. It imports nothing, so a browser bundle may
 * import it.
 *
 * @module @delorun/install/transfer
 */

/** Bytes arrive over this long a window when the speed and the time left are worked out. */
export const SPEED_WINDOW_MS = 5000
/** The least span of samples that gives a speed. */
export const SPEED_MIN_SPAN_MS = 1000
/** A download that delivers no byte for this long shows that it waits instead of a speed. */
export const STALL_SHOWN_MS = 3000

/** Bytes in a megabyte as sizes are stated: decimal, as download tools do. */
const MEGABYTE = 1_000_000

/**
 * A download size for a person.
 * @param bytes - the size.
 * @returns the size in kB, MB or GB, with one decimal from a megabyte up.
 */
export function formatSize(bytes: number): string {
  if (bytes < MEGABYTE) return `${String(Math.max(1, Math.round(bytes / 1000)))} kB`
  if (bytes < 1000 * MEGABYTE) return `${(bytes / MEGABYTE).toFixed(1)} MB`
  return `${(bytes / (1000 * MEGABYTE)).toFixed(1)} GB`
}

/**
 * A speed for a person.
 * @param bytesPerSecond - the speed.
 * @returns the speed with {@link formatSize}'s unit, per second.
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

/**
 * A length of time for a person.
 * @param ms - the time in milliseconds.
 * @returns tenths of a second below ten seconds, whole seconds below a minute, then minutes and seconds.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 60) return `${String(whole)}s`
  return `${String(Math.floor(whole / 60))}m ${String(whole % 60).padStart(2, '0')}s`
}

/**
 * An estimate of the time left, without the words around it: at least a second, then as {@link formatDuration} says it,
 * and hours and minutes from an hour up.
 * @param seconds - the estimate.
 * @returns `14s`, `2m 05s` or `1h 03m`.
 */
export function formatRemaining(seconds: number): string {
  if (seconds >= 3600) return `${String(Math.floor(seconds / 3600))}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`
  return formatDuration(Math.max(1, seconds) * 1000)
}

/** One reading of a download: how much had arrived at a moment, in clock milliseconds. */
export interface TransferSample {
  readonly at: number
  readonly done: number
}

/**
 * The speed of one download over the recent window. Readings go in as they come, from byte events or from a timer that
 * reads the same count again; the speed needs readings at least {@link SPEED_MIN_SPAN_MS} apart and some bytes between
 * them. A count that goes down (the download started again) starts the readings over.
 */
export class TransferRate {
  #samples: TransferSample[] = []
  #changedAt: number | undefined

  /**
   * Add a reading and drop the readings older than the window.
   * @param at - when, in clock milliseconds.
   * @param done - the bytes that had arrived.
   */
  add(at: number, done: number): void {
    const last = this.#samples.at(-1)
    if (last !== undefined && done < last.done) this.#samples = []
    if (last === undefined || done !== last.done) this.#changedAt = at
    this.#samples.push({ at, done })
    while (this.#samples.length > 1 && at - this.#samples[0]!.at > SPEED_WINDOW_MS) this.#samples.shift()
  }

  /**
   * The bytes per second over the window.
   * @returns the speed, or `undefined` while the readings span less than {@link SPEED_MIN_SPAN_MS} or nothing arrived in
   *   the window.
   */
  speed(): number | undefined {
    const first = this.#samples[0]
    const last = this.#samples.at(-1)
    if (first === undefined || last === undefined || last.at - first.at < SPEED_MIN_SPAN_MS) return undefined
    const speed = (last.done - first.done) * 1000 / (last.at - first.at)
    return speed > 0 ? speed : undefined
  }

  /**
   * How long the count has stood still.
   * @param now - the clock now.
   * @returns milliseconds since the count last changed, or 0 before any reading.
   */
  stalledFor(now: number): number {
    return this.#changedAt === undefined ? 0 : Math.max(0, now - this.#changedAt)
  }

  /**
   * The seconds left at the current speed.
   * @param total - the download's size, when known.
   * @returns the estimate, or `undefined` without a size, a speed, or anything left.
   */
  secondsLeft(total: number | undefined): number | undefined {
    const done = this.#samples.at(-1)?.done
    const speed = this.speed()
    if (total === undefined || total <= 0 || done === undefined || done >= total || speed === undefined) return undefined
    return (total - done) / speed
  }
}
