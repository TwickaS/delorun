/**
 * Stage 9's rule: what the plugin costs the studio, reported only when the difference is large and repeats (A587: a noisy
 * machine makes small differences meaningless). Each run is measured three times with the plugin and three times without
 * (the baseline). A metric is reported only when even the best run with the plugin is worse than the worst run without
 * it, by more than both the ratio and the absolute floor below; anything less is within the noise of this machine.
 *
 * @module @delorun/tools/compat-bench/cost
 */

/** One start of the studio, measured. */
export interface CostSample {
  /** Milliseconds from starting the studio to its listening. */
  readonly startMs: number
  /** Resident memory of the studio's processes after it settled, in bytes. */
  readonly rssBytes: number
  /** Browser console errors on the home screen. */
  readonly consoleErrors: number
}

/** How many runs each side is measured. */
export const COST_RUNS = 3

/**
 * The thresholds. They are set so that a difference seen on this machine's usual spread of start time (several seconds
 * under load) and memory (tens of megabytes) is not reported; a finding needs both the ratio and the floor.
 */
export const COST_THRESHOLDS = {
  /** The best start with the plugin is at least this many times the worst start without it... */
  startRatio: 1.5,
  /** ...and at least this many milliseconds slower. */
  startFloorMs: 3000,
  /** The same for memory: the ratio... */
  rssRatio: 1.25,
  /** ...and the floor in bytes (100 MiB). */
  rssFloorBytes: 100 * 1024 * 1024,
  /** Console errors: every run with the plugin has at least this many more than the worst baseline run. */
  consoleErrorsMore: 1,
} as const

/** One metric's outcome. */
export interface CostFinding {
  /** The metric. */
  readonly metric: 'start' | 'memory' | 'console-errors'
  /** Whether the difference is large and repeats. */
  readonly reported: boolean
  /** The numbers, in words. */
  readonly detail: string
}

/**
 * Compare runs with the plugin against runs without it.
 * @param withPlugin - the samples with the plugin; {@link COST_RUNS} of them.
 * @param baseline - the samples without it; {@link COST_RUNS} of them.
 * @returns one finding per metric.
 * @throws Error when either side has fewer than {@link COST_RUNS} samples.
 */
export function costFindings(withPlugin: readonly CostSample[], baseline: readonly CostSample[]): CostFinding[] {
  if (withPlugin.length < COST_RUNS || baseline.length < COST_RUNS) throw new Error(`cost needs ${String(COST_RUNS)} runs each way`)
  const finding = (metric: CostFinding['metric'], values: (sample: CostSample) => number, ratio: number, floor: number, unit: string): CostFinding => {
    const bestWith = Math.min(...withPlugin.map(values))
    const worstWithout = Math.max(...baseline.map(values))
    const reported = bestWith > worstWithout * ratio && bestWith - worstWithout > floor
    return { metric, reported, detail: `${unit === 'MiB' ? String(Math.round(bestWith / 1048576)) : String(Math.round(bestWith))} ${unit} at best with the plugin against ${unit === 'MiB' ? String(Math.round(worstWithout / 1048576)) : String(Math.round(worstWithout))} ${unit} at worst without it` }
  }
  const errors = ((): CostFinding => {
    const bestWith = Math.min(...withPlugin.map(sample => sample.consoleErrors))
    const worstWithout = Math.max(...baseline.map(sample => sample.consoleErrors))
    return { metric: 'console-errors', reported: bestWith - worstWithout >= COST_THRESHOLDS.consoleErrorsMore, detail: `${String(bestWith)} console errors at best with the plugin against ${String(worstWithout)} at worst without it` }
  })()
  return [
    finding('start', sample => sample.startMs, COST_THRESHOLDS.startRatio, COST_THRESHOLDS.startFloorMs, 'ms'),
    finding('memory', sample => sample.rssBytes, COST_THRESHOLDS.rssRatio, COST_THRESHOLDS.rssFloorBytes, 'MiB'),
    errors,
  ]
}
