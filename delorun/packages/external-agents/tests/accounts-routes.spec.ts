/**
 * The account routes (`src/accounts/routes.ts`): any approved device reads the figures and reading never starts a
 * check; "Check now" needs the computer or an unlocked device, and a locked phone is refused before anything starts.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExternalAgentName } from '../src/contract.ts'
import { registerAccountRoutes } from '../src/accounts/routes.ts'
import { createAgentAccounts, type AgentAccountsService } from '../src/accounts/service.ts'
import { accountsFilePath } from '../src/accounts/store.ts'
import { ACCOUNT_ROUTES } from '../src/accounts/wire.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A route as the fake Connection holds it. */
interface Route {
  readonly fetch: (request: Request) => Promise<Response>
  readonly admitPeer?: (request: Request, peer: object) => boolean
}

/** The routes over a fake Connection, and the checks the fake gate saw. */
interface Mounted {
  readonly checks: ExternalAgentName[]
  /** The service the routes call. */
  readonly accounts: AgentAccountsService
  /** The context members the registration used. */
  readonly used: ReadonlySet<string>
  /** The `connection/request` hook. */
  readonly hook: (request: { url: string, headers: Record<string, string> }, response: object, next: () => Promise<void>) => Promise<void>
  /** Run a route at the computer, which the hook already placed there. */
  readonly atComputer: (path: string, init?: RequestInit) => Promise<Response>
  /** Run a route as a Peer: `admitPeer` first, then `fetch` with the same request, as the Connection does. */
  readonly asPeer: (path: string, principal: object, init?: RequestInit) => Promise<Response>
}

/**
 * Register the routes on a fake Connection whose `homeAuth` places every request on one listener.
 * @param listener - the listener `homeAuth` reports.
 * @returns the mounted routes.
 */
function mounted(listener: string | undefined): Mounted {
  const root = mkdtempSync(join(tmpdir(), 'ea1-limits-routes-'))
  roots.push(root)
  const checks: ExternalAgentName[] = []
  const accounts = createAgentAccounts({
    storePath: accountsFilePath(root), now: () => 1_000, probeMinIntervalMs: () => 60_000, triggers: () => ['check-now'], installed: () => true,
    check: async (provider) => {
      checks.push(provider)
      return Promise.resolve({ kind: 'observed', observation: { provider, signedIn: 'yes', windows: [], source: 'probe' } })
    },
    report: () => {},
    signal: new AbortController().signal,
  })
  let hook: Mounted['hook'] | undefined
  const routes = new Map<string, Route>()
  const ctx = {
    on: (_name: string, registered: Mounted['hook']) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }), dangerousMode: () => false, pinEnabled: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined) } : undefined),
    connection: { fetch: { register: (route: Route & { path: string }) => { routes.set(route.path, route) } } },
  }
  const used = new Set<string>()
  const recorded = new Proxy(ctx, { get: (target, key, receiver) => { used.add(String(key)); return Reflect.get(target, key, receiver) } })
  registerAccountRoutes(recorded as never, accounts)
  return {
    checks,
    accounts,
    used,
    hook: (request, response, next) => hook!(request, response, next),
    atComputer: async (path, init) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, init)),
    asPeer: async (path, principal, init) => {
      const request = new Request(`http://localhost${path}`, init)
      const route = routes.get(path)!
      if (route.admitPeer?.(request, { principal }) !== true) return new Response('forbidden', { status: 403 })
      return route.fetch(request)
    },
  }
}

const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })
const refresh = (provider: string): RequestInit => ({ method: 'POST', body: JSON.stringify({ provider }) })

describe('the account routes', () => {
  it('let a locked phone read the figures, and reading starts no check', async () => {
    const routes = mounted('reach-tailscale-private')
    const read = await routes.asPeer(ACCOUNT_ROUTES.accounts, device('locked-phone'))
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ now: 1_000, accounts: [{ provider: 'claude-code', signedIn: 'unknown' }, { provider: 'codex', signedIn: 'unknown' }] })
    await routes.atComputer(ACCOUNT_ROUTES.accounts)
    // Pins "never on a page load": a read that started a check would show here.
    expect(routes.checks).toEqual([])
    expect((await routes.asPeer(ACCOUNT_ROUTES.accounts, { kind: 'sdk' })).status).toBe(403)
  })

  it('refuse Check now from a locked phone with ELEVATION_REQUIRED before a check starts', async () => {
    const routes = mounted('reach-tailscale-private')
    const locked = await routes.asPeer(ACCOUNT_ROUTES.refresh, device('locked-phone'), refresh('codex'))
    // Pins the unlock gate: without it a locked phone would start the person's program on the computer.
    expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect(routes.checks).toEqual([])
    expect((await routes.asPeer(ACCOUNT_ROUTES.refresh, { kind: 'sdk' }, refresh('codex'))).status).toBe(403)
    expect(routes.checks).toEqual([])
  })

  it('run Check now for an unlocked phone, one holding the approval grace, and the computer', async () => {
    const routes = mounted('reach-tailscale-private')
    const unlocked = await routes.asPeer(ACCOUNT_ROUTES.refresh, device('unlocked-phone'), refresh('codex'))
    expect(unlocked.status).toBe(200)
    expect(await unlocked.json()).toMatchObject({ outcome: { kind: 'checked' } })
    expect((await routes.asPeer(ACCOUNT_ROUTES.refresh, device('grace-phone'), refresh('claude-code'))).status).toBe(200)
    const computer = await routes.atComputer(ACCOUNT_ROUTES.refresh, refresh('codex'))
    expect(await computer.json()).toMatchObject({ outcome: { kind: 'throttled' } })
    expect(routes.checks).toEqual(['codex', 'claude-code'])
  })

  it('refuse a request that is not JSON naming a known agent', async () => {
    const routes = mounted('loopback')
    for (const init of [refresh('other'), { method: 'POST', body: 'not json' }, { method: 'POST', body: JSON.stringify({ provider: 'codex', cwd: '/tmp' }) }, { method: 'POST', body: 'x'.repeat(2048) }]) {
      const answer = await routes.atComputer(ACCOUNT_ROUTES.refresh, init)
      expect(answer.status).toBe(400)
      expect(await answer.json()).toMatchObject({ error: 'INVALID_REQUEST' })
    }
    expect(routes.checks).toEqual([])
  })

  it('refuse a request the home cannot place, or a foreign Host on the loopback listener, before any route runs', async () => {
    for (const [listener, host, expected] of [
      ['loopback', '127.0.0.1:4500', true],
      ['loopback', 'home.example.ts.net', false],
      [undefined, '127.0.0.1:4500', false],
      ['reach-tailscale-private', 'home.example.ts.net', true],
    ] as const) {
      const routes = mounted(listener)
      for (const path of Object.values(ACCOUNT_ROUTES)) {
        const answered: { body?: string } = {}
        const response = { writeHead: () => {}, end: (body: string) => { answered.body = body } }
        let reached = false
        await routes.hook({ url: path, headers: { host } }, response, async () => { reached = true })
        expect({ listener, host, path, reached }).toEqual({ listener, host, path, reached: expected })
        if (!expected) expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
      }
    }
  })

  it('register two routes and the arrival hook only: no tool a model could call to start a check', () => {
    const routes = mounted('loopback')
    // Pins D17's "a model tool call starts no check": the module offers nothing but the person's routes.
    expect([...routes.used].sort()).toEqual(['connection', 'on'])
  })

  it('answer a read with none of the personal fields a program reply carried', async () => {
    const routes = mounted('reach-tailscale-private')
    const reply = Object.assign({}, { provider: 'codex' as const, signedIn: 'yes' as const, windows: [], source: 'run' as const }, {
      email: 'person@example.com', organization: 'Example Org Ltd', accountId: 'acct_4f2a9c', plan: 'person@example.com',
    })
    await routes.accounts.observe(reply)
    const text = await (await routes.asPeer(ACCOUNT_ROUTES.accounts, device('locked-phone'))).text()
    for (const value of ['person@example.com', 'Example Org Ltd', 'acct_4f2a9c']) expect(text).not.toContain(value)
  })
})
