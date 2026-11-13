/**
 * The `costMeter` session projection: each model request's provider-reported token usage, priced with the effective
 * price table and summed per model. The fold reads only the log, so a reload, a resume and a fork compute the same
 * value; the price table is part of the state version, so a changed price refolds every Session.
 * @module @delo/plugin-cost-meter/projection
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: the `llm/retry-started` event merge.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { z } from 'zod'
import { costOf, priceFor, type PriceEntry, type PriceRoute, type TokenBuckets } from './pricing.ts'
import { COST_METER_KEY, sumRows, type CostMeterView, type CostModelRow } from './view.ts'

/** The fold's own version; the state version adds the price table's hash to it. Bump it when the state fields or the fold change. */
export const FOLD_VERSION = 1

const count = z.number().int().nonnegative()

const bucketsSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }).strict()

const rowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  requests: z.number().int(),
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  usd: z.number(),
  unpriced: z.number().int(),
}).strict()

/** The fold's state schema, which checks a stored checkpoint before it seeds a fold. */
export const costMeterStateSchema = z.object({
  /** The route of the latest `request/header`, which the next usage is priced for. */
  route: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  /** The latest sample, which a later settlement of the same step replaces unless a retry closed it. */
  last: z.object({
    turn: count,
    step: count,
    key: z.string(),
    sample: bucketsSchema,
    usd: z.number().nullable(),
  }).strict().nullable(),
  /** Per-model totals, by {@link rowKey}. */
  models: z.record(z.string(), rowSchema),
}).strict()

/** The fold's state. */
export type CostMeterState = z.infer<typeof costMeterStateSchema>

const viewSchema: z.ZodType<CostMeterView> = z.object({
  usd: z.number().nonnegative(),
  tokens: count,
  requests: count,
  unpriced: count,
  models: z.array(rowSchema),
}).strict()

/**
 * The state version of a price table: {@link FOLD_VERSION} in the high bits and a 32-bit FNV-1a hash of the table.
 * @param prices - the effective entries.
 * @returns a non-negative safe integer that differs for a different table.
 */
export function costMeterStateVersion(prices: readonly PriceEntry[]): number {
  const text = JSON.stringify(prices)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return FOLD_VERSION * 2 ** 32 + (hash >>> 0)
}

const rowKey = (route: PriceRoute): string => JSON.stringify([route.provider, route.model])

/**
 * The projection definition for one effective price table.
 * @param prices - the effective entries.
 * @returns the definition to register.
 */
export function costMeterProjection(prices: readonly PriceEntry[]): ReturnType<typeof costMeterProjectionOf> {
  return costMeterProjectionOf(prices)
}

/**
 * The definition {@link costMeterProjection} returns, with the wire view its registration requires.
 * @param prices - the effective entries.
 * @returns the definition.
 */
function costMeterProjectionOf(prices: readonly PriceEntry[]) {
  const views = new WeakMap<CostMeterState['models'], CostMeterView>()
  return {
    key: COST_METER_KEY,
    stateVersion: costMeterStateVersion(prices),
    stateSchema: costMeterStateSchema,
    init: () => ({ route: null, last: null, models: {} }),
    apply: (state, event) => foldCost(prices, state, event),
    wire: {
      viewSchema,
      // The view depends only on the totals, so a route change keeps the published reference.
      view: (state) => {
        const cached = views.get(state.models)
        if (cached !== undefined) return cached
        const value = sumRows(Object.values(state.models))
        views.set(state.models, value)
        return value
      },
    },
  } satisfies ProjectionDefinition<typeof COST_METER_KEY, CostMeterState>
}

/**
 * Fold one committed event. A retried attempt adds to the total, as upstream's `tokenUsage` projection counts it; a
 * second settlement of the same step without a retry between replaces the first.
 * @param prices - the effective entries.
 * @param state - the state covering every earlier event.
 * @param event - the next committed event.
 * @returns the next state; the same reference for an event that changes nothing.
 */
export function foldCost(prices: readonly PriceEntry[], state: CostMeterState, event: SessionEvent): CostMeterState {
  switch (event.type) {
    case 'request/header': {
      const { provider, model } = event.data.header.config
      return state.route?.provider === provider && state.route.model === model ? state : { ...state, route: { provider, model } }
    }
    case 'llm/retry-started':
      return state.last?.turn === event.data.turn && state.last.step === event.data.step ? { ...state, last: null } : state
    case 'assistant/message':
    case 'assistant/attempt':
      return foldUsage(prices, state, event)
    default:
      return state
  }
}

function foldUsage(prices: readonly PriceEntry[], state: CostMeterState, event: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>): CostMeterState {
  const sample = bucketsOf(event)
  if (sample === undefined) return state
  const { turn, step } = event.data
  const route = state.route ?? { provider: 'unknown', model: 'unknown' }
  const key = rowKey(route)
  const previous = state.last?.turn === turn && state.last.step === step ? state.last : undefined
  if (previous?.key === key && sameBuckets(previous.sample, sample)) return state
  const usd = costOf(priceFor(prices, route), sample, event.time)
  const models = { ...state.models }
  if (previous !== undefined) models[previous.key] = addSample(models[previous.key]!, previous.sample, previous.usd, -1)
  models[key] = addSample(models[key] ?? emptyRow(route), sample, usd, 1)
  return { ...state, last: { turn, step, key, sample, usd }, models }
}

function emptyRow(route: PriceRoute): CostModelRow {
  return { provider: route.provider, model: route.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpriced: 0 }
}

function addSample(row: CostModelRow, sample: TokenBuckets, usd: number | null, sign: 1 | -1): CostModelRow {
  return {
    ...row,
    requests: row.requests + sign,
    input: row.input + sign * sample.input,
    output: row.output + sign * sample.output,
    cacheRead: row.cacheRead + sign * sample.cacheRead,
    cacheWrite: row.cacheWrite + sign * sample.cacheWrite,
    usd: row.usd + sign * (usd ?? 0),
    unpriced: row.unpriced + (usd === null ? sign : 0),
  }
}

/**
 * The buckets one settlement reports: the message's own usage, else the stream's last usage chunk.
 * @param event - an Assistant settlement.
 * @returns the buckets, or `undefined` when none was reported or a count is not a non-negative safe integer.
 */
function bucketsOf(event: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>): TokenBuckets | undefined {
  let usage = event.type === 'assistant/message' ? event.data.usage : undefined
  for (let index = event.data.stream.length - 1; usage === undefined && index >= 0; index -= 1) {
    const record = event.data.stream[index]!
    if (record.type === 'chunk' && record.chunk.type === 'usage') usage = record.chunk.usage
  }
  if (usage === undefined) return undefined
  const buckets = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 }
  return Object.values(buckets).every(value => Number.isSafeInteger(value) && value >= 0) ? buckets : undefined
}

function sameBuckets(left: TokenBuckets, right: TokenBuckets): boolean {
  return left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite
}
