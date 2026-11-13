/**
 * The provider of upstream's `authenticator` over a bare Cordis context with a recording connection: the policy of the
 * listeners a reach provider asked the home to serve, the stamp and the pre-login routes, one Peer per device and
 * listener disposed with its device, the refusal of a full-access grant answered from a reach Peer, and the
 * `reach-device` principal of its Peers with the remote access policy it registers for them.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Admission, ConnectionIndexRequest } from '@deepseek-ai/dsh-client-connection'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessBinding, RemoteAccessPolicy } from '@deepseek-ai/dsh-api-remote-access/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type StudioAddress } from '@delo/contract-admission'
import { HOME_AUTH_SWITCH, HomeAuthService, REACH_SWITCH } from '../src/service.ts'
import { defaultPermissionOf, EXTERNAL_AGENT_REFUSAL, FULL_ACCESS_REFUSAL, HomeAuthAuthenticator, matchesPreLogin, protectedEntryIdsOf, registerReachPolicy, WORKSPACE_MANAGEMENT_REFUSAL } from '../src/authenticator.ts'
import { createReachAccessPolicy, REACH_ALLOWED_ACTIONS, reachDevicePrincipal, type ReachDevicePrincipal } from '../src/reach-access.ts'
import { REQUEST_LISTENER } from '@delo/home'
import { DeviceStore } from '../src/devices.ts'
import { claimOf, recordOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const HOUR = 60 * 60 * 1000

/** A Peer double that records its disposal. */
interface FakePeer extends PeerScope {
  readonly disposal: { disposed: boolean }
}

/**
 * A Peer double.
 * @param id - its id.
 * @returns the Peer.
 */
function fakePeer(id: string): FakePeer {
  const disposal = { disposed: false }
  return {
    id: brandString<PeerId>(id), ctx: new Context(), principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer', disposal,
    dispose: async () => { disposal.disposed = true },
  }
}

let ctx: Context
let fiber: Fiber
let directory: string
const created: FakePeer[] = []
/** The principal each created Peer was asked for. */
const principals: Principal[] = []
const builtin: ConnectionIndexRequest[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delo-home-auth-provider-'))
  ctx = new Context()
  created.length = 0
  principals.length = 0
  builtin.length = 0
  ctx.provide('webServer', { register: () => () => {}, port: undefined } as never)
  ctx.provide('connection', {
    builtinAdmission: (request: ConnectionIndexRequest): Admission => {
      builtin.push(request)
      return { kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }
    },
    createPeer: (options: { readonly principal: Principal }): PeerScope => {
      principals.push(options.principal)
      const peer = fakePeer(`peer-${String(created.length)}`)
      created.push(peer)
      return peer
    },
    closeReachConnections: () => 0,
  } as never)
  fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth') })
  await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
})

afterEach(async () => {
  await fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

/** A session for a device recorded at the served address. */
async function session(fill: number, lifetimeMs = HOUR): Promise<string> {
  const store = new DeviceStore({ file: join(directory, 'secrets', 'home-auth', 'devices.json') })
  if (await ctx.homeAuth.owner() === undefined) {
    await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  }
  await store.add(recordOf(fill, ADDRESS))
  const opened = await ctx.homeAuth.openSession({ deviceId: recordOf(fill, ADDRESS).id, listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs })
  return opened.token
}

function provider(): HomeAuthAuthenticator {
  const value = ctx.authenticator
  if (!(value instanceof HomeAuthAuthenticator)) throw new Error('home-auth did not provide the authenticator')
  return value
}

const request = (fields: Partial<ConnectionIndexRequest> = {}): ConnectionIndexRequest => ({ headers: {}, method: 'GET', url: '/', ...fields })

describe('the authenticator provider', () => {
  it('serves only the listeners a reach provider asked for, with the reach policy', () => {
    expect(provider().policy('reach-tailscale-private')).toBeUndefined()
    const off = ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    expect(provider().policy('reach-tailscale-private')).toMatchObject({
      scheme: 'https', hostRule: { kind: 'equals-address', address: ADDRESS }, acceptsLaunchToken: false,
    })
    expect(provider().policy('reach-tailscale-private')?.preLogin).not.toContainEqual({ method: 'POST', path: '/auth/recovery' })
    off()
    expect(provider().policy('reach-tailscale-private')).toBeUndefined()
  })

  it('keeps upstream\'s admission on loopback and stamps every reach request', async () => {
    const loopback = request()
    provider().admit(loopback, 'loopback')
    expect(builtin).toEqual([loopback])
    // An unserved listener admits nothing.
    expect(provider().admit(request(), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const signIn = request({ url: '/auth/sign-in' })
    expect(provider().admit(signIn, 'reach-tailscale-private')).toEqual({ kind: 'pre-login', route: { method: 'GET', path: '/auth/sign-in' } })
    // Pins the stamp: without it a route decides the arrival from the socket alone.
    expect(Reflect.get(signIn, REQUEST_LISTENER)).toBe('reach-tailscale-private')
    expect(provider().admit(request({ url: '/auth/device/request/abc' }), 'reach-tailscale-private')).toMatchObject({ kind: 'pre-login' })
    expect(provider().admit(request({ url: undefined }), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    expect(provider().admit(request({ url: '/auth/session' }), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    expect(provider().admit(request({ headers: { cookie: 'other=1' } }), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    expect([
      matchesPreLogin({ method: 'GET', path: '/auth/device/request/<id>' }, 'GET', '/auth/device/request/a/b'),
      matchesPreLogin({ method: 'GET', path: '/auth/device/request/<id>' }, 'GET', '/auth/device/request/'),
      matchesPreLogin({ method: 'GET', path: '/auth/device/request/<id>' }, 'GET', '/auth/other/x'),
    ]).toEqual([false, false, false])
  })

  it('sends a browser that opens any page without a session to the sign-in page, and keeps JSON for everything else', async () => {
    const reach = 'reach-tailscale-private'
    const page = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' }
    // Pins the loopback rule: the loopback listener keeps upstream's admission, which redirects nothing.
    expect(provider().admit(request({ url: '/', headers: page }), 'loopback')).toEqual({ kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' })
    ctx.homeAuth.serve({ listener: reach, address: ADDRESS, factor: 'tailnet-membership' })
    const signIn = (url: string): Admission => provider().admit(request({ url, headers: page }), reach)
    expect(signIn('/')).toEqual({ kind: 'refused', status: 401, code: 'NOT_SIGNED_IN', location: '/auth/sign-in' })
    // The address with a trailing slash, another case and a deep link all land on the sign-in page, the deep link kept.
    expect(signIn('/Auth/Sign-In')).toMatchObject({ location: '/auth/sign-in?next=%2FAuth%2FSign-In' })
    expect(signIn('/auth/sign-in/')).toMatchObject({ location: '/auth/sign-in' })
    expect(signIn('/settings/devices?tab=1')).toMatchObject({ location: '/auth/sign-in?next=%2Fsettings%2Fdevices%3Ftab%3D1' })
    // Pins the landing rule: a target the sign-in page may not send a device back to is dropped, never carried.
    for (const url of ['/a/../b', '/a//b', '/a%2fb', '/a\\b', '/auth/devices', '/']) {
      expect(signIn(url)).toMatchObject({ location: '/auth/sign-in' })
    }
    // A browser without fetch metadata that accepts HTML is a navigation too.
    expect(provider().admit(request({ url: '/x', headers: { accept: 'text/html' } }), reach)).toMatchObject({ location: '/auth/sign-in?next=%2Fx' })
    // Pins the navigation rule: a script's request, a state change and a request that accepts no HTML keep the JSON code.
    for (const fields of [
      { url: '/api/session.list', headers: { 'sec-fetch-mode': 'cors', accept: 'text/html' } },
      { url: '/', method: 'POST', headers: page },
      { url: '/', headers: { accept: 'application/json' } },
      { url: '/', headers: {} },
    ]) {
      expect(provider().admit(request(fields), reach)).toEqual({ kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' })
    }
    // An expired session is sent to sign in again.
    const cookie = { cookie: `__Host-delo-session=${await session(2, 1)}` }
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(provider().admit(request({ url: '/x', headers: { ...page, ...cookie } }), reach)).toEqual({ kind: 'refused', status: 401, code: 'SESSION_EXPIRED', location: '/auth/sign-in?next=%2Fx' })
  })

  it('admits a live session as one Peer per device, from either header carrier, and disposes it with the device', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const first = await session(2)
    const second = await session(3)
    const one = provider().admit(request({ headers: { cookie: `a=b; __Host-delo-session=${first}` } }), 'reach-tailscale-private')
    const again = provider().admit(request({ headers: new Headers({ cookie: `__Host-delo-session=${first}` }) }), 'reach-tailscale-private')
    const other = provider().admit(request({ headers: { cookie: ['x=y', `__Host-delo-session=${second}`] } }), 'reach-tailscale-private')
    if (one.kind !== 'admitted' || again.kind !== 'admitted' || other.kind !== 'admitted') throw new Error('not admitted')
    expect(again.peer).toBe(one.peer)
    expect(other.peer).not.toBe(one.peer)
    expect(provider().reachPeer(one.peer.id)).toEqual({ deviceId: recordOf(2, ADDRESS).id, listener: 'reach-tailscale-private', factor: 'tailnet-membership' })
    expect(provider().admit(request({ headers: new Headers() }), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    await ctx.homeAuth.revokeDevice(recordOf(2, ADDRESS).id)
    // Pins the removal: the removed device's Peer ends, and the other device's stays.
    expect(created.map(peer => peer.disposal.disposed)).toEqual([true, false])
    expect(provider().reachPeer(one.peer.id)).toBeUndefined()
    await fiber.dispose()
    expect(created.map(peer => peer.disposal.disposed)).toEqual([true, true])
  })

  it('refuses a full-access, workspace-management or external-agent grant answered from a reach Peer, and nothing else', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    const local = fakePeer('local')
    const check = (peer: PeerScope, fields: { event?: string; request?: object; value?: unknown } = {}): void => {
      provider().checkAnswer({ peer, event: fields.event ?? 'approval/request', request: fields.request ?? { grants: 'full-access' }, value: fields.value ?? 'allowed-once' })
    }
    const workspace = { grants: 'workspace-management' }
    // Pins the refusal for a Peer a reach listener admitted.
    expect(() => { check(admitted.peer) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: FULL_ACCESS_REFUSAL, details: { action: 'full-access-escalation' } }))
    // Pins the workspace-management refusal, which names its own action.
    expect(() => { check(admitted.peer, { request: workspace }) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: WORKSPACE_MANAGEMENT_REFUSAL, details: { action: 'workspace-management' } }))
    // Pins the external-agent refusal: a phone cannot allow an external agent to start.
    expect(() => { check(admitted.peer, { request: { grants: 'external-agent' } }) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: EXTERNAL_AGENT_REFUSAL, details: { action: 'external-agent' } }))
    expect(() => { check(local, { request: { grants: 'external-agent' } }) }).not.toThrow()
    expect(() => { check(admitted.peer, { request: { grants: 'external-agent' }, value: 'rejected' }) }).not.toThrow()
    // Pins the granting test: an answer outside the closed outcomes counts as granting.
    expect(() => { check(admitted.peer, { request: workspace, value: 'allowed' }) }).toThrow(expect.objectContaining({ details: { action: 'workspace-management' } }))
    expect(() => { check(local) }).not.toThrow()
    expect(() => { check(local, { request: workspace }) }).not.toThrow()
    for (const value of ['rejected', 'cancelled', 'unavailable']) {
      expect(() => { check(admitted.peer, { value }) }).not.toThrow()
      expect(() => { check(admitted.peer, { request: workspace, value }) }).not.toThrow()
    }
    expect(() => { check(admitted.peer, { request: {} }) }).not.toThrow()
    expect(() => { check(admitted.peer, { request: { grants: 'other' } }) }).not.toThrow()
    expect(() => { check(admitted.peer, { event: 'question/ask' }) }).not.toThrow()
    // Pins the guard the Gateway calls: it is the same check.
    expect(() => { ctx.get('remoteAnswerGuard')?.check({ peer: admitted.peer, event: 'approval/request', request: { grants: 'full-access' }, value: 'allowed-once' } as never) })
      .toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('lets an unlocked device give full-access, workspace-management and external-agent grants while dangerous mode holds, and no other device', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    let mode = true
    let grants: object | undefined = { grantedFolders: () => [], dangerousMode: () => mode }
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (name === 'reachFullAccessGrants' ? grants : Context.prototype.get.call(ctx, name as never))) as never)
    let unlocked = true
    vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => (unlocked ? { id: 'elevation-1' } as never : undefined))
    const give = (grantsMarker: string): void => {
      provider().checkAnswer({ peer: admitted.peer, event: 'approval/request', request: { grants: grantsMarker }, value: 'allowed-once' })
    }
    for (const marker of ['full-access', 'workspace-management', 'external-agent']) expect(() => { give(marker) }, marker).not.toThrow()
    // Pins the unlock check: a device whose unlock ended keeps every refusal.
    unlocked = false
    for (const marker of ['full-access', 'workspace-management', 'external-agent']) expect(() => { give(marker) }, marker).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    unlocked = true
    // Pins the mode check: with the mode off, without a service and with a store that cannot be read, nothing is lifted.
    mode = false
    expect(() => { give('full-access') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    grants = undefined
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    expect(() => { give('external-agent') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    grants = { grantedFolders: () => [], dangerousMode: () => { throw new Error('unreadable store') } }
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    expect(() => { give('workspace-management') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('sets the rolled cookie on a plain request and never on an upgrade', async () => {
    // The home reads the clock it was built with, so it is rebuilt over a faked `Date`.
    await fiber.dispose()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth') })
      await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const token = await session(2, SESSION_LIMITS.reach.absoluteMs)
      const cookie = { cookie: `__Host-delo-session=${token}` }
      const step = 11 * HOUR
      vi.setSystemTime(Date.now() + step)
      expect(provider().admit(request({ headers: cookie }), 'reach-tailscale-private')).not.toHaveProperty('setCookie')
      vi.setSystemTime(Date.now() + step)
      expect(provider().admit(request({ headers: cookie }), 'reach-tailscale-private')).not.toHaveProperty('setCookie')
      vi.setSystemTime(Date.now() + SESSION_LIMITS.reach.rollAfterMs - 2 * step)
      // Pins the Upgrade rule: a 101 response cannot carry the new cookie, so an upgrade keeps the old token.
      expect(provider().admit(request({ headers: { ...cookie, upgrade: 'websocket' } }), 'reach-tailscale-private')).not.toHaveProperty('setCookie')
      const rolled = provider().admit(request({ headers: cookie }), 'reach-tailscale-private')
      if (rolled.kind !== 'admitted') throw new Error('not admitted')
      expect(rolled.setCookie).toMatch(/^__Host-delo-session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
      const next = /^__Host-delo-session=([^;]+);/.exec(rolled.setCookie ?? '')?.[1]
      expect(next).not.toBe(token)
      const after = provider().admit(request({ headers: { cookie: `__Host-delo-session=${next ?? ''}` } }), 'reach-tailscale-private')
      expect(after.kind === 'admitted' ? after.peer : undefined).toBe(rolled.peer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a signed-in device every target off its paths, after the session\'s own refusals and without a roll', async () => {
    await fiber.dispose()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth') })
      await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const cookie = { cookie: `__Host-delo-session=${await session(2, SESSION_LIMITS.reach.absoluteMs)}` }
      const loopbackRequired = { kind: 'refused', status: 403, code: 'LOOPBACK_REQUIRED' }
      // Pins the path check: without it a live session admits every target, a route that only checks admission included.
      for (const url of ['/open-in-app/apps', '/assets/../open-in-app/apps', '/apix', undefined]) {
        expect(provider().admit(request({ url, headers: cookie }), 'reach-tailscale-private')).toEqual(loopbackRequired)
      }
      expect(provider().admit(request({ url: '/open-in-app/socket', headers: { ...cookie, upgrade: 'websocket' } }), 'reach-tailscale-private')).toEqual(loopbackRequired)
      expect(created).toEqual([])
      // Pins the roll's condition: a refused response carries no cookie, so the session rolls on the next reachable request.
      const step = 11 * HOUR
      for (const advance of [step, step, SESSION_LIMITS.reach.rollAfterMs - 2 * step]) {
        vi.setSystemTime(Date.now() + advance)
        expect(provider().admit(request({ url: '/open-in-app/apps', headers: cookie }), 'reach-tailscale-private')).toEqual(loopbackRequired)
      }
      expect(provider().admit(request({ url: '/api/session.list', headers: cookie }), 'reach-tailscale-private')).toMatchObject({ kind: 'admitted', setCookie: expect.stringMatching(/^__Host-delo-session=/) })
      // Pins the order: an expired session answers its own code on any target.
      vi.setSystemTime(Date.now() + SESSION_LIMITS.reach.absoluteMs)
      expect(provider().admit(request({ url: '/open-in-app/apps', headers: cookie }), 'reach-tailscale-private')).toMatchObject({ kind: 'refused', code: 'SESSION_EXPIRED' })
      // The loopback listener keeps upstream's admission on every target.
      provider().admit(request({ url: '/open-in-app/apps' }), 'loopback')
      expect(builtin.at(-1)?.url).toBe('/open-in-app/apps')
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the reach-device principal and policy', () => {
    /** A remote access double that records the policy and every invalidation. */
    async function fakeRemoteAccess(): Promise<{ policy: () => RemoteAccessPolicy<ReachDevicePrincipal>; readonly invalidated: Principal[] }> {
      let registered: { readonly kind: string; readonly policy: RemoteAccessPolicy<ReachDevicePrincipal> } | undefined
      const invalidated: Principal[] = []
      ctx.provide('remoteAccess')
      ctx.set('remoteAccess', {
        registerPolicy: (kind: string, policy: RemoteAccessPolicy<ReachDevicePrincipal>) => { registered = { kind, policy }; return () => {} },
        invalidate: (principal: Principal) => { invalidated.push(principal) },
      } as never)
      await new Promise<void>((resolve) => { ctx.inject(['remoteAccess'], () => { resolve() }) })
      return {
        policy: () => {
          if (registered?.kind !== 'reach-device') throw new Error('no reach-device policy was registered')
          return registered.policy
        },
        invalidated,
      }
    }

    it('registers the policy, which lets a device answer approval prompts, only while an answer guard is mounted', () => {
      const registered: string[] = []
      const registry = { registerPolicy: (kind: string) => { registered.push(kind); return () => {} } }
      const policy = createReachAccessPolicy({ admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, deloHome: '/nowhere', elevationOf: () => undefined, logElevated: () => {}, terminalFoldersOf: () => undefined, grantedFolders: () => [], terminalWithoutUnlock: () => false, computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), defaultPermission: () => undefined, dangerousMode: () => false })
      expect(Object.keys(REACH_ALLOWED_ACTIONS)).toContain('event:approval/request')
      // Pins the guard check: without it a device could answer every approval prompt with nothing to refuse a grant.
      expect(() => registerReachPolicy(undefined, registry, policy)).toThrow(/no remoteAnswerGuard is mounted/)
      expect(registered).toEqual([])
      registerReachPolicy({ check: () => {} }, registry, policy)
      expect(registered).toEqual(['reach-device'])
    })

    it('creates every reach Peer for the device\'s principal, never the owner', async () => {
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
      // Pins the principal: an owner Peer passes every remote access check.
      expect(principals).toEqual([reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')])
    })

    it('binds an admitted device to the global resource, every Workspace and every Session it can name', async () => {
      const access = await fakeRemoteAccess()
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      // Pins the registry fallbacks: without a Workspace registry or a Session store only the global resource is bound.
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      expect(access.policy().bindings(device)).toEqual([])
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
      expect(access.policy().bindings(device).map(binding => binding.resource)).toEqual([{ kind: 'global' }])
      ctx.provide('workspaceRegistry', { list: () => [{ id: 'w-1', path: '/nowhere/w-1', sessionIds: ['s-1'] }] } as never)
      ctx.provide('sessions', { list: () => [{ id: 's-1' }, { id: 's-live' }] } as never)
      // Pins the facts the authenticator gives the policy: the admitted device, the Workspaces and the live Sessions.
      expect(access.policy().bindings(device).map(binding => binding.resource)).toEqual([
        { kind: 'global' }, { kind: 'workspace', id: 'w-1' }, { kind: 'session', id: 's-1' }, { kind: 'session', id: 's-live' },
      ])
      expect(access.policy().bindings(reachDevicePrincipal('another-device', 'reach-tailscale-private'))).toEqual([])
      // Pins the listener in the admission fact: the device's Peer on the private listener binds nothing on another.
      expect(access.policy().bindings(reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-funnel'))).toEqual([])
    })

    it('decides an elevated action from the device\'s elevation, and recomputes its snapshot when one starts or ends', async () => {
      const access = await fakeRemoteAccess()
      const logged: string[] = []
      ctx.logger.info = (line: string) => { logged.push(line) }
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const token = await session(2)
      const admitted = ctx.homeAuth.admitToken(token, 'reach-tailscale-private')
      if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${token}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const [binding] = access.policy().bindings(device)
      const create = () => binding?.condition?.({ action: 'terminal/create', resource: { kind: 'global' }, args: {} } as never)
      const asked = vi.spyOn(ctx.homeAuth, 'elevationOf')
      expect(create()).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
      // Pins the listener the authenticator asks for: the principal's own, so an unlock on one listener admits nothing on another.
      expect(asked).toHaveBeenCalledWith(device.deviceId, 'reach-tailscale-private')
      const before = access.invalidated.length
      const state = ctx.homeAuth.requestElevation(admitted.sessionId, admitted.session)
      if (state.kind !== 'pending') throw new Error('no request is waiting')
      const record = ctx.homeAuth.approveElevation(state.requestId, state.code)
      // Pins the facts the authenticator gives the policy: the home's elevation for the device, and the log.
      expect(create()).toEqual({ kind: 'allow' })
      expect(logged).toContain(`home-auth: elevated action: device=${device.deviceId} listener=reach-tailscale-private action=terminal/create elevation=${record.id}`)
      ctx.homeAuth.lockElevation(device.deviceId, 'reach-tailscale-private')
      // Pins the invalidation: the device's snapshot is recomputed when its elevation starts and when it ends.
      expect(access.invalidated.slice(before)).toEqual([device, device])
      expect(create()).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
    })

    it('names a Session\'s workspace root from its live header, else from its Workspace, for the file reads', async () => {
      const access = await fakeRemoteAccess()
      const outside = await mkdtemp(join(tmpdir(), 'delo-home-auth-roots-'))
      try {
        const live = join(outside, 'live')
        const stored = join(outside, 'stored')
        await mkdir(live)
        await mkdir(stored)
        await writeFile(join(live, 'a.txt'), 'a')
        await writeFile(join(stored, 'b.txt'), 'b')
        ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
        provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
        ctx.provide('workspaceRegistry', { list: () => [{ id: 'w-1', path: stored, sessionIds: ['s-stored'] }] } as never)
        ctx.provide('sessions', { list: () => [{ id: 's-live' }], get: (id: string) => (id === 's-live' ? { header: { cwd: live } } : undefined) } as never)
        const binding = access.policy().bindings(reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private'))
          .find((candidate): candidate is Extract<RemoteAccessBinding, { readonly resource: { readonly kind: 'session' } }> => candidate.resource.kind === 'session')
        const read = (id: string, path: string) => binding?.condition?.({ action: 'workspaceFiles/read', resource: { kind: 'session', id: id as SessionId }, args: { path } })
        // Pins the root facts: a live Session reads from its working directory, a stored one from its Workspace's path.
        expect(read('s-live', 'a.txt')).toEqual({ kind: 'allow' })
        expect(read('s-live', 'b.txt')).toMatchObject({ kind: 'deny' })
        expect(read('s-stored', 'b.txt')).toEqual({ kind: 'allow' })
        expect(read('s-unknown', 'b.txt')).toMatchObject({ kind: 'deny' })
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('opens a terminal from the Session\'s folders, the granted workspaces and the switch, and recomputes the snapshot on a switch change', async () => {
      const access = await fakeRemoteAccess()
      const outside = await mkdtemp(join(tmpdir(), 'delo-home-auth-terminal-'))
      try {
        const granted = join(outside, 'granted')
        const moved = join(granted, 'inner')
        const other = join(outside, 'other')
        await mkdir(moved, { recursive: true })
        await mkdir(other)
        ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
        provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
        const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
        const live = { 's-in': { header: { cwd: granted } }, 's-out': { header: { cwd: other } } } as Record<string, { readonly header: { readonly cwd: string } }>
        ctx.provide('sessions', { list: () => [{ id: 's-in' }, { id: 's-out' }, { id: 's-gone' }], get: (id: string) => live[id] } as never)
        ctx.provide('workingDirectory', { get: (session: { readonly header: { readonly cwd: string } }) => (session === live['s-in'] ? moved : session.header.cwd) } as never)
        const binding = access.policy().bindings(device)
          .find((candidate): candidate is Extract<RemoteAccessBinding, { readonly resource: { readonly kind: 'session' } }> => candidate.resource.kind === 'session')
        const open = (id: string) => binding?.condition?.({ action: 'terminal/create', resource: { kind: 'session', id: id as SessionId }, args: {} } as never)
        // Without a grant provider no workspace counts as granted.
        expect(open('s-in')).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
        ctx.provide('reachFullAccessGrants', { grantedFolders: () => [granted] } as never)
        // Pins the folder facts: a live Session's current and original folders, checked against the granted workspaces.
        expect(open('s-in')).toEqual({ kind: 'allow' })
        expect(open('s-out')).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
        expect(open('s-gone')).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
        const before = access.invalidated.length
        await ctx.homeAuth.setTerminalWithoutUnlock(true, 'computer')
        // Pins the switch fact and its invalidation: the device's snapshot is recomputed when the switch changes.
        expect(open('s-out')).toEqual({ kind: 'allow' })
        expect(access.invalidated.slice(before)).toEqual([device])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('reads the computer-only switches registered now and the rows the plugin-manager row protects, from the Loader', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const condition = access.policy().bindings(device)[0]?.condition
      const decide = (action: string, args: Record<string, unknown>) => condition?.({ action, resource: { kind: 'global' }, args } as never)
      const turnOff = { ns: 'delo-delegation-consent', patch: { enabled: false } }
      const NO_UNLOCK = { kind: 'deny', reason: 'elevation-required: settings/update' }
      expect(decide('settings/update', turnOff)).toEqual(NO_UNLOCK)
      // Pins the registry fact: a registered switch is kept on while its registration holds.
      const off = ctx.homeAuth.registerComputerOnlySwitch({ ns: 'delo-delegation-consent', field: 'enabled', label: 'the external-agent consent' })
      expect(ctx.homeAuth.computerOnlySwitches()).toEqual([HOME_AUTH_SWITCH, REACH_SWITCH, { ns: 'delo-delegation-consent', field: 'enabled', label: 'the external-agent consent' }])
      expect(decide('settings/update', turnOff)).toEqual({ kind: 'deny', reason: 'loopback-required: turning the external-agent consent off' })
      off()
      expect(decide('settings/update', turnOff)).toEqual(NO_UNLOCK)
      // Pins the Loader fact: the rows whose module a plugin-manager row protects, by their entry ids.
      const enable = (id: string) => decide('pluginManager/setPluginEnabled', { id, enabled: false })
      const entries = [
        { id: 'include:plugin-manager', options: { name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: ['@delo/plugin-mcp-consent'] } } },
        { id: 'include:delo-mcp-consent', options: { name: '@delo/plugin-mcp-consent' } },
        { id: 'include:delo-trash', options: { name: '@delo/plugin-trash' } },
      ]
      expect(protectedEntryIdsOf(ctx)).toEqual(new Set())
      ctx.provide('loader', { entries: () => entries } as never)
      expect(protectedEntryIdsOf(ctx)).toEqual(new Set(['include:delo-mcp-consent']))
      expect(enable('include:delo-mcp-consent')).toEqual({ kind: 'deny', reason: 'loopback-required: changing a protected plugin row' })
      expect(enable('include:delo-trash')).toEqual({ kind: 'deny', reason: 'elevation-required: pluginManager/setPluginEnabled' })
      // A list that is not one of names protects every row.
      entries[0] = { id: 'include:plugin-manager', options: { name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: 'all' } } } as never
      expect(protectedEntryIdsOf(ctx)).toBeUndefined()
      expect(enable('include:delo-trash')).toEqual({ kind: 'deny', reason: 'loopback-required: changing a protected plugin row' })
    })

    it('refuses a device every write to the home-auth and reach rows, unlocked or not, once the service registers its switches', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const condition = access.policy().bindings(device)[0]?.condition
      const decide = (action: string, args: Record<string, unknown>) => condition?.({ action, resource: { kind: 'global' }, args } as never)
      const REFUSED = { kind: 'deny', reason: 'loopback-required: turning the home-auth settings off' }
      const off = ctx.homeAuth.registerComputerOnlySwitch(HOME_AUTH_SWITCH)
      const offReach = ctx.homeAuth.registerComputerOnlySwitch(REACH_SWITCH)
      // Pins the switch's field: each way of writing the section is refused, so a device cannot widen who may ask.
      expect(decide('settings/update', { ns: 'delo-home-auth', patch: { pairing: { mayAskWithoutWindow: 'tailnet' } } })).toEqual(REFUSED)
      expect(decide('settings/mutate', { ns: 'delo-home-auth', ops: [{ op: 'set', path: ['pairing', 'mayAskWithoutWindow'], value: 'tailnet' }] })).toEqual(REFUSED)
      expect(decide('settings/replace', { ns: 'delo-home-auth', section: { secretsDirectory: '/x', pairing: { windowMinutes: 15 } } })).toEqual(REFUSED)
      // Pins the whole-row switch: the secrets directory is refused too, so a device cannot point remote access at an empty directory.
      expect(decide('settings/update', { ns: 'delo-home-auth', patch: { secretsDirectory: '/x' } })).toEqual({ kind: 'deny', reason: 'loopback-required: turning the home-auth settings off' })
      expect(decide('settings/mutate', { ns: 'delo-reach', ops: [{ op: 'set', path: ['enabled'], value: true }] })).toEqual({ kind: 'deny', reason: 'loopback-required: turning the remote-access settings off' })
      off()
      offReach()
    })

    it('reads the permission new chats start in from the running permission presets', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${await session(2)}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const condition = access.policy().bindings(device)[0]?.condition
      const loosen = { ns: 'permission', patch: { defaultPreset: 'danger-full-access' } }
      const decide = () => condition?.({ action: 'settings/update', resource: { kind: 'global' }, args: loosen } as never)
      expect(defaultPermissionOf(ctx)).toBeUndefined()
      expect(decide()).toEqual({ kind: 'deny', reason: 'elevation-required: settings/update' })
      const levels: Record<string, { sandbox: string; approval: string }> = {
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      }
      let defaultPreset = 'workspace-write'
      ctx.provide('permissionPresets', {
        get defaultPreset() { if (!(defaultPreset in levels)) throw new Error('unknown default'); return defaultPreset },
        resolve: (name: string) => { const level = levels[name]; if (level === undefined) throw new Error(`unknown preset ${name}`); return level },
      } as never)
      expect(defaultPermissionOf(ctx)?.namespaces).toEqual(new Set())
      ctx.provide('loader', { entries: () => [{ id: 'include:permission', options: { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' } }] } as never)
      // Pins the presets fact: the namespace comes from the Loader row, the levels from the running presets.
      expect(defaultPermissionOf(ctx)).toMatchObject({ namespaces: new Set(['permission']), current: levels['workspace-write'] })
      expect(defaultPermissionOf(ctx)?.levelOf('nothing')).toBeUndefined()
      expect(decide()).toEqual({ kind: 'deny', reason: 'loopback-required: loosening the permission new chats start in' })
      defaultPreset = 'gone'
      expect(defaultPermissionOf(ctx)?.current).toBeUndefined()
    })

    it('recomputes each admitted device\'s snapshot when a Session or a Workspace changes', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const token = await session(2)
      provider().admit(request({ headers: { cookie: `__Host-delo-session=${token}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      ctx.emit('session/created', {} as never)
      ctx.emit('session/disposed', {} as never)
      ctx.emit('domain/changed', { domain: 'settings' } as never)
      ctx.emit('domain/changed', { domain: 'workspace' } as never)
      // Pins each invalidation: a stale snapshot hides a new chat from the device or keeps a removed one.
      expect(access.invalidated).toEqual([device, device, device])
    })
  })
})
