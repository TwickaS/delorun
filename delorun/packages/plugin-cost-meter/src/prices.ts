/**
 * The price table the plugin ships: list prices in USD per million tokens, each entry naming the pricing page it was
 * read from and the day it was checked. It is the default of the row's `sources` and `models` Config fields, so a
 * deployment can replace it, and the row's `prices` field overrides single models over it.
 * @module @delorun/plugin-cost-meter/prices
 */
import type { PriceTable } from './pricing.ts'

/** DeepSeek's peak hours, Monday to Friday 01:00–04:00 and 06:00–10:00 UTC, at twice the off-peak rates. */
const DEEPSEEK_PEAK_DAYS = [1, 2, 3, 4, 5]
const DEEPSEEK_PEAK_HOURS: [number, number][] = [[1, 4], [6, 10]]

/** The bundled table, as checked on its sources' `checked` dates. */
export const BUNDLED_PRICE_TABLE: PriceTable = {
  sources: {
    anthropic: {
      url: 'https://platform.claude.com/docs/en/about-claude/pricing',
      checked: '2026-11-12',
      notes: 'Global routing and 5-minute cache writes.',
    },
    deepseek: {
      url: 'https://api-docs.deepseek.com/quick_start/pricing',
      checked: '2026-11-12',
      notes: 'Base rates are off-peak; peak rates apply Monday to Friday 01:00-04:00 and 06:00-10:00 UTC. Chinese public holidays are not modelled. DeepSeek bills no cache writes, so cacheWrite equals the cache-miss input rate.',
    },
  },
  models: [
    { model: 'claude-opus-5-5', source: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    { model: 'claude-sonnet-5-5', source: 'anthropic', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    {
      model: 'claude-haiku-5-5', source: 'anthropic', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
    { model: 'claude-fable-5-1', source: 'anthropic', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    {
      model: 'deepseek-flash', source: 'deepseek', input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15,
      peak: { utcWeekdays: DEEPSEEK_PEAK_DAYS, utcHours: DEEPSEEK_PEAK_HOURS, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
    },
    {
      model: 'deepseek-v4-flash', source: 'deepseek', input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15,
      peak: { utcWeekdays: DEEPSEEK_PEAK_DAYS, utcHours: DEEPSEEK_PEAK_HOURS, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
    },
    {
      model: 'deepseek-v4-pro', source: 'deepseek', input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66,
      peak: { utcWeekdays: DEEPSEEK_PEAK_DAYS, utcHours: DEEPSEEK_PEAK_HOURS, input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
    },
  ],
}
