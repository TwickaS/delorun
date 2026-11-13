/** The price table: the Config schema, the checks it cannot express, model matching and the cost of one request. */
import { describe, expect, it } from 'vitest'
import { BUNDLED_PRICE_TABLE, Config, CostMeterConfigError, costOf, priceFor, resolvePrices, type PriceEntry } from '../src/index.ts'

const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 }
const sources = { list: { url: 'https://example.com/pricing', checked: '2026-11-12' } }
const sample = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }

/** Monday 9 November 2026, 02:30 UTC: inside DeepSeek's first peak range. */
const MONDAY_PEAK = Date.UTC(2026, 10, 9, 2, 30)
/** Monday 9 November 2026, 05:00 UTC: between the two peak ranges. */
const MONDAY_GAP = Date.UTC(2026, 10, 9, 5, 0)
/** Sunday 8 November 2026, 02:30 UTC: a peak hour on a day with no peak. */
const SUNDAY = Date.UTC(2026, 10, 8, 2, 30)

describe('the Config schema', () => {
  it('defaults to the bundled table and no overrides', () => {
    expect(Config()).toEqual({ sources: BUNDLED_PRICE_TABLE.sources, models: BUNDLED_PRICE_TABLE.models, prices: [] })
  })

  it('names a pricing page and a checked date for every bundled source, and a known source for every bundled model', () => {
    for (const source of Object.values(BUNDLED_PRICE_TABLE.sources)) {
      expect(source.url).toMatch(/^https:\/\//)
      expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(() => resolvePrices(BUNDLED_PRICE_TABLE, [])).not.toThrow()
    for (const entry of BUNDLED_PRICE_TABLE.models) expect(Object.keys(BUNDLED_PRICE_TABLE.sources)).toContain(entry.source)
  })

  it('keeps an entry without long-prompt or peak rates free of them', () => {
    expect(Config({ ...Config(), prices: [{ model: 'x', ...rates }] }).prices).toEqual([{ model: 'x', ...rates }])
  })

  it.each([
    ['a negative rate', { prices: [{ model: 'x', ...rates, input: -1 }] }],
    ['a rate that is not a number', { prices: [{ model: 'x', ...rates, output: '2' }] }],
    ['an empty model', { prices: [{ ...rates, model: '' }] }],
    ['a missing rate', { prices: [{ model: 'x', input: 1, output: 1, cacheRead: 1 }] }],
    ['long-prompt rates without their threshold', { prices: [{ model: 'x', ...rates, longContext: rates }] }],
    ['a weekday past Saturday', { prices: [{ model: 'x', ...rates, peak: { ...rates, utcWeekdays: [7], utcHours: [[1, 2]] } }] }],
    ['an hour past 24', { prices: [{ model: 'x', ...rates, peak: { ...rates, utcWeekdays: [1], utcHours: [[1, 25]] } }] }],
    ['a source without a checked date', { sources: { list: { url: 'https://example.com' } } }],
    ['a checked date in another format', { sources: { list: { url: 'https://example.com', checked: '12/11/2026' } } }],
  ])('rejects %s', (_, value) => {
    expect(() => Config(value as never)).toThrow()
  })
})

describe('resolvePrices', () => {
  const table = { sources, models: [{ model: 'a', source: 'list', ...rates }, { model: 'b', ...rates }] }

  it('replaces the entry of the same model and provider, and adds the others', () => {
    const replaced = { model: 'a', ...rates, input: 9 }
    const added = { model: 'a', provider: 'route', ...rates }
    expect(resolvePrices(table, [replaced, added])).toEqual([table.models[1], replaced, added])
  })

  it.each<[string, PriceEntry[], PriceEntry[], RegExp]>([
    ['a repeated model', [{ model: 'a', ...rates }, { model: 'a', ...rates }], [], /models\[1\] repeats model "a"$/],
    ['a repeated model of one provider', [], [{ model: 'a', provider: 'p', ...rates }, { model: 'a', provider: 'p', ...rates }], /prices\[1\] repeats model "a" for provider "p"/],
    ['an unknown source', [], [{ model: 'a', source: 'nowhere', ...rates }], /prices\[0\] names source "nowhere"/],
    ['a rate that is not finite', [{ model: 'a', ...rates, output: Number.POSITIVE_INFINITY }], [], /models\[0\]\.output must be a finite number/],
    ['a long-prompt rate that is not finite', [{ model: 'a', ...rates, longContext: { aboveTokens: 1, ...rates, input: Number.NaN } }], [], /longContext\.input/],
    ['a peak rate that is not finite', [{ model: 'a', ...rates, peak: { utcWeekdays: [1], utcHours: [[1, 2]], ...rates, cacheRead: Number.NaN } }], [], /peak\.cacheRead/],
    ['peak rates without hours', [{ model: 'a', ...rates, peak: { utcWeekdays: [1], utcHours: [], ...rates } }], [], /peak needs at least one weekday and one hour range/],
    ['peak rates without weekdays', [{ model: 'a', ...rates, peak: { utcWeekdays: [], utcHours: [[1, 2]], ...rates } }], [], /peak needs at least one weekday/],
    ['a peak range that ends before it starts', [{ model: 'a', ...rates, peak: { utcWeekdays: [1], utcHours: [[5, 5]], ...rates } }], [], /peak\.utcHours has the range \[5, 5\]/],
  ])('fails at load on %s', (_, models, overrides, message) => {
    expect(() => resolvePrices({ sources, models }, overrides)).toThrow(CostMeterConfigError)
    expect(() => resolvePrices({ sources, models }, overrides)).toThrow(message)
  })

  it('allows the same model once for every route and once for a named provider', () => {
    expect(resolvePrices({ sources, models: [{ model: 'a', ...rates }, { model: 'a', provider: 'p', ...rates }] }, [])).toHaveLength(2)
  })
})

describe('priceFor', () => {
  const entries: PriceEntry[] = [
    { model: 'claude', ...rates },
    { model: 'claude-opus', ...rates, input: 2 },
    { model: 'claude-opus', provider: 'bedrock', ...rates, input: 3 },
    { model: 'deepseek', provider: 'other', ...rates },
  ]

  it('selects the longest matching prefix', () => {
    expect(priceFor(entries, { provider: 'anthropic', model: 'claude-opus-5-5-20261001' })?.input).toBe(2)
    expect(priceFor(entries, { provider: 'anthropic', model: 'claude-haiku' })?.model).toBe('claude')
  })

  it('prefers a provider-specific entry of the same prefix, in either order', () => {
    expect(priceFor(entries, { provider: 'bedrock', model: 'claude-opus-5' })?.input).toBe(3)
    expect(priceFor([...entries].reverse(), { provider: 'bedrock', model: 'claude-opus-5' })?.input).toBe(3)
  })

  it('finds no price for an unknown model or another provider\'s entry', () => {
    expect(priceFor(entries, { provider: 'anthropic', model: 'gpt' })).toBeUndefined()
    expect(priceFor(entries, { provider: 'deepseek', model: 'deepseek-v4' })).toBeUndefined()
  })
})

describe('costOf', () => {
  const deepseek = BUNDLED_PRICE_TABLE.models.find(entry => entry.model === 'deepseek-v4-pro')!
  const haiku = BUNDLED_PRICE_TABLE.models.find(entry => entry.model === 'claude-haiku-5-5')!

  it('prices each bucket at its rate per million tokens', () => {
    expect(costOf({ model: 'x', ...rates }, { input: 500_000, output: 250_000, cacheRead: 2_000_000, cacheWrite: 0 }, 0)).toBeCloseTo(0.5 + 0.5 + 1)
  })

  it('has no cost for a model with no price', () => {
    expect(costOf(undefined, sample, 0)).toBeNull()
  })

  it('charges the long-prompt rates for a whole request above the threshold, and the base rates at it', () => {
    expect(costOf(haiku, { input: 60_000, output: 1000, cacheRead: 40_001, cacheWrite: 0 }, 0)).toBeCloseTo((60_000 * 0.5 + 1000 * 2.5 + 40_001 * 0.05) / 1e6)
    expect(costOf(haiku, { input: 60_000, output: 1000, cacheRead: 40_000, cacheWrite: 0 }, 0)).toBeCloseTo((60_000 * 0.1 + 1000 * 0.5 + 40_000 * 0.01) / 1e6)
  })

  it('charges the peak rates inside a peak range on a peak day, and the off-peak rates outside', () => {
    expect(costOf(deepseek, sample, MONDAY_PEAK)).toBeCloseTo(1.32 + 3.96 + 0.044 + 1.32)
    expect(costOf(deepseek, sample, MONDAY_GAP)).toBeCloseTo(0.66 + 1.98 + 0.022 + 0.66)
    expect(costOf(deepseek, sample, SUNDAY)).toBeCloseTo(0.66 + 1.98 + 0.022 + 0.66)
  })
})
