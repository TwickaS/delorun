/**
 * Price entries, their cross-field validation, model matching and the cost of one request. Client-safe: no Node API
 * and no schema library, so the studio half and the projection share it.
 * @module @delorun/plugin-cost-meter/pricing
 */

/** USD per million tokens of each of the four disjoint billing buckets. */
export interface Rates {
  /** Uncached input. */
  input: number
  /** Output, reasoning included. */
  output: number
  /** Input read from the provider's cache. */
  cacheRead: number
  /** Input written to the provider's cache. */
  cacheWrite: number
}

/** Rates for a whole request whose prompt (input plus cache reads and writes) exceeds `aboveTokens`. */
export interface LongContextRates extends Rates {
  /** The prompt size, in tokens, above which these rates apply. */
  aboveTokens: number
}

/** Rates for a request that settles on one of `utcWeekdays` inside one of the `utcHours` ranges; the entry's own rates are then the off-peak rates. */
export interface PeakRates extends Rates {
  /** UTC weekdays, 0 for Sunday to 6 for Saturday. */
  utcWeekdays: number[]
  /** UTC hour ranges `[startHour, endHour)` within 0 to 24. */
  utcHours: [number, number][]
}

/** One model's prices. */
export interface PriceEntry extends Rates {
  /** A model id prefix: the longest prefix that matches a request's model wins. */
  model: string
  /** Limits the entry to one provider route; without it the entry matches every route. */
  provider?: string | undefined
  /** The key of the {@link PriceSource} the rates were read from. */
  source?: string | undefined
  /** Long-prompt rates, for a provider that charges a whole long request more. */
  longContext?: LongContextRates | undefined
  /** Peak-hour rates, for a provider that charges more at set hours. */
  peak?: PeakRates | undefined
}

/** A pricing page the rates were read from. */
export interface PriceSource {
  /** The page's address. */
  url: string
  /** The day the rates were last compared with the page, `YYYY-MM-DD`. */
  checked: string
  /** What the page's rates assume, such as a routing or a cache lifetime. */
  notes?: string | undefined
}

/** A whole price table: its sources and one entry per model. */
export interface PriceTable {
  /** Pricing pages by key. */
  sources: Record<string, PriceSource>
  /** One entry per model and provider. */
  models: PriceEntry[]
}

/** The four disjoint token buckets one request reports. */
export interface TokenBuckets {
  /** Uncached input tokens. */
  input: number
  /** Output tokens. */
  output: number
  /** Cache-read tokens. */
  cacheRead: number
  /** Cache-write tokens. */
  cacheWrite: number
}

/** A request's provider route and model id, as its `request/header` names them. */
export interface PriceRoute {
  /** The provider route id. */
  provider: string
  /** The model id. */
  model: string
}

/** A price table the plugin refuses at load, with the place of the first problem. */
export class CostMeterConfigError extends Error {
  override readonly name = 'CostMeterConfigError'
}

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

/**
 * Check what the Config schema cannot: finite rates, peak hour ranges, one entry per model and provider, and source
 * keys that name a source.
 * @param table - the schema-validated table.
 * @param overrides - the schema-validated per-model overrides.
 * @returns the effective entries: the table's, with each override replacing the entry of the same model and provider,
 * and the other overrides added.
 * @throws CostMeterConfigError naming the Config path of the first problem.
 */
export function resolvePrices(table: PriceTable, overrides: readonly PriceEntry[]): PriceEntry[] {
  checkEntries(table.models, 'models', table.sources)
  checkEntries(overrides, 'prices', table.sources)
  const replaced = new Set(overrides.map(entryKey))
  return [...table.models.filter(entry => !replaced.has(entryKey(entry))), ...overrides]
}

function checkEntries(entries: readonly PriceEntry[], where: string, sources: PriceTable['sources']): void {
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const at = `cost-meter: ${where}[${index}]`
    const key = entryKey(entry)
    if (seen.has(key)) throw new CostMeterConfigError(`${at} repeats model ${JSON.stringify(entry.model)}${entry.provider === undefined ? '' : ` for provider ${JSON.stringify(entry.provider)}`}`)
    seen.add(key)
    if (entry.source !== undefined && !Object.hasOwn(sources, entry.source)) {
      throw new CostMeterConfigError(`${at} names source ${JSON.stringify(entry.source)}, which sources does not list`)
    }
    checkRates(entry, at)
    if (entry.longContext !== undefined) checkRates(entry.longContext, `${at}.longContext`)
    if (entry.peak !== undefined) {
      checkRates(entry.peak, `${at}.peak`)
      if (entry.peak.utcWeekdays.length === 0 || entry.peak.utcHours.length === 0) throw new CostMeterConfigError(`${at}.peak needs at least one weekday and one hour range`)
      for (const [start, end] of entry.peak.utcHours) {
        if (start >= end) throw new CostMeterConfigError(`${at}.peak.utcHours has the range [${start}, ${end}], whose start is not before its end`)
      }
    }
  })
}

function checkRates(rates: Rates, at: string): void {
  for (const field of RATE_FIELDS) {
    if (!Number.isFinite(rates[field])) throw new CostMeterConfigError(`${at}.${field} must be a finite number of USD per million tokens`)
  }
}

function entryKey(entry: PriceEntry): string {
  return JSON.stringify([entry.provider ?? null, entry.model])
}

/**
 * Select the entry for a route: the longest matching model prefix, and of two equal prefixes the provider-specific one.
 * @param entries - the effective entries.
 * @param route - the request's provider route and model id.
 * @returns the matching entry, or `undefined` when the model has no price.
 */
export function priceFor(entries: readonly PriceEntry[], route: PriceRoute): PriceEntry | undefined {
  let best: PriceEntry | undefined
  for (const entry of entries) {
    if (entry.provider !== undefined && entry.provider !== route.provider) continue
    if (!route.model.startsWith(entry.model)) continue
    if (best === undefined || entry.model.length > best.model.length
      || (entry.model.length === best.model.length && entry.provider !== undefined)) best = entry
  }
  return best
}

/**
 * Price one request. Long-prompt rates take precedence over peak rates, as no bundled provider combines them.
 * @param entry - the route's entry, or `undefined` when the model has no price.
 * @param sample - the request's token buckets.
 * @param time - when the request settled, epoch milliseconds; peak hours are read in UTC.
 * @returns the cost in USD, or `null` when the model has no price.
 */
export function costOf(entry: PriceEntry | undefined, sample: TokenBuckets, time: number): number | null {
  if (entry === undefined) return null
  const prompt = sample.input + sample.cacheRead + sample.cacheWrite
  let rates: Rates = entry
  if (entry.longContext !== undefined && prompt > entry.longContext.aboveTokens) rates = entry.longContext
  else if (entry.peak !== undefined && inPeak(entry.peak, time)) rates = entry.peak
  return (sample.input * rates.input + sample.output * rates.output
    + sample.cacheRead * rates.cacheRead + sample.cacheWrite * rates.cacheWrite) / 1_000_000
}

function inPeak(peak: PeakRates, time: number): boolean {
  const date = new Date(time)
  const hour = date.getUTCHours()
  return peak.utcWeekdays.includes(date.getUTCDay()) && peak.utcHours.some(([start, end]) => hour >= start && hour < end)
}
