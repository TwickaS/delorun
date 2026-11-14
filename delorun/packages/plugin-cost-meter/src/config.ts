/**
 * The row's Config: the price table and the per-model overrides, validated when the row loads. Its defaults are the
 * bundled table ({@link BUNDLED_PRICE_TABLE}) and no overrides.
 * @module @delorun/plugin-cost-meter/config
 */
import z from '@deepseek-ai/schemastery'
import { BUNDLED_PRICE_TABLE } from './prices.ts'
import type { LongContextRates, PeakRates, PriceEntry, PriceSource } from './pricing.ts'

/** The Loader row id of `@delorun/bundle-studio`'s row for this plugin. */
export const COST_METER_ROW_ID = 'delorun-cost-meter'

/** The row's configuration. */
export interface Config {
  /** Pricing pages by key, each with its address and the day its rates were checked. */
  sources: Record<string, PriceSource>
  /** The price table: one entry per model and provider. */
  models: PriceEntry[]
  /** Entries that replace the table's entry of the same model and provider, or add a model. */
  prices: PriceEntry[]
}

const rate = (bucket: string): z<number> => z.number().min(0).required().description(`USD per million ${bucket} tokens.`)

const RATES = {
  input: rate('uncached input'),
  output: rate('output'),
  cacheRead: rate('cache-read'),
  cacheWrite: rate('cache-write'),
}

// Each schema states its value type; schemastery infers optional fields as `T | null`, which the plain types do not
// carry. An absent optional object stays absent (`default(undefined)`) instead of being validated as `{}`.
const LongContext = z.object({
  aboveTokens: z.natural().required().description('The prompt size, in tokens, above which the whole request pays these rates.'),
  ...RATES,
}).default(undefined as never) as z<LongContextRates | undefined>

const Peak = z.object({
  utcWeekdays: z.array(z.natural().max(6)).min(1).required().description('UTC weekdays, 0 for Sunday to 6 for Saturday.'),
  utcHours: z.array(z.tuple([z.natural().max(23), z.natural().min(1).max(24)])).min(1).required().description('UTC hour ranges [startHour, endHour).'),
  ...RATES,
}).default(undefined as never) as z<PeakRates | undefined>

const Entry = z.object({
  model: z.string().min(1).required().description('A model id prefix; the longest matching prefix wins.'),
  provider: z.string().min(1).description('Limits the entry to one provider route.'),
  source: z.string().min(1).description('The key of the source the rates were read from.'),
  ...RATES,
  longContext: LongContext.description('Rates for a whole request whose prompt exceeds aboveTokens.'),
  peak: Peak.description('Rates for a request that settles inside the peak hours; the entry\'s own rates are the off-peak rates.'),
}) as z<PriceEntry>

const Source = z.object({
  url: z.string().role('link').required().description('The pricing page.'),
  checked: z.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required().description('The day the rates were compared with the page, YYYY-MM-DD.'),
  notes: z.string().description('What the page\'s rates assume.'),
}) as z<PriceSource>

/** The Config schema: the bundled table by default, overridable per model through `prices`. */
export const Config: z<Config> = z.object({
  sources: z.dict(Source).default(BUNDLED_PRICE_TABLE.sources).description('The pricing pages the rates were read from.'),
  models: z.array(Entry).default(BUNDLED_PRICE_TABLE.models).description('The price table, in USD per million tokens.'),
  prices: z.array(Entry).default([]).description('Entries that replace the table\'s entry of the same model and provider, or add a model.'),
})
