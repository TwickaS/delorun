/**
 * The `costMeter` projection's client view, shared by the harness half that serves it and the studio half that reads
 * it, and its `SessionProjectionMap` entry.
 * @module @delorun/plugin-cost-meter/view
 */

/** The projection key. */
export const COST_METER_KEY = 'costMeter'

/** One model's totals within a Session. */
export interface CostModelRow {
  /** The provider route id. */
  provider: string
  /** The model id. */
  model: string
  /** Requests that reported usage, retried attempts included. */
  requests: number
  /** Uncached input tokens. */
  input: number
  /** Output tokens. */
  output: number
  /** Cache-read tokens. */
  cacheRead: number
  /** Cache-write tokens. */
  cacheWrite: number
  /** Estimated cost in USD of the priced requests. */
  usd: number
  /** Requests whose model has no price, counted in `requests` and not in `usd`. */
  unpriced: number
}

/** A Session's estimated cost: its totals and one row per model, costliest first, rows with no priced request last. */
export interface CostMeterView {
  /** Estimated cost in USD. */
  usd: number
  /** Tokens of every bucket. */
  tokens: number
  /** Requests that reported usage. */
  requests: number
  /** Requests whose model has no price. */
  unpriced: number
  /** Per-model rows. */
  models: CostModelRow[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The Session's estimated cost by model, from `@delorun/plugin-cost-meter`; Session summaries carry it for the agent roll-up. */
    costMeter: CostMeterView
  }
}

/**
 * Order model rows: rows with at least one priced request first, costliest first.
 * @param rows - the rows to order.
 * @returns a new ordered array.
 */
export function orderRows(rows: readonly CostModelRow[]): CostModelRow[] {
  return [...rows].sort((left, right) => Number(left.unpriced === left.requests) - Number(right.unpriced === right.requests) || right.usd - left.usd)
}

/**
 * Sum model rows into a view: rows of the same provider and model are added together.
 * @param rows - the rows, in any order.
 * @returns the view, with rows of no request dropped and negative rounding residue clamped to zero.
 */
export function sumRows(rows: readonly CostModelRow[]): CostMeterView {
  const merged = new Map<string, CostModelRow>()
  for (const row of rows) {
    if (row.requests <= 0) continue
    const key = JSON.stringify([row.provider, row.model])
    const sum = merged.get(key)
    merged.set(key, sum === undefined ? { ...row, usd: Math.max(0, row.usd) } : {
      ...sum,
      requests: sum.requests + row.requests,
      input: sum.input + row.input,
      output: sum.output + row.output,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      usd: sum.usd + Math.max(0, row.usd),
      unpriced: sum.unpriced + row.unpriced,
    })
  }
  const models = orderRows([...merged.values()])
  return {
    usd: models.reduce((total, row) => total + row.usd, 0),
    tokens: models.reduce((total, row) => total + row.input + row.output + row.cacheRead + row.cacheWrite, 0),
    requests: models.reduce((total, row) => total + row.requests, 0),
    unpriced: models.reduce((total, row) => total + row.unpriced, 0),
    models,
  }
}
