/**
 * Specs of the real-browser routes: the arrival rule, the access level of each route (the away permission needs an
 * unlocked device), and their answers over a real chat's grant.
 */
import type { ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { registerGrants, type RealBrowserGrants } from '../src/grant.ts'
import { registerRealBrowserRoutes } from '../src/routes.ts'
import { REAL_BROWSER_ROUTES } from '../src/wire.ts'

interface Route {
  readonly fetch: (request: Request) => Promise<Response>
  readonly admitPeer?: (request: Request, peer: object) => boolean
}

interface FakeConnection {
  readonly hook: (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  /** Run a route as the Connection does: `admitPeer` first for a Peer, then `fetch` with the same request. */
  readonly call: (path: string, body: unknown, principal?: object) => Promise<Response>
  readonly admits: (path: string, principal: object) => boolean
}

const DAY = 86_400_000

/** A chat with a real session log, and its grants. */
async function chat(): Promise<{ agent: Agent, grants: RealBrowserGrants }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const grants = await registerGrants(ctx, () => 1_000)
  const agent = await ctx.agentLoop.create(SessionId('chat-1'), { provider: 'mock', model: 'mock' })
  return { agent, grants }
}

/**
 * Register the routes on a fake Connection whose `homeAuth` places every request on one listener.
 * @param grants - the grants.
 * @param agent - the one open chat.
 * @param listener - the listener `homeAuth` reports.
 * @returns the fake Connection.
 */
function routesOver(grants: RealBrowserGrants, agent: Agent, listener: string | undefined): FakeConnection {
  let hook: FakeConnection['hook'] | undefined
  const routes = new Map<string, Route>()
  const homeAuth = {
    arrivalOf: () => ({ listener }),
    dangerousMode: () => false,
    unlockModeEnabled: () => false,
    elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined),
  }
  const ctx = {
    on: (_name: string, registered: FakeConnection['hook']) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? homeAuth : name === 'agents' ? { get: (id: string) => (id === agent.id ? agent : undefined) } : undefined),
    connection: { fetch: { register: (route: Route & { path: string }) => { routes.set(route.path, route) } } },
  }
  registerRealBrowserRoutes(ctx as never, grants, { awayMs: () => 7 * DAY, now: () => 1_000 })
  const request = (path: string, body: unknown): Request => new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  return {
    hook: (incoming, response, next) => hook!(incoming, response, next),
    admits: (path, principal) => routes.get(path)?.admitPeer?.(request(path, {}), { principal }) === true,
    call: async (path, body, principal) => {
      const route = routes.get(path)!
      const incoming = request(path, body)
      if (principal !== undefined && route.admitPeer?.(incoming, { principal }) !== true) return new Response('forbidden', { status: 403 })
      return route.fetch(incoming)
    },
  }
}

const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })

describe('the real-browser routes', () => {
  it('refuse a request the home cannot place, or a foreign Host on the loopback listener, and let the computer and a reach device through', async () => {
    const { agent, grants } = await chat()
    for (const [listener, host, expected] of [
      ['loopback', '127.0.0.1:4500', true],
      ['loopback', 'home.example.ts.net', false],
      [undefined, '127.0.0.1:4500', false],
      ['reach-tailscale-private', 'home.example.ts.net', true],
    ] as const) {
      const routes = routesOver(grants, agent, listener)
      for (const path of Object.values(REAL_BROWSER_ROUTES)) {
        const answered: { body?: string } = {}
        const response = { writeHead: () => undefined, end: (body: string) => { answered.body = body } }
        let reached = false
        await routes.hook({ url: path, headers: { host } }, response as never, async () => { reached = true })
        expect({ listener, host, path, reached }).toEqual({ listener, host, path, reached: expected })
        if (!expected) expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
      }
    }
  })

  it('let any approved device read and end a grant, and answer a locked device ELEVATION_REQUIRED on the away permission', async () => {
    const { agent, grants } = await chat()
    grants.grant(agent.session, { kind: 'approval', askedSeq: SessionSeq(1) })
    const routes = routesOver(grants, agent, 'reach-tailscale-private')
    for (const path of [REAL_BROWSER_ROUTES.state, REAL_BROWSER_ROUTES.end]) {
      expect(routes.admits(path, device('locked-phone')), path).toBe(true)
      expect(routes.admits(path, { kind: 'sdk' }), path).toBe(false)
    }
    // Pins the unlock check: the away permission widens the grant to runs the person did not start.
    const locked = await routes.call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true }, device('locked-phone'))
    expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect(grants.view(agent.session).awayUntil).toBeNull()
    expect((await routes.call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true }, { kind: 'sdk' })).status).toBe(403)
    // Pins the grace exclusion: a phone in its approval grace typed no code or PIN, so it cannot widen the grant.
    const grace = await routes.call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true }, device('grace-phone'))
    expect([grace.status, await grace.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect(grants.view(agent.session).awayUntil).toBeNull()
    expect(routes.admits(REAL_BROWSER_ROUTES.end, device('grace-phone'))).toBe(true)
    expect((await routes.call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true }, device('unlocked-phone'))).status).toBe(200)
  })

  it('answer the state, the away permission and the end, and refuse what they cannot do', async () => {
    const { agent, grants } = await chat()
    const routes = routesOver(grants, agent, 'loopback')
    const call = (path: string, body: unknown) => routes.call(path, body)
    for (const body of ['not json', { sessionId: 'chat-1', extra: 1 }, { sessionId: 'x'.repeat(2_000) }]) {
      expect((await call(REAL_BROWSER_ROUTES.state, body)).status).toBe(400)
    }
    expect((await call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1' })).status).toBe(400)
    expect((await call(REAL_BROWSER_ROUTES.state, { sessionId: 'other' })).status).toBe(404)
    await expect((await call(REAL_BROWSER_ROUTES.state, { sessionId: 'chat-1' })).json()).resolves.toEqual({ live: false, awayUntil: null })
    // Pins the away rule's precondition: no grant, nothing to widen.
    const ungranted = await call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true })
    expect([ungranted.status, await ungranted.json()]).toEqual([409, expect.objectContaining({ error: 'NO_GRANT' })])
    grants.grant(agent.session, { kind: 'approval', askedSeq: SessionSeq(1) })
    await expect((await call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: true })).json()).resolves.toEqual({ live: true, awayUntil: 1_000 + 7 * DAY })
    await expect((await call(REAL_BROWSER_ROUTES.away, { sessionId: 'chat-1', on: false })).json()).resolves.toEqual({ live: true, awayUntil: null })
    await expect((await call(REAL_BROWSER_ROUTES.end, { sessionId: 'chat-1' })).json()).resolves.toEqual({ live: false, awayUntil: null })
    await expect((await call(REAL_BROWSER_ROUTES.end, { sessionId: 'chat-1' })).json()).resolves.toEqual({ live: false, awayUntil: null })
    expect(agent.session.snapshotEvents().map(event => event.type).filter(type => type.startsWith('real-browser/')))
      .toEqual(['real-browser/granted', 'real-browser/away', 'real-browser/away', 'real-browser/ended'])
  })
})
