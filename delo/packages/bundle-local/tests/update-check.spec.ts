/**
 * The `delo-update-check` row (`delo/packages/bundle-local/src/update-check.ts`): with its switch off it mounts nothing,
 * so no check can run; on, it runs an attached check at start when one is due and then on its interval, never waits
 * for one, and serves the notice over one exact Connection route.
 */
import { Context } from '@deepseek-ai/cordis'
import { UPDATE_NOTICE_PATH, type UpdateNotice } from '@delo/contract-update-report'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as UpdateCheck from '../src/update-check.ts'
import { Config, MAX_INTERVAL_HOURS, UPDATE_CHECK_DEFAULTS, type UpdateCheckSource, type UpdateCheckState } from '../src/update-check.ts'

const HOUR = 3_600_000
/** A semantic version as the notice's types brand it. */
type SemanticVersion = UpdateNotice['release']['delo']
const semantic = (text: string): SemanticVersion => text as SemanticVersion
/**
 * Validate a configuration as the Loader does, with the fields the row leaves out.
 * @param value - the row's configuration.
 * @returns the validated configuration.
 */
const parse = (value: Partial<UpdateCheck.Config>): UpdateCheck.Config => Config(value as UpdateCheck.Config)
const NOTICE: UpdateNotice = {
  running: { delo: semantic('0.1.0'), dsh: semantic('0.2.2') },
  release: { delo: semantic('0.1.1'), dsh: semantic('0.2.2'), channel: 'stable', security: true },
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
async function mount(config: Partial<UpdateCheck.Config>) {
  const ctx = new Context()
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: {
      register: (route: Route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  await ctx.plugin(UpdateCheck, { ...UPDATE_CHECK_DEFAULTS, enabled: false, ...config })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, routes }
}

/**
 * A source whose answers the test sets.
 * @param read - what `read` answers.
 * @param check - what `check` answers.
 * @returns the source and its calls.
 */
function source(read: UpdateCheckState, check: UpdateCheckState = read) {
  const calls = { read: 0, check: [] as number[] }
  const value: UpdateCheckSource = {
    read: async () => { calls.read++; return read },
    check: async (timeoutMs) => { calls.check.push(timeoutMs); return check },
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
    expect(parse({}).enabled).toBe(false)
    const { ctx, routes } = await mount({})
    expect(ctx.get('deloUpdateCheck')).toBeUndefined()
    expect(routes.size).toBe(0)
  })

  it('validates the interval and the deadline', () => {
    expect(parse({ enabled: true })).toEqual({ enabled: true, intervalHours: 24, timeoutSeconds: 15 })
    expect(() => parse({ intervalHours: 0 })).toThrow()
    expect(() => parse({ intervalHours: MAX_INTERVAL_HOURS + 1 })).toThrow()
    expect(() => parse({ timeoutSeconds: 0 })).toThrow()
  })
})

describe('the schedule', () => {
  it('checks at once when no check ran, then each interval, with the row\'s deadline', async () => {
    const { ctx } = await mount({ enabled: true, intervalHours: 2, timeoutSeconds: 7 })
    const { source: attached, calls } = source({}, { checked: Date.now() })
    ctx.deloUpdateCheck.attach(attached)
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
    ctx.deloUpdateCheck.attach(attached)
    await vi.advanceTimersByTimeAsync(23 * HOUR - 1)
    expect(calls.check).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.check).toHaveLength(1)
  })

  it('keeps its interval when the source fails, and logs why', async () => {
    const { ctx } = await mount({ enabled: true })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const reads: number[] = []
    ctx.deloUpdateCheck.attach({ read: async () => { reads.push(1); throw new Error('no record') }, check: async () => Promise.reject('offline') })
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledWith('delo-update-check: the update check failed: no record')
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(warn).toHaveBeenLastCalledWith('delo-update-check: the update check failed: offline')
    expect(reads).toHaveLength(1)
  })

  it('stops when detached, and refuses a second check while one is attached', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({ checked: Date.now() })
    const detach = ctx.deloUpdateCheck.attach(attached)
    expect(() => ctx.deloUpdateCheck.attach(source({}).source)).toThrow('a check is already attached')
    await vi.advanceTimersByTimeAsync(0)
    detach()
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(calls.check).toEqual([])
    expect(() => ctx.deloUpdateCheck.attach(source({}).source)).not.toThrow()
  })

  it('schedules nothing after it was detached while the first read ran', async () => {
    const { ctx } = await mount({ enabled: true })
    const { source: attached, calls } = source({})
    const detach = ctx.deloUpdateCheck.attach(attached)
    detach()
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(calls).toEqual({ read: 1, check: [] })
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
    ctx.deloUpdateCheck.attach(source({ checked: Date.now(), notice: NOTICE }).source)
    expect(await (await get()).json()).toEqual({ notice: NOTICE })
  })
})
