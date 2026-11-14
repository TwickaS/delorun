/**
 * The aggregate of repeated samples of one measured item: the median decides budgets, and the minimum, maximum and
 * spread (maximum minus minimum) show how far a loaded machine moved the samples.
 *
 * @module @delorun/benchmarks/harness/stats
 */

/** The summary of one item's samples. */
export interface Summary {
  /** How many samples. */
  readonly n: number
  /** The median, in milliseconds; the mean of the two middle samples for an even count. */
  readonly median: number
  /** The smallest sample. */
  readonly min: number
  /** The largest sample. */
  readonly max: number
  /** The largest minus the smallest. */
  readonly spread: number
}

/**
 * The median of samples.
 * @param samples - at least one sample.
 * @returns the median.
 * @throws {RangeError} when there is no sample.
 */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError('no sample to take a median of')
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Summarise samples.
 * @param samples - at least one sample, in milliseconds.
 * @returns the summary, rounded to whole milliseconds.
 * @throws {RangeError} when there is no sample.
 */
export function summarize(samples: readonly number[]): Summary {
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  return { n: samples.length, median: Math.round(median(samples)), min: Math.round(min), max: Math.round(max), spread: Math.round(max - min) }
}
