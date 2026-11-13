/**
 * @delo/plugin-cost-meter — the harness half of the cost meter: the `costMeter` session projection, which estimates
 * each chat's cost from the token usage its providers reported and the row's price table. The value reaches the studio
 * through Session projections and summaries and never reaches a model request. The plugin makes no network request.
 * @module @delo/plugin-cost-meter
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.sessionProjections merge.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Config as CostMeterConfig } from './config.ts'
import { resolvePrices } from './pricing.ts'
import { costMeterProjection } from './projection.ts'

export { Config, COST_METER_ROW_ID } from './config.ts'
export { BUNDLED_PRICE_TABLE } from './prices.ts'
export { CostMeterConfigError, costOf, priceFor, resolvePrices } from './pricing.ts'
export type { LongContextRates, PeakRates, PriceEntry, PriceRoute, PriceSource, PriceTable, Rates, TokenBuckets } from './pricing.ts'
export { costMeterProjection, costMeterStateSchema, costMeterStateVersion, foldCost, FOLD_VERSION, type CostMeterState } from './projection.ts'
export { COST_METER_KEY, orderRows, sumRows, type CostMeterView, type CostModelRow } from './view.ts'

/** The plugin's name in logs. */
export const name = 'delo-cost-meter'

/** The projection registry; the meter needs nothing else. */
export const inject = ['sessionProjections']

/**
 * Validate the price table and register the projection for every Session.
 * @param ctx - the plugin context, holding `sessionProjections`.
 * @param config - the row's validated Config.
 * @throws CostMeterConfigError when the table repeats a model, names an unknown source or holds an impossible rate, so
 * the row fails at load.
 */
export async function apply(ctx: Context, config: CostMeterConfig): Promise<void> {
  const prices = resolvePrices({ sources: config.sources, models: config.models }, config.prices)
  await ctx.sessionProjections.register(costMeterProjection(prices))
}
