/**
 * The `costMeter` projection on upstream's real Session store and projection registry: each request priced for the
 * route of the latest request header, retries added, a repeated settlement replaced, a model with no price counted
 * apart, and the same value after a reload, a checkpoint restore and a fork. The plugin's own load and unload too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as CostMeter from '../src/index.ts'
import { BUNDLED_PRICE_TABLE, costMeterProjection, costMeterStateSchema, costMeterStateVersion, FOLD_VERSION, foldCost, resolvePrices, type CostMeterView } from '../src/index.ts'

afterEach(() => { vi.useRealTimers() })

/** Monday 9 November 2026, 12:00 UTC: outside DeepSeek's peak hours. */
const OFF_PEAK = Date.UTC(2026, 10, 9, 12)
/** Monday 9 November 2026, 02:00 UTC: inside them. */
const PEAK = Date.UTC(2026, 10, 9, 2)

const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5-20261001' }
const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-v4-pro' }
const UNKNOWN = { provider: 'local', model: 'llama-9' }

/** A host with the store, the registry and the plugin loaded with a row config. */
async function host(config: Partial<CostMeter.Config> = {}) {
  vi.useFakeTimers({ now: OFF_PEAK, toFake: ['Date'] })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin(CostMeter, CostMeter.Config({ ...CostMeter.Config(), ...config }))
  await fiber
  const events: SessionEvent[] = []
  const session = ctx.sessions.create()
  const append = <E extends SessionEvent>(event: E): E => { events.push(event); return event }
  return {
    ctx, fiber, session, events,
    cost: (target: Session = session): CostMeterView | undefined => ctx.sessionProjections.snapshot(target).values.costMeter,
    route: (route: { provider: string; model: string }) => {
      append(session.append('request/header', { reason: 'initial', header: { config: route } }))
    },
    attempt: (turn: number, step: number, usage: TokenUsage) => {
      append(session.append('assistant/attempt', { turn, step, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }] }))
    },
    message: (turn: number, step: number, usage: TokenUsage | undefined) => {
      append(session.append('assistant/message', {
        turn, step, stream: [], ...usage === undefined ? {} : { usage },
        message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
      }, { surfaceOp: 'append' }))
    },
    retry: (turn: number, step: number) => {
      append(session.append('llm/retry-started', { retryId: RetryId(`retry-${turn}-${step}`), turn, step, retry: 1 }))
    },
  }
}

const M = 1_000_000

describe('the costMeter projection', () => {
  it('prices each request for the route of the latest request header, costliest model first', async () => {
    const h = await host()
    expect(h.cost()).toEqual({ usd: 0, requests: 0, unpriced: 0, models: [] })
    h.route(DEEPSEEK)
    h.message(1, 1, { inputTokens: M, outputTokens: M })
    h.route(OPUS)
    h.message(1, 2, { inputTokens: M, outputTokens: 0, cacheReadTokens: M, cacheWriteTokens: M })
    const cost = h.cost()!
    expect(cost.usd).toBeCloseTo(0.66 + 1.98 + 4 + 0.2 + 5)
    expect(cost.models.map(row => [row.model, row.requests, row.unpriced])).toEqual([[OPUS.model, 1, 0], [DEEPSEEK.model, 1, 0]])
    expect(cost.models[0]).toMatchObject({ provider: 'anthropic', input: M, output: 0, cacheRead: M, cacheWrite: M })
    expect(cost).toMatchObject({ requests: 2, unpriced: 0 })
  })

  it('charges the rates of the hour the request settled', async () => {
    const h = await host()
    h.route(DEEPSEEK)
    vi.setSystemTime(PEAK)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()?.usd).toBeCloseTo(1.32)
  })

  it('reads the usage from the stream when the message carries none, and ignores a settlement without usage', async () => {
    const h = await host()
    h.route(OPUS)
    h.message(1, 1, undefined)
    h.attempt(1, 2, { inputTokens: -1, outputTokens: 1 })
    expect(h.cost()?.requests).toBe(0)
    h.attempt(1, 3, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 1, usd: 4 })
    // The last usage chunk counts, wherever other records follow it.
    h.session.append('assistant/attempt', { turn: 1, step: 4, stream: [
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } } },
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: M, outputTokens: 0 } } },
      { type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['done'] },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ] })
    expect(h.cost()).toMatchObject({ requests: 2, usd: 8 })
  })

  it('adds a retried attempt, and replaces a step\'s earlier settlement when no retry came between', async () => {
    const h = await host()
    h.route(OPUS)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    h.retry(1, 1)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 2, usd: 8 })
    // The final message repeats the second attempt's usage at a larger count: it replaces it.
    h.message(1, 1, { inputTokens: 2 * M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 2, usd: 12 })
    // A retry of another step leaves this step's sample open.
    h.retry(1, 9)
    h.message(1, 1, { inputTokens: 2 * M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 2, usd: 12 })
  })

  it('moves a replaced settlement to the model of a later route', async () => {
    const h = await host()
    h.route(UNKNOWN)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 1, unpriced: 1, usd: 0 })
    h.route(OPUS)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()).toMatchObject({ requests: 1, unpriced: 0, usd: 4 })
    expect(h.cost()?.models.map(row => row.model)).toEqual([OPUS.model])
  })

  it('counts a model with no price apart, and lists it last, without failing', async () => {
    const h = await host()
    h.attempt(1, 1, { inputTokens: 10, outputTokens: 0 })
    h.route(UNKNOWN)
    h.attempt(1, 2, { inputTokens: 10, outputTokens: 0 })
    h.route(OPUS)
    h.attempt(1, 3, { inputTokens: 10, outputTokens: 0 })
    const cost = h.cost()!
    expect(cost).toMatchObject({ requests: 3, unpriced: 2 })
    expect(cost.models.map(row => row.model)).toEqual([OPUS.model, 'unknown', UNKNOWN.model])
  })

  it('keeps the state for unrelated events and a repeated route, and the view while only the route changes', async () => {
    const h = await host()
    const prices = resolvePrices(BUNDLED_PRICE_TABLE, [])
    const definition = costMeterProjection(prices)
    const state = definition.init()
    const header = (route: { provider: string; model: string }) => ({ type: 'request/header', seq: 0, time: 0, data: { reason: 'initial', header: { config: route } } }) as SessionEvent
    const routed = definition.apply(state, header(OPUS))
    expect(definition.apply(routed, header(OPUS))).toBe(routed)
    expect(definition.apply(routed, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as SessionEvent)).toBe(routed)
    expect(definition.apply(routed, { type: 'llm/retry-started', seq: 1, time: 0, data: { retryId: RetryId('r'), turn: 1, step: 1, retry: 1 } } as SessionEvent)).toBe(routed)
    const rerouted = definition.apply(routed, header(DEEPSEEK))
    expect(definition.wire.view(rerouted)).toBe(definition.wire.view(routed))
    expect(foldCost(prices, rerouted, header(DEEPSEEK))).toBe(rerouted)
    expect(h.cost()?.requests).toBe(0)
  })

  it('computes the same value after a reload, a checkpoint restore and a fork', async () => {
    const h = await host()
    h.route(OPUS)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    const checkpoint = h.ctx.sessionProjections.checkpoint(h.session)
    h.retry(1, 1)
    h.message(1, 1, { inputTokens: M, outputTokens: M })
    const before = h.cost()
    expect(before).toMatchObject({ requests: 2, usd: 4 + 4 + 20 })

    const fork = h.ctx.sessions.fork(h.session)
    expect(h.cost(fork)).toEqual(before)

    const restored = h.ctx.sessionProjections.restore(checkpoint, h.events.slice(2), SessionLogOffset(2), h.session.header, h.session.inheritedEventCount)
    expect(restored.snapshot.values.costMeter).toEqual(before)

    await h.fiber.dispose()
    expect(h.cost()).toBeUndefined()
    await h.ctx.plugin(CostMeter, CostMeter.Config())
    expect(h.cost()).toEqual(before)
  })

  it('recomputes every Session when a price changes', async () => {
    const h = await host()
    h.route(OPUS)
    h.attempt(1, 1, { inputTokens: M, outputTokens: 0 })
    expect(h.cost()?.usd).toBe(4)
    await h.fiber.dispose()
    await h.ctx.plugin(CostMeter, CostMeter.Config({ ...CostMeter.Config(), prices: [{ model: 'claude-opus-5-5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }] }))
    expect(h.cost()?.usd).toBe(3)
  })

  it('takes the row\'s overrides over the bundled table, and prices a model the table lacks', async () => {
    const h = await host(CostMeter.Config({ ...CostMeter.Config(), prices: [{ model: 'llama', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] }))
    h.route(UNKNOWN)
    h.attempt(1, 1, { inputTokens: M, outputTokens: M })
    expect(h.cost()).toMatchObject({ usd: 2, unpriced: 0 })
  })

  it('fails at load on a malformed table and registers nothing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = ctx.plugin(CostMeter, CostMeter.Config({ ...CostMeter.Config(), prices: [{ model: 'a', source: 'nowhere', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] }))
    await expect(Promise.resolve(fiber)).rejects.toThrow(/names source "nowhere"/)
    expect(ctx.sessionProjections.snapshot(ctx.sessions.create()).values.costMeter).toBeUndefined()
  })

  it('folds the table into its state version, so a different price is a different version', () => {
    const prices = resolvePrices(BUNDLED_PRICE_TABLE, [])
    const version = costMeterStateVersion(prices)
    expect(Number.isSafeInteger(version)).toBe(true)
    expect(Math.floor(version / 2 ** 32)).toBe(FOLD_VERSION)
    expect(costMeterStateVersion(prices)).toBe(version)
    expect(costMeterStateVersion(resolvePrices(BUNDLED_PRICE_TABLE, [{ model: 'claude-opus-5-5', input: 5, output: 20, cacheRead: 0.2, cacheWrite: 5 }]))).not.toBe(version)
  })

  it('rejects a stored state without its fields', () => {
    expect(() => costMeterStateSchema.parse({ route: null, models: {} })).toThrow()
    expect(costMeterStateSchema.parse({ route: null, last: null, models: {} })).toEqual({ route: null, last: null, models: {} })
  })
})
