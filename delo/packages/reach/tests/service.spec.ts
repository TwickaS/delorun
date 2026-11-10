/**
 * The `reach` service over a bare Cordis context with a recording `homeAuth` and `connection`: an option starts only
 * when its row is on, a failed check leaves it `blocked` with the listener closed and nothing served, any other failure
 * leaves it `failed`, and disposal stops the provider, closes the listener and stops serving, in that order.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ReachListener } from '@deepseek-ai/dsh-client-connection'
import type { ReachStateChange } from '@delo/contract-reach-providers'
import { ReachService, type Config } from '../src/service.ts'
import { TailscalePrivateProvider } from '../src/provider.ts'
import type { TailscaleResult, TailscaleRunner } from '../src/tailscale.ts'

const ADDRESS = 'https://home.example.ts.net'
const ON: Config = { enabled: true, tailscalePrivate: { enabled: true, address: ADDRESS, servePort: 443 } }

/** A world of fakes and what they recorded, in order. */
interface World {
  readonly ctx: Context
  readonly events: string[]
  readonly states: ReachStateChange[]
}

/** The routes the fake web server holds. */
const routes = new Map<string, (request: object, response: object) => void>()

function world(options: { readonly open?: () => Promise<Partial<ReachListener>>; readonly serve?: TailscaleResult; readonly off?: TailscaleResult } = {}): World & { readonly run: TailscaleRunner } {
  const ctx = new Context()
  const events: string[] = []
  const states: ReachStateChange[] = []
  ctx.on('reach/state', (change) => { states.push(change) })
  ctx.provide('webServer', {
    register: (route: { readonly path: string; readonly handler: (request: object, response: object) => void }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  ctx.provide('homeAuth', {
    arrivalOf: (request: { readonly headers: { readonly host?: string } }) => ({
      listener: request.headers.host === 'home.example.ts.net' ? 'reach-tailscale-private' : request.headers.host === 'rebind.example' ? undefined : 'loopback',
      host: request.headers.host,
      source: '127.0.0.1',
    }),
    serve: (served: { readonly listener: string; readonly factor: string }) => {
      events.push(`serve ${served.listener} ${served.factor}`)
      return () => { events.push('unserve') }
    },
  } as never)
  ctx.provide('connection', {
    openReachListener: async () => {
      events.push('open')
      const listener = await (options.open ?? (async () => ({ address: { port: 4321 } })))()
      return { ...listener, close: async () => { events.push('close') } }
    },
  } as never)
  const status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'home.example.ts.net.' }, CertDomains: ['home.example.ts.net'] }), stderr: '' }
  const run: TailscaleRunner = async (args) => {
    events.push(`tailscale ${args.join(' ')}`)
    if (args[0] === 'status') return status
    if (args[0] === 'serve' && args.at(-1) === 'off') return options.off ?? { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'serve') return options.serve ?? { code: 0, stdout: '', stderr: '' }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
  return { ctx, events, states, run }
}

/** Mount the service with the world's `tailscale`. */
async function mount(w: ReturnType<typeof world>, config: Config): Promise<{ dispose(): Promise<unknown> }> {
  class Reach extends ReachService {
    protected override tailscale(): TailscaleRunner {
      return w.run
    }
  }
  const fiber = await w.ctx.plugin(Reach, config)
  return fiber
}

describe('the reach service', () => {
  it('starts an option whose row is on, and stops it in order', async () => {
    const w = world()
    const fiber = await mount(w, ON)
    expect(w.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'ready', address: ADDRESS }])
    await fiber.dispose()
    expect(w.events).toEqual([
      'serve reach-tailscale-private tailnet-membership', 'open', 'tailscale version', 'tailscale status --json',
      'tailscale serve --bg --https=443 http://127.0.0.1:4321', 'tailscale serve --https=443 off', 'close', 'unserve',
    ])
    expect(w.states.map(change => change.state)).toEqual(['starting', 'ready', 'stopping', 'off'])
  })

  it('starts nothing while the row is off, which is the default', async () => {
    const w = world()
    const fiber = await mount(w, { enabled: true, tailscalePrivate: { enabled: false, address: '', servePort: 443 } })
    expect(w.events).toEqual([])
    expect(w.ctx.reach.status()).toEqual([{ option: 'tailscale-private', state: 'off' }])
    expect(() => w.ctx.reach.register(new TailscalePrivateProvider(w.run))).toThrow(/has a provider already/)
    const funnel = { ...new TailscalePrivateProvider(w.run), option: 'tailscale-funnel' as const, resolve: () => undefined, start: () => Promise.resolve(), stop: () => Promise.resolve(), visibility: () => '' }
    const off = w.ctx.reach.register(funnel)
    expect(w.ctx.reach.status().map(status => status.option)).toEqual(['tailscale-private', 'tailscale-funnel'])
    off()
    off()
    expect(w.ctx.reach.status().map(status => status.option)).toEqual(['tailscale-private'])
    await fiber.dispose()
  })

  it('leaves a failed check blocked, with the listener closed and nothing served', async () => {
    const w = world({ serve: { code: 1, stdout: '', stderr: 'Access denied' } })
    const fiber = await mount(w, ON)
    expect(w.ctx.reach.status()).toEqual([expect.objectContaining({ state: 'blocked', cause: 'TAILSCALE_SERVE_NOT_PERMITTED' })])
    expect(w.events.slice(-2)).toEqual(['close', 'unserve'])
    expect(w.states.at(-1)).toEqual({ option: 'tailscale-private', state: 'blocked', cause: 'TAILSCALE_SERVE_NOT_PERMITTED' })
    await fiber.dispose()
  })

  it('leaves any other failure failed', async () => {
    const opened = world({ open: () => Promise.reject(new Error('no provider')) })
    await (await mount(opened, ON)).dispose()
    expect(opened.ctx.get('reach')).toBeUndefined()
    expect(opened.states.at(-1)).toMatchObject({ state: 'failed' })
    expect(opened.events).toEqual(['serve reach-tailscale-private tailnet-membership', 'open', 'unserve'])
    const unbound = world({ open: async () => Promise.resolve({ address: undefined }) })
    await (await mount(unbound, ON)).dispose()
    expect(unbound.states.at(-1)).toMatchObject({ state: 'failed' })
    const thrown = world({ open: () => Promise.reject('a string') })
    await (await mount(thrown, ON)).dispose()
    expect(thrown.states.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('closes the listener and stops serving even when the provider fails to stop', async () => {
    const w = world({ off: { code: 1, stdout: '', stderr: '' } })
    const fiber = await mount(w, ON)
    await fiber.dispose()
    expect(w.events.slice(-2)).toEqual(['close', 'unserve'])
    expect(w.states.at(-1)?.state).toBe('off')
  })

  it('mounts nothing while the C16 switch is off', async () => {
    const w = world()
    routes.clear()
    const fiber = await mount(w, { ...ON, enabled: false })
    expect(w.ctx.reach.status()).toEqual([])
    expect(routes.size).toBe(0)
    expect(w.events).toEqual([])
    await fiber.dispose()
  })

  it('answers the reach status to the studio on loopback and on the reach address, and to nothing else', async () => {
    const w = world()
    const fiber = await mount(w, ON)
    const answer = (host: string, method = 'GET'): { status: number; body: unknown } => {
      const handler = routes.get('/delo/reach/status')
      if (handler === undefined) throw new Error('no status route')
      const reply: { status: number; body: unknown; headers: Map<string, string> } = { status: 0, body: undefined, headers: new Map() }
      handler({ method, headers: { host } }, {
        setHeader: (name: string, value: string) => { reply.headers.set(name, value) },
        set statusCode(value: number) { reply.status = value },
        end: (text: string) => { reply.body = JSON.parse(text) },
      })
      return { status: reply.status, body: reply.body }
    }
    expect(answer('127.0.0.1:3080')).toEqual({ status: 200, body: { available: true, options: [{ option: 'tailscale-private', state: 'ready', address: ADDRESS }] } })
    expect(answer('home.example.ts.net').status).toBe(200)
    // Pins the arrival check: a rebinding name reaches the loopback port and reads nothing.
    expect(answer('rebind.example')).toMatchObject({ status: 421, body: { error: 'HOST_MISMATCH' } })
    expect(answer('127.0.0.1:3080', 'POST').status).toBe(405)
    await fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('uses the system tailscale by default', () => {
    class Exposed extends ReachService {
      runner(): TailscaleRunner {
        return this.tailscale()
      }
    }
    expect(new Exposed(new Context(), ON).runner()).toBeTypeOf('function')
  })
})
