/**
 * The guard at the provider seam. The provider under test is the mounted
 * `http` fetch provider of `@deepseek-ai/dsh-web-fetch-http`, so the spec
 * proves the whole chain: the provider resolves the hop's hostname with
 * `node:dns` before the connection, hands the addresses to the mounted
 * `fetchGuard`, and a refusal propagates as the guard's typed error before
 * undici's `fetch` is ever called. A hop the guard approves is sent on the
 * agent that pins the connection to the approved addresses, so the transport
 * cannot resolve the name a second time. `node:dns` and `undici` are mocked, so
 * no connection is attempted: the network is never touched.
 *
 * A mount-harness note the diagnosis of WP2.18 turned up: cordis unregisters a
 * provided service eagerly — synchronously at the `dispose()` call, before the
 * returned promise resolves — so the harness keeps each mounted fiber alive
 * and disposes it once in `afterEach`. Disposing at mount time would unmount
 * the guard before the first hop, and the provider would correctly (not
 * wrongly) read its absence.
 */
import dns, { type LookupAddress, type LookupAllOptions, type LookupOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici'
import { LOCAL_FETCH_PROVIDER_ID, type FetchGuard, type FetchGuardAddress } from '@deepseek-ai/dsh-web-fetch-http'
import { FetchGuardService } from '../src/index.ts'
import { FetchGuardRefusedError } from '../src/guard.ts'

/** Every pinned agent the provider built, in creation order, and whether it released each. */
const agents = vi.hoisted(() => [] as Array<{ options: { connect?: { lookup?: LookupFunction } }, destroyed: boolean }>)

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: class {
    readonly options: { connect?: { lookup?: LookupFunction } }

    destroyed = false

    constructor(options: { connect?: { lookup?: LookupFunction } }) {
      this.options = options
      agents.push(this)
    }

    async destroy(): Promise<void> {
      this.destroyed = true
    }
  },
}))

/** The mocked transport: one entry per hop the provider would have connected. */
const fetchMock = vi.mocked(undiciFetch)

/**
 * Spy on the resolver the provider calls for every address of one hostname. The typed view of `dns.promises` selects
 * the all-addresses overload the provider calls, which the spy then takes as its signature.
 * @returns the spy, which each test answers.
 */
function spyOnLookup() {
  const resolver: { lookup: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> } = dns.promises
  return vi.spyOn(resolver, 'lookup')
}

let lookup: ReturnType<typeof spyOnLookup>

/** How a test mounts the guard: on with the switch, on with it off, absent, or mounted later in the test. */
type GuardMount = 'enabled' | 'disabled' | 'absent' | 'later'

/** The fibers of the tests' mounts, each disposed exactly once after its test. */
const fibers: Array<Fiber> = []

/** Mount upstream's web runtime and the provider plugin, and the guard as asked. */
async function mount(guard: GuardMount): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
  await ctx.plugin(await import('@deepseek-ai/dsh-web-fetch-http'), {})
  // The shipped entry is the module's `apply`, so the mount is what a bundle
  // row performs: with the switch off it provides no service at all.
  const plugin = await import('../src/index.ts')
  if (guard === 'enabled') fibers.push(await ctx.plugin(plugin, { enabled: true }))
  if (guard === 'disabled') fibers.push(await ctx.plugin(plugin, { enabled: false }))
  return ctx
}

/** A plain 200 text response, as undici would answer a simple GET. */
function ok(body: string): UndiciResponse {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }) as UndiciResponse
}

beforeEach(() => {
  fetchMock.mockReset()
  agents.splice(0, agents.length)
  lookup = spyOnLookup()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0, fibers.length).map(fiber => fiber.dispose()))
})

describe('the provider seam with the guard mounted and on', () => {
  it('the provider plugin and the guard plugin mount as siblings, and the context answers the service', async () => {
    const ctx = await mount('enabled')
    expect(ctx.get('fetchGuard')).toBeInstanceOf(FetchGuardService)
  })

  it('a stub guard plugin mounted as a sibling is what the provider consults', async () => {
    const ctx = await mount('absent')
    // The seam is plugin-agnostic: any plugin that provides `fetchGuard` guards
    // the provider's hops. A stub records the hops it sees and refuses none.
    const seen: string[] = []
    const stub: FetchGuard = {
      async check(url: URL, addresses: readonly FetchGuardAddress[]): Promise<void> {
        seen.push(`${url.host}=${addresses.map(address => address.address).join(',')}`)
      },
    }
    fibers.push(await ctx.plugin({ name: 'stub-guard', apply: sibling => sibling.provide('fetchGuard', stub as never) }))
    lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
    fetchMock.mockResolvedValue(ok('served'))
    const result = await ctx.web.fetch({ url: 'http://stub-public.test:8080/' })
    expect(result.statusCode).toBe(200)
    expect(seen).toEqual(['stub-public.test:8080=203.0.113.10'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves the hostname and refuses a private target before any connection', async () => {
    const ctx = await mount('enabled')
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    const refusal = ctx.web.fetch({ url: 'http://guard-private.test:8080/' })
    await expect(refusal).rejects.toBeInstanceOf(FetchGuardRefusedError)
    await refusal.catch((error: unknown) => {
      const typed = error as FetchGuardRefusedError
      expect(typed.code).toBe('private')
      expect(typed.host).toBe('guard-private.test')
      expect(typed.message).toBe('web fetch refused: the host "guard-private.test" is a private-network address, which web_fetch does not fetch')
    })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith('guard-private.test', { all: true, verbatim: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies an IP-literal destination without a lookup and refuses it before any connection', async () => {
    const ctx = await mount('enabled')
    const refusal = ctx.web.fetch({ url: 'http://10.1.2.3:8080/' })
    await expect(refusal).rejects.toBeInstanceOf(FetchGuardRefusedError)
    await refusal.catch((error: unknown) => {
      const typed = error as FetchGuardRefusedError
      expect(typed.code).toBe('private')
      expect(typed.host).toBe('10.1.2.3')
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets a public-looking destination through the classifier to the transport', async () => {
    const ctx = await mount('enabled')
    lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
    fetchMock.mockResolvedValue(ok('served'))
    const result = await ctx.web.fetch({ url: 'http://guard-public.test:8080/' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'served' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).hostname).toBe('guard-public.test')
  })

  it('sends the approved hop on the agent pinning the connection to the approved addresses', async () => {
    const ctx = await mount('enabled')
    lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }])
    fetchMock.mockResolvedValue(ok('served'))
    await ctx.web.fetch({ url: 'http://guard-pinned.test:8080/' })
    const [agent] = agents
    expect(agent).toBeDefined()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ dispatcher: agent })
    // The agent resolves the name itself, from the approved set only: the
    // transport never asks the system resolver a second time. Each call below
    // shapes its answer the way `node:net` asks: the address list under `all`,
    // the single address string plus its family otherwise.
    const agentLookup = agent?.options.connect?.lookup
    const pinned = async (options: LookupOptions, hostname = 'guard-pinned.test'): Promise<unknown> =>
      await new Promise((resolve, reject) => {
        agentLookup?.(hostname, options, (error, address) => {
          if (error !== null) reject(error)
          else resolve(address)
        })
      })
    expect(await pinned({ all: true })).toEqual([{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }])
    // Without `all`, node's resolver contract is the single address string plus its family.
    expect(await pinned({ family: 6 })).toEqual('2001:db8::10')
    expect(await pinned({ family: 4 })).toEqual('203.0.113.10')
    // A family no approved address carries falls back to the approved set rather than failing the hop.
    expect(await pinned({ all: true, family: 0 })).toEqual([{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }])
    await expect(pinned({ all: true }, 'never-approved.test')).rejects.toThrow('no address was approved')
    // The agent lives for one fetch: the provider releases it when the fetch ends.
    expect(agent?.destroyed).toBe(true)
  })

  it('checks a redirect hop: a hostname rebinding to a refused address refuses the second hop before it connects', async () => {
    const ctx = await mount('enabled')
    lookup.mockImplementationOnce(async () => [{ address: '203.0.113.10', family: 4 }])
    lookup.mockImplementationOnce(async () => [{ address: '127.0.0.1', family: 4 }])
    fetchMock.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/hop' } }) as UndiciResponse)
    const refusal = ctx.web.fetch({ url: 'http://guard-rebind.test:8080/start' })
    await expect(refusal).rejects.toBeInstanceOf(FetchGuardRefusedError)
    await refusal.catch((error: unknown) => {
      const typed = error as FetchGuardRefusedError
      expect(typed.code).toBe('loopback')
      expect(typed.host).toBe('guard-rebind.test')
    })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a guard mounted after the provider is read from the next hop on', async () => {
    const ctx = await mount('later')
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    fetchMock.mockResolvedValue(ok('served'))
    // No guard yet: the hop runs unguarded and no lookup runs.
    await ctx.web.fetch({ url: 'http://guard-private.test:8080/' })
    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Mounted afterwards, the same provider consults the guard on the next hop.
    fibers.push(await ctx.plugin(FetchGuardService, { enabled: true }))
    await expect(ctx.web.fetch({ url: 'http://guard-private.test:8080/' })).rejects.toThrow(FetchGuardRefusedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a resolution failure is a provider error, not a guard refusal', async () => {
    const ctx = await mount('enabled')
    lookup.mockRejectedValue(new Error('resolver down'))
    await expect(ctx.web.fetch({ url: 'http://guard-private.test:8080/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the provider seam with the switch off', () => {
  it('provides no service: the hop runs unguarded with no lookup, byte-identical to upstream', async () => {
    const ctx = await mount('disabled')
    expect(ctx.get('fetchGuard')).toBeUndefined()
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    fetchMock.mockResolvedValue(ok('served'))
    const result = await ctx.web.fetch({ url: 'http://guard-private.test:8080/' })
    expect(result.statusCode).toBe(200)
    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher')
    expect(agents).toEqual([])
  })
})

describe('the provider seam with no guard mounted', () => {
  it('runs unguarded: no lookup, no check and no pinning happen', async () => {
    const ctx = await mount('absent')
    expect(ctx.get('fetchGuard')).toBeUndefined()
    fetchMock.mockResolvedValue(ok('served'))
    const result = await ctx.web.fetch({ url: 'http://guard-public.test:8080/' })
    expect(result.statusCode).toBe(200)
    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher')
    expect(agents).toEqual([])
  })
})
