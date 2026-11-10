/**
 * The pin at the provider's real transport: a hop connects to the addresses the
 * guard approved, never to what its name resolves to when the socket opens. A
 * loopback listener stands in for the private service that a resolver answering
 * the guard one address and the connection another would carry a fetch to; the
 * provider under test is the mounted `http` fetch provider and the guard is the
 * mounted plugin, so the chain from the URL to the socket is the shipped one.
 *
 * The listener is the only network the specs touch: loopback, and a documentation
 * address that no host serves.
 */
import { createServer, type Server } from 'node:http'
import dns from 'node:dns'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import type { FetchGuard, FetchGuardAddress } from '@deepseek-ai/dsh-web-fetch-http'
import { FetchGuardRefusedError } from '../src/guard.ts'

/** The dns resolver as the provider calls it: every address of one hostname. */
type LookupAll = (hostname: string, options: { all: true, verbatim: true }) => Promise<Array<{ address: string, family: number }>>

/** A public-looking documentation address: what a resolver answers the guard for a name it means to rebind. */
const PUBLIC_ADDRESS = '203.0.113.10'

/** The body the loopback listener serves; returning it is the failure the pin prevents. */
const REBOUND_BODY = 'rebound-body'

let listener: Server
let port: number
/** How many requests the loopback listener accepted: one is a fetch that reached the private service. */
let served: number
let lookup: Mock<LookupAll>
const fibers: Array<Fiber> = []

/**
 * Mount upstream's web runtime and the `http` provider, then the plugin asked for.
 * @param guard - the `fetchGuard` service to mount: the shipped plugin with its switch on, or a stub that approves every address.
 * @returns the context the provider registered into.
 */
async function mount(guard: 'enabled' | FetchGuard): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
  // The fetch's own budget, kept below the unit test's 10 s so a refused or hung fetch reports as the fetch's error; no
  // case here waits for it, so it bounds only a loopback request that a busy machine delays.
  await ctx.plugin(await import('@deepseek-ai/dsh-web-fetch-http'), { timeoutMs: 5_000 })
  if (guard === 'enabled') fibers.push(await ctx.plugin(await import('../src/index.ts'), { enabled: true }))
  else fibers.push(await ctx.plugin({ name: 'stub-guard', apply: sibling => sibling.provide('fetchGuard', guard as never) }))
  return ctx
}

beforeEach(async () => {
  served = 0
  listener = createServer((_request, response) => {
    served++
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(REBOUND_BODY)
  })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  port = (listener.address() as AddressInfo).port
  lookup = vi.spyOn(dns.promises, 'lookup') as unknown as Mock<LookupAll>
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0, fibers.length).map(fiber => fiber.dispose()))
  await new Promise<void>(resolve => listener.close(() => { resolve() }))
})

describe('the pinned connection', () => {
  it('refuses the loopback destination of the audit probe before the listener sees a connection', async () => {
    const ctx = await mount('enabled')
    await expect(ctx.web.fetch({ url: `http://127.0.0.1:${String(port)}/` })).rejects.toBeInstanceOf(FetchGuardRefusedError)
    expect(served).toBe(0)
  })

  it('connects to the address the guard approved even when the name resolves nowhere', async () => {
    // The real guard refuses loopback, so a stub stands in for the resolver's
    // normal answer: what is under test here is the transport, not the matrix.
    const seen: FetchGuardAddress[][] = []
    const approving: FetchGuard = {
      async check(_url: URL, addresses: readonly FetchGuardAddress[]): Promise<void> {
        seen.push([...addresses])
      },
    }
    const ctx = await mount(approving)
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const result = await ctx.web.fetch({ url: `http://approved-only.test:${String(port)}/` })
    expect(result.body).toEqual({ kind: 'text', content: REBOUND_BODY })
    // The name has no system record: only the approved address could have connected.
    expect(seen).toEqual([[{ address: '127.0.0.1', family: 4 }]])
    expect(served).toBe(1)
  })

  it('refuses the connection a rebinding resolver would carry to loopback, and serves no body', async () => {
    // The controlled resolver answers the guard's lookup a public documentation
    // address and would answer the connection's lookup loopback, where the
    // listener serves a body. The pin connects to the approved address instead,
    // so nothing reaches the listener and no body can come back.
    const ctx = await mount('enabled')
    lookup.mockResolvedValue([{ address: PUBLIC_ADDRESS, family: 4 }])
    await expect(ctx.web.fetch({ url: `http://localhost:${String(port)}/` })).rejects.toThrow()
    expect(served).toBe(0)
  })
})
