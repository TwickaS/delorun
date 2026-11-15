/**
 * The `delorun-update-check` row (`delorun/packages/bundle-local/src/update-check.ts`): with its switch off it mounts nothing,
 * so no check can run; on, it runs an attached check at start when one is due and then on its interval, never waits
 * for one, and serves the notice over one exact Connection route.
 */
import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { writeChannelRecord } from '@delorun/install'
import { UPDATE_CHANNEL_PATH, UPDATE_NOTES_PATH, UPDATE_NOTICE_PATH, type UpdateNotice } from '@delorun/contract-update-report'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as UpdateCheck from '../src/update-check.ts'
import { Config, MAX_INTERVAL_HOURS, UPDATE_CHECK_DEFAULTS, type UpdateCheckSource, type UpdateCheckState, type UpdateNotes } from '../src/update-check.ts'

const HOUR = 3_600_000
/** A semantic version as the notice's types brand it. */
type SemanticVersion = UpdateNotice['release']['delorun']
const semantic = (text: string): SemanticVersion => text as SemanticVersion
/** A row's configuration as written: plain values, before the Loader wraps `enabled` as a volatile. */
interface ConfigInput { readonly enabled?: boolean; readonly intervalHours?: number; readonly timeoutSeconds?: number }

/**
 * Validate a configuration as the Loader does, with the fields the row leaves out.
 * @param value - the row's configuration.
 * @returns the validated configuration.
 */
const parse = (value: ConfigInput): UpdateCheck.Config => Config(value as never) as UpdateCheck.Config
const NOTICE: UpdateNotice = {
  running: { delorun: semantic('0.1.0'), dsh: semantic('0.2.2') },
  release: { delorun: semantic('0.1.1'), dsh: semantic('0.2.2'), channel: 'stable', security: true },
  kind: 'patch',
  disables: 0,
}

/** A route the plugin registered. */
interface Route {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * Mount the row over a stub Connection.
 * @param config - the row's configuration.
 * @returns the context and the routes it registered.
 */
async function mount(config: ConfigInput) {
  return mountIn(new Context(), config)
}

/**
 * Mount the row in a given context.
 * @param ctx - the context, which may carry a `profileContext`.
 * @param config - the row's configuration.
 * @returns the context and the routes it registered.
 */
async function mountIn(ctx: Context, config: ConfigInput) {
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: {
      register: (route: Route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  const fiber = ctx.plugin(UpdateCheck, { ...UPDATE_CHECK_DEFAULTS, enabled: false, ...config } as never)
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, routes, fiber }
}

/**
 * A source whose answers the test sets.
 * @param read - what `read` answers.
 * @param check - what `check` answers.
 * @returns the source and its calls.
 */
function source(read: UpdateCheckState, check: UpdateCheckState = read, notes?: UpdateNotes) {
  const calls = { read: 0, check: [] as number[] }
  const value: UpdateCheckSource = {
    read: async () => { calls.read++; return read },
    check: async (timeoutMs) => { calls.check.push(timeoutMs); return check },
    notes: async () => notes,
  }
  return { source: value, calls }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the switch', () => {
  it('update-notice-off-makes-no-request: off, the default and the parity value, mounts no service and no route', async () => {
    expect(parse({}).enabled.get()).toBe(false)
    const { ctx, routes } = await mount({})
    expect(ctx.get('delorunUpdateCheck')).toBeUndefined()
    expect([...routes.keys()]).toEqual([UPDATE_CHANNEL_PATH])
  })

  it('validates the interval and the deadline', () => {
    expect(parse({ enabled: true }).enabled.get()).toBe(true)
    expect(parse({ enabled: true })).toMatchObject({ intervalHours: 24, timeoutSeconds: 15 })
    expect(() => parse({ intervalHours: 0 })).toThrow()
    expect(() => parse({ intervalHours: MAX_INTERVAL_HOURS + 1 })).toThrow()
    expect(() => parse({ timeoutSeconds: 0 })).toThrow()
  })
})

describe('the schedule', () => {
  it('checks at once when no check ran, then each interval, with the row\'s deadline', async () => {
    const { ctx } = await mount({ enabled: true, intervalHours: 2, timeoutSeconds: 7 })
    const { source: attached, calls } = source({}, { checked: Date.now() })
    ctx.delorunUpdateCheck.attach(attached)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual({ read: 1, check: [7000] })
    await vi.advanceTimersByTimeAsync(2 * HOUR - 1)
    expect(calls.check).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.check).toHaveLength(2)
  })

  it('waits out the interval from the last check when it is not due', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({ checked: Date.now() - HOUR }, { checked: Date.now() })
    ctx.delorunUpdateCheck.attach(attached)
    await vi.advanceTimersByTimeAsync(23 * HOUR - 1)
    expect(calls.check).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.check).toHaveLength(1)
  })

  it('logs a source that throws, and counts it as a failed check', async () => {
    const { ctx } = await mount({ enabled: true })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const reads: number[] = []
    ctx.delorunUpdateCheck.attach({ read: async () => { reads.push(1); throw new Error('no record') }, check: async () => Promise.reject('offline'), notes: async () => undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledWith('delorun-update-check: the update check failed: no record')
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(warn).toHaveBeenLastCalledWith('delorun-update-check: the update check failed: offline')
    expect(reads).toHaveLength(1)
  })

  it('update-notice-retries-after-failure: tries a failed check again after one hour, then two, four, up to the interval, never more often than hourly', async () => {
    const { ctx } = await mount({ enabled: true, intervalHours: 6 })
    const started = Date.now()
    const at: number[] = []
    ctx.delorunUpdateCheck.attach({
      read: async () => ({ checked: started, failed: true }),
      notes: async () => undefined,
      check: async () => { at.push((Date.now() - started) / HOUR); return { checked: Date.now(), failed: true } },
    })
    await vi.advanceTimersByTimeAsync(20 * HOUR)
    expect(at).toEqual([1, 3, 7, 13, 19])
  })

  it('update-notice-wall-clock: checks at the first hourly wake after a sleep that passed the interval', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({ checked: Date.now() }, { checked: Date.now() })
    ctx.delorunUpdateCheck.attach(attached)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.check).toEqual([])
    // The machine sleeps three days: the wall clock moves, the process's timers do not.
    vi.setSystemTime(Date.now() + 72 * HOUR)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(calls.check).toHaveLength(1)
  })

  it('stops when detached, and refuses a second check while one is attached', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({ checked: Date.now() })
    const detach = ctx.delorunUpdateCheck.attach(attached)
    expect(() => ctx.delorunUpdateCheck.attach(source({}).source)).toThrow('a check is already attached')
    await vi.advanceTimersByTimeAsync(0)
    detach()
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(calls.check).toEqual([])
    expect(() => ctx.delorunUpdateCheck.attach(source({}).source)).not.toThrow()
  })

  it('schedules nothing after it was detached while the first read ran', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({})
    const detach = ctx.delorunUpdateCheck.attach(attached)
    detach()
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(calls).toEqual({ read: 1, check: [] })
  })
})

describe('switching the check off in a running Host', () => {
  it('stops the interval at once and serves no notice, and a check attached as delorun attaches it resumes when switched on', async () => {
    const { ctx, routes, fiber } = await mount({ enabled: true, intervalHours: 1 })
    const { source: attached, calls } = source({}, { checked: Date.now(), notice: NOTICE })
    // Attached the way `delorun` attaches it: whenever the service is present.
    ctx.inject(['delorunUpdateCheck'], (scope) => { scope.effect(() => scope.delorunUpdateCheck.attach(attached)) })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.check).toHaveLength(1)
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.get('delorunUpdateCheck')).toBeUndefined()
    expect(routes.has(UPDATE_NOTICE_PATH)).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(calls.check).toHaveLength(1)
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.get('delorunUpdateCheck')).toBeDefined()
    expect(routes.has(UPDATE_NOTICE_PATH)).toBe(true)
    expect(calls.check).toHaveLength(2)
  })
})

describe('switching the check off and on again', () => {
  /** Mount with a late attach that gives each service its own source, whose notice names the attach number. */
  async function mountAttaching() {
    const mounted = await mount({ enabled: true, intervalHours: 1 })
    let attaches = 0
    mounted.ctx.inject(['delorunUpdateCheck'], (scope) => {
      attaches++
      const state: UpdateCheckState = { checked: Date.now(), notice: { ...NOTICE, disables: attaches } }
      scope.effect(() => scope.delorunUpdateCheck.attach(source(state).source))
    })
    await vi.advanceTimersByTimeAsync(0)
    return { ...mounted, attaches: () => attaches }
  }

  it('replaces the service: the old one is gone, a new one is provided and a late attach reaches it', async () => {
    const { ctx, fiber, attaches } = await mountAttaching()
    expect((await ctx.delorunUpdateCheck.notice())?.disables).toBe(1)
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.get('delorunUpdateCheck')).toBeUndefined()
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.get('delorunUpdateCheck')).toBeDefined()
    expect(attaches()).toBe(2)
    expect((await ctx.delorunUpdateCheck.notice())?.disables).toBe(2)
  })

  it('off then on in the same tick still ends with a live service that holds an attached check', async () => {
    const { ctx, fiber } = await mountAttaching()
    void fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: false })
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.get('delorunUpdateCheck')).toBeDefined()
    expect((await ctx.delorunUpdateCheck.notice())?.disables).toBeGreaterThanOrEqual(1)
  })
})

describe('a check in flight when the switch turns off', () => {
  it('is told to stop: its signal aborts when the row is switched off or the check is detached', async () => {
    const { ctx, fiber } = await mount({ enabled: true, intervalHours: 1 })
    const signals: AbortSignal[] = []
    const hanging: UpdateCheckSource = {
      read: async () => ({}),
      check: (_timeoutMs, signal) => { signals.push(signal); return new Promise<UpdateCheckState>(() => {}) },
      notes: async () => undefined,
    }
    ctx.inject(['delorunUpdateCheck'], (scope) => { scope.effect(() => scope.delorunUpdateCheck.attach(hanging)) })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    await fiber.update({ ...UPDATE_CHECK_DEFAULTS, intervalHours: 1, enabled: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('the notice route', () => {
  it('serves the attached check\'s notice uncached, and null without one', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const route = routes.get(UPDATE_NOTICE_PATH)!
    expect([route.methods, route.requestBody]).toEqual([['GET'], 'buffered'])
    const get = async () => route.fetch(new Request('http://harness.test/api', { method: 'GET' }))
    const empty = await get()
    expect([empty.status, empty.headers.get('cache-control'), empty.headers.get('content-type')]).toEqual([200, 'no-store', 'application/json'])
    expect(await empty.json()).toEqual({ notice: null })
    ctx.delorunUpdateCheck.attach(source({ checked: Date.now(), notice: NOTICE }).source)
    expect(await (await get()).json()).toEqual({ notice: NOTICE })
  })
})

describe('the notes route', () => {
  it('serves the attached check\'s verified notes uncached, and null without a check or without notes', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const route = routes.get(UPDATE_NOTES_PATH)!
    expect([route.methods, route.requestBody]).toEqual([['GET'], 'buffered'])
    const get = async () => route.fetch(new Request('http://harness.test/api', { method: 'GET' }))
    const empty = await get()
    expect([empty.status, empty.headers.get('cache-control'), empty.headers.get('content-type')]).toEqual([200, 'no-store', 'application/json'])
    expect(await empty.json()).toEqual({ version: null, notes: null })
    const dispose = ctx.delorunUpdateCheck.attach(source({ checked: Date.now(), notice: NOTICE }).source)
    expect(await (await get()).json()).toEqual({ version: null, notes: null })
    dispose()
    ctx.delorunUpdateCheck.attach(source({ checked: Date.now(), notice: NOTICE }, undefined, { version: NOTICE.release.delorun, text: 'Delorun 0.1.3\n- A change.\n' }).source)
    expect(await (await get()).json()).toEqual({ version: NOTICE.release.delorun, notes: 'Delorun 0.1.3\n- A change.\n' })
  })
})

describe('the channel route', () => {
  /** @returns the route's answer for a home whose launcher recorded `origins`, or for no home at all. */
  async function answer(origins: { channelOrigin?: string } | undefined, enabled: boolean) {
    const home = origins === undefined ? undefined : mkdtempSync(join(tmpdir(), 'delorun-channel-'))
    if (home !== undefined) {
      chmodSync(home, 0o700)
      await writeChannelRecord(home, origins!)
    }
    const context = new Context()
    context.provide('profileContext', { home } as never)
    const { routes } = await mountIn(context, { enabled })
    return (await routes.get(UPDATE_CHANNEL_PATH)!.fetch(new Request('http://harness.test/api'))).json()
  }

  it('names the host of the recorded channel origin, with the switch off or on', async () => {
    expect(await answer({ channelOrigin: 'http://127.0.0.1:18080' }, false)).toEqual({ host: '127.0.0.1:18080' })
    expect(await answer({ channelOrigin: 'http://127.0.0.1:18080' }, true)).toEqual({ host: '127.0.0.1:18080' })
  })

  it('answers null for the production channel and for a Host without a profile', async () => {
    expect(await answer({}, false)).toEqual({ host: null })
    expect(await answer(undefined, false)).toEqual({ host: null })
  })
})

describe('the switch in Settings', () => {
  it('update-check-switch-is-served-to-the-studio: the switch is a volatile field, so the Host describes the row and the sidebar reads it', () => {
    expect(Config.dict?.enabled?.meta.volatile).toBe(true)
  })
})

describe('who may turn the check off', () => {
  it('update-check-switch-refuses-devices: the row registers its switch as computer-only, so the reach policy refuses a device that turns it off', async () => {
    const ctx = new Context()
    const registered: object[] = []
    let removed = 0
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    ctx.provide('homeAuth', { registerComputerOnlySwitch: (target: object) => { registered.push(target); return () => { removed += 1 } } } as never)
    await ctx.plugin(UpdateCheck, { ...UPDATE_CHECK_DEFAULTS, enabled: false }).await()
    await vi.advanceTimersByTimeAsync(0)
    expect(registered).toEqual([{ ns: 'delorun-update-check', field: 'enabled', label: 'the release check' }])
    expect(registered[0]).toBe(UpdateCheck.UPDATE_CHECK_SWITCH)
    await ctx.fiber.dispose()
    expect(removed).toBe(1)
  })
})
