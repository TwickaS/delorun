/**
 * The `delorun-trust` row (`delorun/packages/bundle-local/src/trust.ts`): with its switch off it mounts nothing; on, it serves
 * the attached source's start bill, read once on attach, and then the last check's bill on `GET`, admits a device's read and no
 * device's check, coalesces concurrent checks into one run, answers failures with a typed code, and takes one source.
 */
import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { TRUST_BILL_PATH, TRUST_BILL_SCHEMA, TRUST_CHECK_PATH, type TrustBill } from '../src/client/trust-bill.ts'
import * as Trust from '../src/trust.ts'
import { Config, type TrustSource } from '../src/trust.ts'

/** A route the plugin registered. */
interface Route {
  readonly path: string
  readonly methods: readonly string[]
  readonly admitPeer?: (request: Request, peer: PeerScope) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * A bill of one stage.
 * @param stage - the stage.
 * @param generatedAt - when it was produced.
 * @returns the bill.
 */
function bill(stage: TrustBill['stage'], generatedAt = '2026-11-11T10:00:00Z'): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage,
    generatedAt,
    release: {
      version: '0.1.0', commit: null, manifestSha256: null, fileListSha256: null, root: null,
      launcher: { version: null, path: null }, lastFullHashAt: null, startCheck: null, signature: 'pass', files: 'pass',
    },
    releaseLog: { state: 'verified', lastAttempt: generatedAt, uncheckedSince: null },
    plugins: { status: 'known', entries: [] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
  }
}

/**
 * Mount the row over a stub Connection.
 * @param config - the row's configuration.
 * @returns the context, the routes it registered and the logger's warnings.
 */
async function mount(config: Partial<Trust.Config>) {
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
  const fiber = ctx.plugin(Trust, Config({ enabled: false, checkTimeoutSeconds: 600, ...config }))
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, routes }
}

/**
 * A route the row registered.
 * @param routes - the registered routes.
 * @param path - its path.
 * @returns the route.
 */
function route(routes: ReadonlyMap<string, Route>, path: string): Route {
  const found = routes.get(path)
  if (found === undefined) throw new Error(`no route ${path}`)
  return found
}

/**
 * A request to one of the routes, from the loopback studio.
 * @param path - the route.
 * @param method - the method.
 * @returns the request.
 */
function request(path: string, method: 'GET' | 'POST'): Request {
  return new Request(`http://127.0.0.1${path}`, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method })
}

/**
 * A source whose answers the test controls.
 * @param read - what `read` answers.
 * @param check - what `check` does.
 * @returns the source and its calls.
 */
function source(read: () => Promise<TrustBill>, check: () => Promise<TrustBill>) {
  const calls = { read: 0, check: 0, timeouts: [] as number[] }
  const value: TrustSource = {
    read: () => { calls.read++; return read() },
    refresh: read,
    check: (timeoutMs) => { calls.check++; calls.timeouts.push(timeoutMs); return check() },
  }
  return { source: value, calls }
}

/**
 * A response's JSON body.
 * @param response - the response.
 * @returns the parsed body.
 */
const body = async (response: Response): Promise<unknown> => response.json()

/**
 * A Peer of one principal.
 * @param kind - the principal's kind.
 * @returns the Peer.
 */
const peer = (kind: string): PeerScope => ({ principal: kind === 'owner' ? { kind: 'owner' } : { kind, deviceId: 'phone' } }) as never

describe('the switch', () => {
  it('off, the default and the parity value, mounts no service and no route', async () => {
    expect(Config({}).enabled).toBe(false)
    const { ctx, routes } = await mount({})
    expect(ctx.get('delorunTrust')).toBeUndefined()
    expect(routes.size).toBe(0)
  })

  it('checks in the background by default, after 45 s without a turn, and re-reads at least 60 s after a key moment', () => {
    expect(Config({ enabled: true })).toMatchObject({ autoCheck: true, idleSeconds: 45, keyMomentSeconds: 60 })
    for (const wrong of [{ idleSeconds: 4 }, { idleSeconds: 3601 }, { keyMomentSeconds: 59 }, { keyMomentSeconds: 601 }]) {
      expect(() => Config({ enabled: true, ...wrong })).toThrow()
    }
  })

  it('on, registers the bill route for GET and the check route for POST', async () => {
    const { routes } = await mount({ enabled: true })
    expect([...routes.values()].map(entry => [entry.path, entry.methods])).toEqual([[TRUST_BILL_PATH, ['GET']], [TRUST_CHECK_PATH, ['POST']]])
  })
})

describe('the bill route', () => {
  it('answers null while no source is attached', async () => {
    const { routes } = await mount({ enabled: true })
    const response = await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))
    expect({ status: response.status, body: await body(response), cache: response.headers.get('cache-control') }).toEqual({ status: 200, body: { bill: null, checks: null }, cache: 'no-store' })
  })

  it('reads the start bill once and answers it on every render, then the last check\'s bill', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const { source: attached, calls } = source(async () => bill('start'), async () => bill('verify', '2026-11-11T11:00:00Z'))
    ctx.delorunTrust.attach(attached)
    const read = async () => (await (await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))).json() as { bill: TrustBill }).bill
    expect((await read()).stage).toBe('start')
    expect((await read()).stage).toBe('start')
    expect(calls).toEqual({ read: 1, check: 0, timeouts: [] })
    const checked = await route(routes, TRUST_CHECK_PATH).fetch(request(TRUST_CHECK_PATH, 'POST'))
    expect(checked.status).toBe(200)
    expect((await read()).stage).toBe('verify')
    expect(calls).toEqual({ read: 1, check: 1, timeouts: [600_000] })
  })

  it('answers a failed read with TRUST_READ_FAILED and reads again next time', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const warn = vi.spyOn(ctx.logger, 'warn')
    let fail = true
    const { source: attached, calls } = source(async () => {
      if (fail) throw new Error('no record')
      return bill('start')
    }, async () => bill('verify'))
    ctx.delorunTrust.attach(attached)
    const failed = await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))
    expect({ status: failed.status, body: await body(failed) }).toEqual({ status: 500, body: { error: 'TRUST_READ_FAILED', message: 'the trust bill did not read: no record' } })
    expect(warn).toHaveBeenCalledWith('delorun-trust: the trust bill did not read: no record')
    fail = false
    expect((await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))).status).toBe(200)
    expect(calls.read).toBe(2)
  })

  it('admits a device\'s read and nothing else from a device', async () => {
    const { routes } = await mount({ enabled: true })
    const admit = route(routes, TRUST_BILL_PATH).admitPeer
    expect(admit?.(request(TRUST_BILL_PATH, 'GET'), peer('reach-device'))).toBe(true)
    expect(admit?.(new Request(`http://127.0.0.1${TRUST_BILL_PATH}`, { method: 'HEAD' }), peer('reach-device'))).toBe(false)
    expect(admit?.(request(TRUST_BILL_PATH, 'GET'), peer('share-viewer'))).toBe(false)
  })
})

describe('the check route', () => {
  it('admits a reach device with no unlock, as a free check that writes nothing, and refuses any other Peer', async () => {
    // Pins the `free` class of the check: a locked paired device runs it, and a share viewer still cannot.
    const { routes } = await mount({ enabled: true })
    const check = route(routes, TRUST_CHECK_PATH)
    const call = request(TRUST_CHECK_PATH, 'POST')
    expect(check.admitPeer?.(call, { principal: { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' } } as never)).toBe(true)
    // No source is attached here, so the service answers 503; what matters is that no unlock gate answered 403 first.
    expect((await check.fetch(call)).status).not.toBe(403)
    expect(check.admitPeer?.(request(TRUST_CHECK_PATH, 'POST'), peer('share-viewer') as never)).toBe(false)
  })

  it('coalesces concurrent checks into one run', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    let finish: (value: TrustBill) => void = () => {}
    const { source: attached, calls } = source(async () => bill('start'), () => new Promise<TrustBill>((resolve) => { finish = resolve }))
    ctx.delorunTrust.attach(attached)
    const check = route(routes, TRUST_CHECK_PATH)
    const first = check.fetch(request(TRUST_CHECK_PATH, 'POST'))
    const second = check.fetch(request(TRUST_CHECK_PATH, 'POST'))
    await vi.waitFor(() => { expect(calls.check).toBe(1) })
    finish(bill('verify'))
    const answers = await Promise.all([first, second])
    expect(answers.map(answer => answer.status)).toEqual([200, 200])
    expect(calls.check).toBe(1)
    // The run ended, so the next request runs again.
    finish = () => {}
    const third = check.fetch(request(TRUST_CHECK_PATH, 'POST'))
    await vi.waitFor(() => { expect(calls.check).toBe(2) })
    finish(bill('verify'))
    expect((await third).status).toBe(200)
  })

  it('gives each check the configured deadline', async () => {
    const { ctx, routes } = await mount({ enabled: true, checkTimeoutSeconds: 90 })
    const { source: attached, calls } = source(async () => bill('start'), async () => bill('verify'))
    ctx.delorunTrust.attach(attached)
    expect((await route(routes, TRUST_CHECK_PATH).fetch(request(TRUST_CHECK_PATH, 'POST'))).status).toBe(200)
    expect(calls.timeouts).toEqual([90_000])
    expect(() => Config({ enabled: true, checkTimeoutSeconds: 10 })).toThrow()
  })

  it('answers a failed check with TRUST_CHECK_FAILED and keeps the last bill', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { source: attached, calls } = source(async () => bill('start'), async () => { throw new Error('the log did not answer') })
    ctx.delorunTrust.attach(attached)
    const failed = await route(routes, TRUST_CHECK_PATH).fetch(request(TRUST_CHECK_PATH, 'POST'))
    expect({ status: failed.status, body: await body(failed) }).toEqual({ status: 500, body: { error: 'TRUST_CHECK_FAILED', message: 'the trust check failed: the log did not answer' } })
    expect(warn).toHaveBeenCalledWith('delorun-trust: the trust check failed: the log did not answer')
    const read = await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))
    expect((await read.json() as { bill: TrustBill }).bill.stage).toBe('start')
    // A failed run, such as one stopped at its deadline, is no longer in flight: the next request runs a new check.
    expect((await route(routes, TRUST_CHECK_PATH).fetch(request(TRUST_CHECK_PATH, 'POST'))).status).toBe(500)
    expect(calls.check).toBe(2)
  })

  it('answers TRUST_SOURCE_MISSING without a source and TRUST_JSON_REQUIRED without a JSON body', async () => {
    const { routes } = await mount({ enabled: true })
    const check = route(routes, TRUST_CHECK_PATH)
    const missing = await check.fetch(request(TRUST_CHECK_PATH, 'POST'))
    expect({ status: missing.status, error: (await missing.json() as { error: string }).error }).toEqual({ status: 503, error: 'TRUST_SOURCE_MISSING' })
    const bare = await check.fetch(new Request(`http://127.0.0.1${TRUST_CHECK_PATH}`, { method: 'POST' }))
    expect({ status: bare.status, error: (await bare.json() as { error: string }).error }).toEqual({ status: 415, error: 'TRUST_JSON_REQUIRED' })
  })
})

describe('the source', () => {
  it('takes one source, and another once the first is detached', async () => {
    const { ctx, routes } = await mount({ enabled: true })
    const first = source(async () => bill('start'), async () => bill('verify'))
    const detach = ctx.delorunTrust.attach(first.source)
    expect(() => ctx.delorunTrust.attach(first.source)).toThrow('delorun-trust: a source is already attached')
    detach()
    const answer = await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))
    expect(await answer.json()).toEqual({ bill: null, checks: null })
    ctx.delorunTrust.attach(source(async () => bill('verify'), async () => bill('verify')).source)
    const next = await route(routes, TRUST_BILL_PATH).fetch(request(TRUST_BILL_PATH, 'GET'))
    expect((await next.json() as { bill: TrustBill }).bill.stage).toBe('verify')
  })
})
