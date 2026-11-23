/**
 * The `delorun-trust` row's background checks (`delorun/packages/bundle-local/src/trust.ts`, A628): once a source is
 * attached it waits for the studio to be idle, runs the full check at low priority, stops it when a turn starts, re-reads
 * plugins and changes after a key moment, and serves each row's freshness beside the bill.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { TRUST_BILL_PATH, TRUST_BILL_SCHEMA, TRUST_CHECK_PATH, trustRows, type TrustBill, type TrustChecks } from '../src/client/trust-bill.ts'
import * as Trust from '../src/trust.ts'
import { Config, type TrustCheckOptions, type TrustSource } from '../src/trust.ts'

/** A route the plugin registered. */
interface Route {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

const IDLE_MS = 5_000
const KEY_MS = 60_000
const START_AT = '2026-11-23T09:00:00.000Z'

/**
 * A bill.
 * @param overrides - what differs from a start bill whose start check hashed some files, with Check now through the launcher.
 * @returns the bill.
 */
function bill(overrides: Partial<TrustBill> = {}): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage: 'start',
    generatedAt: START_AT,
    release: {
      version: '0.1.0', commit: null, manifestSha256: null, fileListSha256: null, root: null,
      launcher: { version: '0.1.0', path: '/launcher' }, lastFullHashAt: null,
      startCheck: { at: START_AT, full: false, hashed: 12, files: 35_000 }, signature: 'pass', files: 'pass',
    },
    releaseLog: { state: 'verified', lastAttempt: START_AT, uncheckedSince: null },
    plugins: { status: 'known', entries: [] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
    checkNow: { via: 'launcher' },
    ...overrides,
  }
}

/** The bill a full check through the launcher produces. */
const verified = (): TrustBill => bill({ stage: 'verify', generatedAt: '2026-11-23T09:01:00.000Z', checkedBy: { via: 'launcher', seconds: 9.5 } })

/** A source whose checks the spec finishes by hand. */
function source(start: TrustBill = bill()) {
  const checks: { options: TrustCheckOptions | undefined, resolve: (value: TrustBill) => void, reject: (error: Error) => void }[] = []
  const refreshes: TrustBill[] = []
  let next = start
  const value: TrustSource = {
    read: async () => start,
    refresh: async () => { refreshes.push(next); return next },
    check: (_timeoutMs, options) => new Promise<TrustBill>((resolve, reject) => {
      checks.push({ options, resolve, reject })
      options?.signal?.addEventListener('abort', () => { reject(new Error('stopped')) })
    }),
  }
  return { source: value, checks, refreshes, setNext: (value: TrustBill) => { next = value } }
}

/**
 * Mount the row with its switch on over a stub Connection, attach a source, and let the start bill read.
 * @param attach - the source.
 * @param config - the row's other settings.
 * @returns the context, the service, the routes and the logger's warnings.
 */
async function mount(attach: TrustSource, config: Partial<Trust.Config> = {}) {
  const ctx = new Context()
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
  } as never)
  const fiber = ctx.plugin(Trust, Config({ enabled: true, idleSeconds: IDLE_MS / 1000, keyMomentSeconds: KEY_MS / 1000, ...config }))
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse('2026-11-23T09:00:30.000Z') })
  ctx.delorunTrust.attach(attach)
  await vi.advanceTimersByTimeAsync(0)
  return { ctx, service: ctx.delorunTrust, routes }
}

/**
 * The bill route's answer.
 * @param routes - the registered routes.
 * @returns the bill and the rows' freshness.
 */
async function read(routes: ReadonlyMap<string, Route>): Promise<{ bill: TrustBill, checks: TrustChecks }> {
  const route = routes.get(TRUST_BILL_PATH)
  if (route === undefined) throw new Error('no bill route')
  return (await route.fetch(new Request(`http://127.0.0.1${TRUST_BILL_PATH}`))).json() as Promise<{ bill: TrustBill, checks: TrustChecks }>
}

/**
 * Emit an upstream event on the context as the agent loop or the loader does.
 * @param ctx - the context.
 * @param name - the event.
 * @param payload - its payload.
 */
function emit(ctx: Context, name: string, payload?: object): void {
  const send: (name: string, payload?: object) => void = ctx.emit.bind(ctx)
  send(name, payload)
}

afterEach(() => { vi.useRealTimers() })

describe('the background full check', () => {
  it('waits for the idle wait, then runs through the source at low priority, and makes the release Verified', async () => {
    const { source: value, checks } = source()
    const { routes } = await mount(value)
    const waiting = await read(routes)
    expect(waiting.checks.release.full).toEqual({ state: 'waiting' })
    expect(trustRows(waiting.bill, waiting.checks)[0]?.state).toBe('checking')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(checks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks).toHaveLength(1)
    expect(checks[0]?.options?.lowPriority).toBe(true)
    const running = await read(routes)
    expect(running.checks.release).toMatchObject({ running: true, full: { state: 'running' } })
    expect(running.checks.plugins.running).toBe(true)
    checks[0]?.resolve(verified())
    await vi.advanceTimersByTimeAsync(0)
    const done = await read(routes)
    expect(done.checks.release).toMatchObject({ running: false, full: { state: 'done' }, at: '2026-11-23T09:00:35.000Z' })
    expect(trustRows(done.bill, done.checks)[0]?.state).toBe('verified')
  })

  it('stops when a turn starts, and runs again from the start after the next idle wait', async () => {
    const { source: value, checks } = source()
    const { ctx, routes } = await mount(value)
    const agent = { id: 'chat' }
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    emit(ctx, 'agent/status', { agent, status: 'running' })
    expect(checks[0]?.options?.signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect((await read(routes)).checks.release.full).toEqual({ state: 'waiting' })
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3)
    expect(checks).toHaveLength(1)
    emit(ctx, 'agent/status', { agent, status: 'idle' })
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(checks).toHaveLength(2)
    expect(checks[1]?.options?.signal?.aborted).toBe(false)
  })

  it('does not start while a turn that began before the attach still runs', async () => {
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    const fiber = ctx.plugin(Trust, Config({ enabled: true, idleSeconds: IDLE_MS / 1000 }))
    await fiber.await()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const agent = {}
    emit(ctx, 'agent/status', { agent, status: 'running' })
    const { source: value, checks } = source()
    ctx.delorunTrust.attach(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    expect(checks).toHaveLength(0)
    emit(ctx, 'agent/disposed', { agent })
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(checks).toHaveLength(1)
  })

  it('is never stopped by a turn once a person joined it with Check now', async () => {
    const { source: value, checks } = source()
    const { ctx, routes } = await mount(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    const check = routes.get(TRUST_CHECK_PATH)?.fetch(new Request(`http://127.0.0.1${TRUST_CHECK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    emit(ctx, 'agent/status', { agent: {}, status: 'running' })
    expect(checks[0]?.options?.signal?.aborted).toBe(false)
    checks[0]?.resolve(verified())
    const answer = await check
    expect(answer?.status).toBe(200)
    expect(checks).toHaveLength(1)
  })

  it('says why it cannot run when no launcher can run it, and never runs by itself', async () => {
    const { source: value, checks } = source(bill({ checkNow: { via: 'host', reason: 'no-launcher' } }))
    const { routes } = await mount(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3)
    expect(checks).toHaveLength(0)
    const answer = await read(routes)
    expect(answer.checks.release.full).toEqual({ state: 'unavailable', reason: 'no-launcher' })
    expect(trustRows(answer.bill, answer.checks)[0]?.state).toBe('checked-at-start')
  })

  it('says it is switched off when the row turns the background check off', async () => {
    const { source: value, checks } = source()
    const { routes } = await mount(value, { autoCheck: false })
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3)
    expect(checks).toHaveLength(0)
    expect((await read(routes)).checks.release.full).toEqual({ state: 'unavailable', reason: 'off' })
  })

  it('does not run when the start check already hashed every file', async () => {
    const start = bill()
    const { source: value, checks } = source({ ...start, release: { ...start.release, startCheck: { at: START_AT, full: true, hashed: 35_000, files: 35_000 } } })
    const { routes } = await mount(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3)
    expect(checks).toHaveLength(0)
    const answer = await read(routes)
    expect(answer.checks.release).toMatchObject({ full: { state: 'done' }, at: START_AT })
    expect(trustRows(answer.bill, answer.checks)[0]?.state).toBe('verified')
  })

  it('keeps the last bill and says why when the check fails', async () => {
    const { source: value, checks } = source()
    const { routes } = await mount(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    checks[0]?.reject(new Error('the launcher did not finish within 600 s and was stopped'))
    await vi.advanceTimersByTimeAsync(0)
    const answer = await read(routes)
    expect(answer.bill.stage).toBe('start')
    expect(answer.checks.release.full).toEqual({ state: 'unavailable', reason: 'failed', detail: 'the launcher did not finish within 600 s and was stopped' })
    expect(trustRows(answer.bill, answer.checks)[0]?.state).toBe('checked-at-start')
  })
})

describe('the schedule\'s start', () => {
  it('waits for the first start bill that reads, and schedules the full check then', async () => {
    const { source: value, checks } = source()
    let fail = true
    const flaky: TrustSource = { ...value, read: async () => { if (fail) throw new Error('no record yet'); return bill() } }
    const { routes } = await mount(flaky)
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(checks).toHaveLength(0)
    fail = false
    const first = await read(routes)
    expect(first.checks.release.full).toEqual({ state: 'waiting' })
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(checks).toHaveLength(1)
  })

  it('starts with no full check to wait for when Check now finished before the start bill read', async () => {
    const { source: value, checks } = source()
    let release: (bill: TrustBill) => void = () => {}
    const slow: TrustSource = { ...value, read: () => new Promise<TrustBill>((resolve) => { release = resolve }) }
    const { routes } = await mount(slow)
    const check = routes.get(TRUST_CHECK_PATH)?.fetch(new Request(`http://127.0.0.1${TRUST_CHECK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    await vi.advanceTimersByTimeAsync(0)
    checks[0]?.resolve(verified())
    expect((await check)?.status).toBe(200)
    release(bill())
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    expect(checks).toHaveLength(1)
    expect((await read(routes)).checks.release.full).toEqual({ state: 'done' })
  })
})

describe('key moments', () => {
  it('read plugins and changes again once, after the loader reloads, and keep the release as it was', async () => {
    const start = bill({ checkNow: { via: 'host', reason: 'no-launcher' } })
    const { source: value, refreshes, setNext } = source(start)
    const { ctx, routes } = await mount(value)
    const plugin = { name: 'delorun-plugin-x', source: 'registry', version: '1.0.0', integrity: null, commit: null, match: 'match', warnings: [], criticalAdvisories: [] } as const
    setNext({ ...start, generatedAt: '2026-11-23T09:05:00.000Z', plugins: { status: 'known', entries: [plugin] } })
    emit(ctx, 'loader/volatile-update')
    await vi.advanceTimersByTimeAsync(KEY_MS / 2)
    emit(ctx, 'loader/volatile-update')
    await vi.advanceTimersByTimeAsync(KEY_MS - 1)
    expect(refreshes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshes).toHaveLength(1)
    const answer = await read(routes)
    expect(answer.bill.plugins.entries.map(entry => entry.name)).toEqual(['delorun-plugin-x'])
    expect(answer.bill.generatedAt).toBe(START_AT)
    expect(answer.checks.plugins.at).toBe('2026-11-23T09:02:00.000Z')
    expect(answer.checks.changes.at).toBe('2026-11-23T09:02:00.000Z')
  })

  it('never overwrite the bill of a Check now that finished while they read', async () => {
    const start = bill({ checkNow: { via: 'host', reason: 'no-launcher' } })
    const { source: value, checks, setNext } = source(start)
    let finishRefresh: (bill: TrustBill) => void = () => {}
    const slow: TrustSource = { ...value, refresh: () => new Promise<TrustBill>((resolve) => { finishRefresh = resolve }) }
    const { ctx, routes } = await mount(slow)
    setNext(start)
    emit(ctx, 'loader/volatile-update')
    await vi.advanceTimersByTimeAsync(KEY_MS)
    const check = routes.get(TRUST_CHECK_PATH)?.fetch(new Request(`http://127.0.0.1${TRUST_CHECK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    await vi.advanceTimersByTimeAsync(0)
    checks[0]?.resolve(verified())
    expect((await check)?.status).toBe(200)
    finishRefresh(start)
    await vi.advanceTimersByTimeAsync(0)
    expect((await read(routes)).bill.stage).toBe('verify')
  })

  it('wait for a running turn to end before reading again', async () => {
    const { source: value, refreshes } = source(bill({ checkNow: { via: 'host', reason: 'no-launcher' } }))
    const { ctx } = await mount(value)
    const agent = {}
    emit(ctx, 'agent/status', { agent, status: 'running' })
    emit(ctx, 'loader/volatile-update')
    await vi.advanceTimersByTimeAsync(KEY_MS * 5)
    expect(refreshes).toHaveLength(0)
    emit(ctx, 'agent/status', { agent, status: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshes).toHaveLength(1)
  })

  it('ask for another full check after an update is applied, which waits for idle', async () => {
    const { source: value, checks } = source()
    const { service } = await mount(value)
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    checks[0]?.resolve(verified())
    await vi.advanceTimersByTimeAsync(0)
    service.keyMoment('release')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(checks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks).toHaveLength(2)
  })
})
