/**
 * The `reach` service over a bare Cordis context with a recording `homeAuth` and `connection` and a fake `tailscale`
 * that keeps a serve configuration: an option starts only when its row is on, after binding its fixed listener port; a
 * failed check leaves it `blocked` with the rule removed, the listeners closed and nothing served; any other failure
 * leaves it `failed`; Funnel found while ready stops it; and disposal stops the provider, closes the listeners and stops
 * serving, in that order, logging a removal that failed.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { createServer, type Server } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ReachListener } from '@deepseek-ai/dsh-client-connection'
import { LISTENER_PORT_RANGE, type ReachStateChange } from '@delorun/contract-reach-providers'
import { ReachService, type Config } from '../src/service.ts'
import { TailscalePrivateProvider } from '../src/provider.ts'
import { chooseListenerPort, isPortFree } from '../src/front.ts'
import type { TailscaleRunner } from '../src/tailscale.ts'
import { fakeTailscale, ownRule, type FakeTailscale } from './fake-tailscale.ts'

/** Every server `node:net` created, so a spec can raise an error on the fixed port's server. */
const createdServers = vi.hoisted((): unknown[] => [])
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => { const server = actual.createServer(...args); createdServers.push(server); return server } }
})

const HOST = 'home.example.ts.net'
const ADDRESS = `https://${HOST}`

/**
 * The configuration with Tailscale private on.
 * @param listenerPort - the fixed listener port.
 * @param serveCheckIntervalMs - the check interval.
 * @returns the configuration.
 */
function on(listenerPort: number, serveCheckIntervalMs = 60_000): Config {
  return { enabled: true, tailscalePrivate: { enabled: true, address: ADDRESS, servePort: 443, listenerPort, serveCheckIntervalMs, elevationMinutes: 20 } }
}

/** A world of fakes and what they recorded, in order. */
interface World {
  readonly ctx: Context
  readonly events: string[]
  readonly states: ReachStateChange[]
  readonly tailscale: FakeTailscale
  readonly run: TailscaleRunner
  readonly logs: string[]
}

/** The routes the fake web server holds. */
/** What the faked `homeAuth.owner()` answers: undefined for an unclaimed home. */
const OWNER: { current: object | undefined; failure: Error | undefined } = { current: { claimedAt: 1 }, failure: undefined }
const routes = new Map<string, (request: object, response: object) => void>()

/** Servers a test holds a port with. */
const held: Server[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(held.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
})

function world(options: { readonly open?: () => Promise<Partial<ReachListener>>; readonly answers?: FakeTailscale['answers']; readonly serveRefuses?: Error } = {}): World {
  const ctx = new Context()
  const events: string[] = []
  const states: ReachStateChange[] = []
  const logs: string[] = []
  ctx.on('reach/state', (change) => { states.push(change) })
  ctx.provide('webServer', {
    register: (route: { readonly path: string; readonly handler: (request: object, response: object) => void }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  ctx.provide('homeAuth', {
    owner: () => OWNER.failure === undefined ? Promise.resolve(OWNER.current) : Promise.reject(OWNER.failure),
    arrivalOf: (request: { readonly headers: { readonly host?: string } }) => ({
      listener: request.headers.host === HOST ? 'reach-tailscale-private' : request.headers.host === 'rebind.example' ? undefined : 'loopback',
      host: request.headers.host,
      source: '127.0.0.1',
    }),
    serve: (served: { readonly listener: string; readonly factor: string; readonly elevationMinutes?: number; readonly computerUser?: string }) => {
      if (options.serveRefuses !== undefined) throw options.serveRefuses
      events.push(`serve ${served.listener} ${served.factor} user=${String(served.computerUser)}${served.elevationMinutes === 20 ? '' : ` minutes=${String(served.elevationMinutes)}`}`)
      return () => { events.push('unserve') }
    },
    // The service supplies the Tailscale local API check the home corroborates a forwarded address with (A667). It is
    // not recorded in `events`: that log pins the order of the Tailscale calls and the listener's lifecycle, and this
    // registration is neither.
    supplyTailnetCheck: (_check: ((address: string) => Promise<unknown>) | undefined) => () => {},
  } as never)
  ctx.provide('connection', {
    // The studio's cookie stands for the loopback credential and a reach session alike; `foreign` fails the fence.
    requestRejection: (request: { readonly headers: { readonly cookie?: string } }) => (request.headers.cookie === 'studio' ? undefined : request.headers.cookie === 'foreign' ? 403 : 401),
    openReachListener: async () => {
      events.push('open')
      const listener = await (options.open ?? (async () => ({ address: { port: 4321 } })))()
      return { ...listener, close: async () => { events.push('close') } }
    },
  } as never)
  for (const level of ['warn', 'error'] as const) vi.spyOn(ctx.logger, level).mockImplementation((message: unknown) => { logs.push(`${level} ${String(message)}`) })
  const tailscale = fakeTailscale(HOST, options.answers)
  const run: TailscaleRunner = async (args) => {
    events.push(`tailscale ${args.join(' ')}`)
    return tailscale.run(args)
  }
  return { ctx, events, states, tailscale, run, logs }
}

/** Mount the service with the world's `tailscale`. */
async function mount(w: World, config: Config): Promise<{ dispose(): Promise<unknown> }> {
  class Reach extends ReachService {
    protected override tailscale(): TailscaleRunner {
      return w.run
    }
  }
  const fiber = await w.ctx.plugin(Reach, config)
  return fiber
}

/**
 * Hold a port as another program would.
 * @returns the port.
 */
async function hold(): Promise<number> {
  const port = await chooseListenerPort(LISTENER_PORT_RANGE)
  const server = createServer()
  held.push(server)
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => { resolve() }) })
  return port
}

/** The calls that write or remove a serve rule. */
const writes = (w: World): string[] => w.events.filter(event => event.startsWith('tailscale serve --'))

describe('the reach service', () => {
  it('starts an option whose row is on after binding its fixed port, and stops it in order, confirming the removal', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, on(port))
    expect(w.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
    // Pins the bind before the rule: while the rule exists, this home holds its target port.
    await expect(isPortFree(port)).resolves.toBe(false)
    await fiber.dispose()
    expect(w.events).toEqual([
      'tailscale status --json', 'serve reach-tailscale-private tailnet-membership user=me@example.com', 'open', 'tailscale version', 'tailscale status --json', 'tailscale serve status --json',
      `tailscale serve --bg --https=443 http://127.0.0.1:${String(port)}`,
      'tailscale serve status --json', 'tailscale serve --https=443 off', 'tailscale serve status --json', 'close', 'unserve',
    ])
    expect(w.tailscale.config).toEqual({ TCP: {}, Web: {} })
    await expect(isPortFree(port)).resolves.toBe(true)
    expect(w.states.map(change => change.state)).toEqual(['starting', 'ready', 'stopping', 'off'])
    expect(w.logs).toEqual([])
  })

  it('starts nothing while the row is off, which is the default', async () => {
    const w = world()
    const fiber = await mount(w, { enabled: true, tailscalePrivate: { enabled: false, address: '', servePort: 443, listenerPort: 0, serveCheckIntervalMs: 60_000, elevationMinutes: 15 } })
    expect(w.events).toEqual([])
    expect(w.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'off' }])
    expect(() => w.ctx.reach.register(new TailscalePrivateProvider(w.run))).toThrow(/has a provider already/)
    const funnel = { ...new TailscalePrivateProvider(w.run), option: 'tailscale-funnel' as const, resolve: () => undefined, start: () => Promise.resolve(), stop: () => Promise.resolve(), check: () => Promise.resolve({ kind: 'ok' as const }), visibility: () => '' }
    const off = w.ctx.reach.register(funnel)
    expect(w.ctx.reach.status().map(status => status.option)).toEqual(['tailscale-private', 'tailscale-funnel'])
    off()
    off()
    expect(w.ctx.reach.status().map(status => status.option)).toEqual(['tailscale-private'])
    await fiber.dispose()
  })

  it('refuses a fixed port another program holds, removing the rule an earlier run left there', async () => {
    const w = world()
    const port = await hold()
    w.tailscale.config = ownRule(HOST, 443, port)
    const fiber = await mount(w, on(port))
    expect(w.ctx.reach.status()).toEqual([expect.objectContaining({ state: 'blocked', cause: 'PORT_CONFLICT', detail: expect.stringContaining(`127.0.0.1:${String(port)}`) })])
    // Pins the refusal and the removal: no rule is written, and the stale rule that now forwards to the other program is gone.
    expect(writes(w)).toEqual(['tailscale serve --https=443 off'])
    expect(w.tailscale.config).toEqual({ TCP: {}, Web: {} })
    expect(w.events).not.toContain('open')
    expect(w.events.at(-1)).toBe('unserve')
    await fiber.dispose()
  })

  it('says so when the rule on a port another program holds cannot be removed', async () => {
    const w = world({ answers: { 'serve off': { code: 1, stdout: '', stderr: 'denied' } } })
    const port = await hold()
    w.tailscale.config = ownRule(HOST, 443, port)
    const fiber = await mount(w, on(port))
    expect(w.ctx.reach.status()[0]).toMatchObject({ state: 'blocked', cause: 'PORT_CONFLICT', detail: expect.stringMatching(/holds 127\.0\.0\.1:\d+.*tailscale serve --https=443 off failed \(denied\)/) })
    await fiber.dispose()
  })

  it('leaves a failed check blocked, with the rule removed before the listeners close, and nothing served', async () => {
    const w = world({ answers: { 'serve set': { code: 1, stdout: '', stderr: 'Access denied' } } })
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, on(port))
    expect(w.ctx.reach.status()).toEqual([expect.objectContaining({ state: 'blocked', cause: 'TAILSCALE_SERVE_NOT_PERMITTED' })])
    expect(w.events.slice(-3)).toEqual(['tailscale serve status --json', 'close', 'unserve'])
    expect(w.states.at(-1)).toEqual({ option: 'tailscale-private', state: 'blocked', cause: 'TAILSCALE_SERVE_NOT_PERMITTED' })
    await expect(isPortFree(port)).resolves.toBe(true)
    await fiber.dispose()
  })

  it('refuses to start while Funnel is on for the address, and removes the rule', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    w.tailscale.config = { ...ownRule(HOST, 443, port), AllowFunnel: { [`${HOST}:443`]: true } }
    const fiber = await mount(w, on(port))
    // Pins the Funnel refusal at start: the studio is never put on the public internet.
    expect(w.ctx.reach.status()[0]).toMatchObject({ state: 'blocked', cause: 'TAILSCALE_FUNNEL_ON', detail: expect.stringContaining('tailscale funnel --https=443 off') })
    expect(writes(w)).toEqual(['tailscale serve --https=443 off'])
    expect(w.events.slice(-2)).toEqual(['close', 'unserve'])
    await fiber.dispose()
  })

  it('removes a rule this home does not own and confirms it is gone before writing its own', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    w.tailscale.config = ownRule(HOST, 443, 1234)
    const fiber = await mount(w, on(port))
    expect(writes(w)).toEqual(['tailscale serve --https=443 off', `tailscale serve --bg --https=443 http://127.0.0.1:${String(port)}`])
    expect(w.tailscale.config).toEqual(ownRule(HOST, 443, port))
    await fiber.dispose()
    const stuck = world({ answers: { 'serve off': { code: 1, stdout: '', stderr: 'denied' } } })
    stuck.tailscale.config = ownRule(HOST, 443, 1234)
    await (await mount(stuck, on(port))).dispose()
    // Pins the removal's result check: a foreign rule that stays blocks the start, and the state says why once.
    expect(stuck.states.find(change => change.state === 'blocked')).toEqual({ option: 'tailscale-private', state: 'blocked', cause: 'TAILSCALE_SERVE_CONFLICT' })
    expect(writes(stuck).filter(event => event.includes('--bg'))).toEqual([])
  })

  it('leaves any other failure failed, trying the removal anyway', async () => {
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const opened = world({ open: () => Promise.reject(new Error('no provider')) })
    await (await mount(opened, on(port))).dispose()
    expect(opened.ctx.get('reach')).toBeUndefined()
    expect(opened.states.at(-1)).toMatchObject({ state: 'failed' })
    expect(opened.events).toEqual(['tailscale status --json', 'serve reach-tailscale-private tailnet-membership user=me@example.com', 'open', 'tailscale serve status --json', 'unserve'])
    const unbound = world({ open: async () => Promise.resolve({ address: undefined }) })
    await (await mount(unbound, on(port))).dispose()
    expect(unbound.states.at(-1)).toMatchObject({ state: 'failed' })
    const thrown = world({ open: () => Promise.reject('a string') })
    await (await mount(thrown, on(port))).dispose()
    expect(thrown.states.at(-1)).toMatchObject({ state: 'failed' })
    // A missing tailscale serves nothing, so its failed removal adds nothing to the sentence.
    const missing = world({ answers: { version: { code: null, stdout: '', stderr: '' }, 'serve status': { code: null, stdout: '', stderr: '' } } })
    await (await mount(missing, on(port))).dispose()
    expect(missing.states.find(change => change.state === 'blocked')).toMatchObject({ cause: 'TAILSCALE_NOT_INSTALLED' })
  })

  it('reports a removal that fails while stopping, after closing the listeners and stopping serving', async () => {
    const w = world({ answers: { 'serve off': { code: 1, stdout: '', stderr: 'denied' } } })
    const fiber = await mount(w, on(await chooseListenerPort(LISTENER_PORT_RANGE)))
    await fiber.dispose()
    expect(w.events.slice(-2)).toEqual(['close', 'unserve'])
    expect(w.states.at(-1)?.state).toBe('off')
    // Pins the stop's report: a rule left behind is logged with the command that failed.
    expect(w.logs).toEqual([expect.stringMatching(/^error reach: tailscale-private stopped, but tailscale serve --https=443 off failed \(denied\).*\(TAILSCALE_SERVE_CONFLICT\)$/)])
    const broken = world()
    const brokenFiber = await mount(broken, on(await chooseListenerPort(LISTENER_PORT_RANGE)))
    broken.tailscale.answers['serve status'] = () => { throw new Error('runner broke') }
    await brokenFiber.dispose()
    expect(broken.logs).toEqual(['error reach: tailscale-private stopped, but the serve rule could not be removed: runner broke (TAILSCALE_SERVE_CONFLICT)'])
    const thrown = world()
    const thrownFiber = await mount(thrown, on(await chooseListenerPort(LISTENER_PORT_RANGE)))
    thrown.tailscale.answers['serve status'] = () => { throw 'gone' }
    await thrownFiber.dispose()
    expect(thrown.logs).toEqual(['error reach: tailscale-private stopped, but the serve rule could not be removed: gone (TAILSCALE_SERVE_CONFLICT)'])
  })

  it('stops serving when Funnel is turned on while ready, and marks an unreadable status degraded', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, on(port, 1_000))
    const reads = (): number => w.events.filter(event => event === 'tailscale serve status --json').length
    const tick = async (): Promise<void> => {
      const before = reads()
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => { expect(reads()).toBe(before + 1) })
    }
    await tick()
    expect(w.ctx.reach.status()[0]?.state).toBe('ready')
    w.tailscale.answers['serve status'] = { code: 1, stdout: '', stderr: 'tailscaled stopped' }
    await tick()
    await vi.waitFor(() => { expect(w.ctx.reach.status()[0]?.state).toBe('degraded') })
    await tick()
    expect(w.ctx.reach.status()[0]).toMatchObject({ state: 'degraded', cause: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve status failed: tailscaled stopped' })
    delete w.tailscale.answers['serve status']
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(w.ctx.reach.status()[0]?.state).toBe('ready') })
    // Pins the periodic Funnel check: Funnel turned on after start stops serving at the next check.
    w.tailscale.config = { ...w.tailscale.config, AllowFunnel: { [`${HOST}:443`]: true } }
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(w.ctx.reach.status()[0]?.state).toBe('blocked') })
    expect(w.ctx.reach.status()[0]).toMatchObject({ cause: 'TAILSCALE_FUNNEL_ON', detail: expect.stringContaining('then restart Delorun') })
    expect(w.tailscale.config.TCP).toEqual({})
    expect(w.events.slice(-2)).toEqual(['close', 'unserve'])
    await expect(isPortFree(port)).resolves.toBe(true)
    const after = w.events.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.events).toHaveLength(after)
    await fiber.dispose()
    expect(w.states.map(change => change.state)).toEqual(['starting', 'ready', 'degraded', 'ready', 'blocked', 'stopping', 'off'])
    expect(w.events).toHaveLength(after)
  })

  it('runs one check at a time, logs a check that throws, and stops checking when disposed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = world()
    const fiber = await mount(w, on(await chooseListenerPort(LISTENER_PORT_RANGE), 1_000))
    const pending = Promise.withResolvers<undefined>()
    const check = vi.spyOn(TailscalePrivateProvider.prototype, 'check').mockImplementation(async () => {
      await pending.promise
      throw new Error('check broke')
    })
    try {
      await vi.advanceTimersByTimeAsync(3_000)
      expect(check).toHaveBeenCalledTimes(1)
      pending.resolve(undefined)
      await vi.waitFor(() => { expect(w.logs).toEqual(['warn reach: the tailscale-private check failed: check broke']) })
      check.mockRejectedValueOnce('text')
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => { expect(w.logs).toHaveLength(2) })
      expect(w.logs[1]).toBe('warn reach: the tailscale-private check failed: text')
      // A check that answers after disposal began changes nothing.
      const late = Promise.withResolvers<{ kind: 'blocked'; error: never }>()
      check.mockImplementationOnce(() => late.promise)
      await vi.advanceTimersByTimeAsync(1_000)
      const disposed = fiber.dispose()
      late.resolve({ kind: 'blocked', error: undefined as never })
      await disposed
      expect(w.states.map(change => change.state)).toEqual(['starting', 'ready', 'stopping', 'off'])
    } finally {
      check.mockRestore()
    }
  })

  it('applies new rows to a running home one change at a time, and answers nothing while the C16 switch is off', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, { enabled: true, tailscalePrivate: { ...on(port).tailscalePrivate, enabled: false } })
    expect(w.ctx.reach.mounted).toBe(true)
    const rows = (enabled: boolean, address = ADDRESS) => ({ tailscalePrivate: { ...on(port).tailscalePrivate, enabled, address: address as never } })
    // Two applies in a row run one after the other: the second stops what the first started before it starts again.
    const [first, second] = await Promise.all([w.ctx.reach.apply(rows(true)), w.ctx.reach.apply(rows(true))])
    expect(first).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
    expect(second).toEqual(first)
    expect(w.events.filter(event => event === 'open' || event === 'close')).toEqual(['open', 'close', 'open'])
    await expect(isPortFree(port)).resolves.toBe(false)
    await expect(w.ctx.reach.apply(rows(false))).resolves.toEqual([{ option: 'tailscale-private', state: 'off' }])
    expect(w.tailscale.config).toEqual({ TCP: {}, Web: {} })
    await expect(isPortFree(port)).resolves.toBe(true)
    // A row that does not resolve leaves the option blocked with the resolver's code.
    await expect(w.ctx.reach.apply(rows(true, 'http://not-https.example'))).resolves.toEqual([expect.objectContaining({ option: 'tailscale-private', state: 'blocked' })])
    expect(w.logs.some(line => line.startsWith('warn reach: tailscale-private blocked ('))).toBe(true)
    // A resolver that fails otherwise fails the apply, and the next apply still runs.
    const broken = { tailscalePrivate: { get enabled(): boolean { throw new Error('unreadable row') } } } as never
    await expect(w.ctx.reach.apply(broken)).rejects.toThrow('unreadable row')
    await expect(w.ctx.reach.apply(rows(false))).resolves.toEqual([{ option: 'tailscale-private', state: 'off' }])
    await fiber.dispose()
    const off = world()
    const unmounted = await mount(off, { ...on(port), enabled: false })
    expect(off.ctx.reach.mounted).toBe(false)
    await expect(off.ctx.reach.apply(rows(true))).resolves.toBeUndefined()
    await unmounted.dispose()
  })

  it('mounts nothing while the C16 switch is off', async () => {
    const w = world()
    routes.clear()
    const fiber = await mount(w, { ...on(1), enabled: false })
    expect(w.ctx.reach.status()).toEqual([])
    expect(routes.size).toBe(0)
    expect(w.events).toEqual([])
    await fiber.dispose()
  })

  it('answers the reach status to the studio on loopback and on the reach address, and to nothing else', async () => {
    const w = world()
    const fiber = await mount(w, on(await chooseListenerPort(LISTENER_PORT_RANGE)))
    const answer = (host: string, method = 'GET', cookie: string | null = 'studio'): Promise<{ status: number; body: unknown }> => {
      const handler = routes.get('/delorun/reach/status')
      if (handler === undefined) throw new Error('no status route')
      return new Promise((resolve) => {
        const reply: { status: number; headers: Map<string, string> } = { status: 0, headers: new Map() }
        handler({ method, headers: { host, ...(cookie === null ? {} : { cookie }) } }, {
          setHeader: (name: string, value: string) => { reply.headers.set(name, value) },
          set statusCode(value: number) { reply.status = value },
          end: (text: string) => { resolve({ status: reply.status, body: JSON.parse(text) }) },
        })
      })
    }
    expect(await answer('127.0.0.1:3080')).toEqual({ status: 200, body: { available: true, hasOwner: true, options: [{ option: 'tailscale-private', state: 'ready', address: ADDRESS }] } })
    expect((await answer(HOST)).status).toBe(200)
    // Pins the arrival check: a rebinding name reaches the loopback port and reads nothing.
    expect(await answer('rebind.example')).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    expect((await answer('127.0.0.1:3080', 'POST')).status).toBe(405)
    // Pins the credential: a local program without the studio's cookie, and a phone that has not signed in, read
    // neither the tailnet address nor any option's state.
    expect(await answer('127.0.0.1:3080', 'GET', null)).toMatchObject({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(await answer('home.example.ts.net', 'GET', null)).toMatchObject({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect(await answer('127.0.0.1:3080', 'GET', 'foreign')).toMatchObject({ status: 403, body: { error: 'ORIGIN_MISMATCH' } })
    OWNER.current = undefined
    expect(await answer('127.0.0.1:3080')).toMatchObject({ status: 200, body: { hasOwner: false } })
    OWNER.current = { claimedAt: 1 }
    for (const refused of [await answer('127.0.0.1:3080', 'GET', null), await answer('home.example.ts.net', 'GET', null)]) expect(JSON.stringify(refused.body)).not.toContain('example.ts.net')
    await fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('leaves an option whose listener home auth refuses failed instead of starting, holding nothing', async () => {
    const w = world({ serveRefuses: new Error('an unlock lasts 20 minutes, more than the 1-minute cap on one unlock') })
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, on(port))
    expect(w.ctx.reach.status()).toEqual([expect.objectContaining({ option: 'tailscale-private', state: 'failed', detail: expect.stringContaining('1-minute cap') })])
    expect(w.states.map(change => change.state)).toEqual(['starting', 'failed'])
    expect(w.events).not.toContain('open')
    expect(writes(w)).toEqual([])
    await expect(isPortFree(port)).resolves.toBe(true)
    await fiber.dispose()
  })

  it('logs a fixed port server error after it bound instead of raising it', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    createdServers.length = 0
    const fiber = await mount(w, on(port))
    const front = (createdServers as Server[]).find(server => server.listening && (server.address() as { port: number }).port === port)
    expect(front).toBeDefined()
    expect(() => front?.emit('error', new Error('accept failed'))).not.toThrow()
    expect(w.logs).toContainEqual(expect.stringContaining('fixed port server failed: accept failed'))
    await fiber.dispose()
  })

  it('answers the reach status with 500 when its handler fails, and logs why', async () => {
    const w = world()
    const fiber = await mount(w, on(await chooseListenerPort(LISTENER_PORT_RANGE)))
    OWNER.failure = new Error('owner.json is readable by others')
    try {
      const handler = routes.get('/delorun/reach/status')
      const reply = await new Promise<{ status: number; body: string }>((resolve) => {
        const answer = { status: 0, body: '' }
        handler?.({ method: 'GET', headers: { host: '127.0.0.1:3080', cookie: 'studio' } }, {
          setHeader: () => {},
          headersSent: false,
          set statusCode(value: number) { answer.status = value },
          end: (text: string) => { answer.body = text; resolve(answer) },
        })
      })
      expect(reply.status).toBe(500)
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'STATUS_UNAVAILABLE' })
      expect(w.logs).toContainEqual(expect.stringContaining('owner.json is readable by others'))
    } finally {
      OWNER.failure = undefined
    }
    await fiber.dispose()
  })

  it('does not count a serve rule as removed when tailscale timed out answering', async () => {
    const w = world()
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    const fiber = await mount(w, on(port))
    w.tailscale.answers['serve status'] = { code: null, stdout: '', stderr: 'tailscale did not finish within 15 seconds', failure: 'timeout' }
    await fiber.dispose()
    // Pins the error mapping: a hung tailscaled is not a missing binary, so the rule may still stand and the stop says so.
    expect(w.logs.some(line => line.startsWith('error reach: tailscale-private stopped, but') && line.includes('did not finish within 15 seconds'))).toBe(true)
  })

  it('uses the system tailscale by default', () => {
    class Exposed extends ReachService {
      runner(): TailscaleRunner {
        return this.tailscale()
      }
    }
    expect(new Exposed(new Context(), on(1)).runner()).toBeTypeOf('function')
  })
})
