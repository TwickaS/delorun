/**
 * The provider of upstream's `authenticator` over a bare Cordis context with a recording connection: the policy of the
 * listeners a reach provider asked the home to serve, the stamp and the pre-login routes, one Peer per device and
 * listener disposed with its device, the refusal of a full-access grant answered from a reach Peer, and the
 * `reach-device` principal of its Peers with the remote access policy it registers for them.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Admission, ConnectionIndexRequest } from '@deepseek-ai/dsh-client-connection'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessBinding, RemoteAccessPolicy } from '@deepseek-ai/dsh-api-remote-access/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type StudioAddress } from '@delorun/contract-admission'
import { HOME_AUTH_SWITCH, HomeAuthService, REACH_SWITCH } from '../src/service.ts'
import { defaultPermissionOf, EXTERNAL_AGENT_REFUSAL, FULL_ACCESS_REFUSAL, HomeAuthAuthenticator, matchesPreLogin, computerOnlyEntryIdsOf, protectedEntryIdsOf, REAL_BROWSER_REFUSAL, registerReachPolicy, WORKSPACE_MANAGEMENT_REFUSAL } from '../src/authenticator.ts'
import { createReachAccessPolicy, REACH_ALLOWED_ACTIONS, REACH_DENIED_ACTIONS, REACH_ELEVATED_ACTIONS, REACH_KEY_ACTIONS, reachDevicePrincipal, type ReachDevicePrincipal } from '../src/reach-access.ts'
import { REQUEST_LISTENER } from '@delorun/home'
import { DeviceStore } from '../src/devices.ts'
import { answerKey } from '../src/grants.ts'
import { claimOf, recordOf } from './fixtures/home.ts'

/** The entry id of a row that only the computer changes. */
const COMPUTER_ONLY_ROW = 'include:delorun-home-auth'

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
  const lifetime = new AbortController()
  return {
    id: brandString<PeerId>(id), ctx: new Context(), principal: { kind: 'owner' }, signal: lifetime.signal, interactions: 'answer', disposal,
    dispose: async () => { disposal.disposed = true; lifetime.abort() },
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
  directory = await mkdtemp(join(tmpdir(), 'delorun-home-auth-provider-'))
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
  fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth'), phonePowersOnUpgrade: 'full' })
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
    const cookie = { cookie: `__Host-delorun-session=${await session(2, 1)}` }
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(provider().admit(request({ url: '/x', headers: { ...page, ...cookie } }), reach)).toEqual({ kind: 'refused', status: 401, code: 'SESSION_EXPIRED', location: '/auth/sign-in?next=%2Fx' })
  })

  it('admits a live session as one Peer per device, from either header carrier, and disposes it with the device', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const first = await session(2)
    const second = await session(3)
    const one = provider().admit(request({ headers: { cookie: `a=b; __Host-delorun-session=${first}` } }), 'reach-tailscale-private')
    const again = provider().admit(request({ headers: new Headers({ cookie: `__Host-delorun-session=${first}` }) }), 'reach-tailscale-private')
    const other = provider().admit(request({ headers: { cookie: ['x=y', `__Host-delorun-session=${second}`] } }), 'reach-tailscale-private')
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

  // Removing the abort listener in admit leaves a terminal hold open after its Peer closed (R2-P2-2).
  it('ends the holds a Peer opened when the Peer is disposed, and keeps another Peer\'s', async () => {
    ctx.provide('previewFlags', { isOn: () => true, declare: () => () => {} } as never)
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const first = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
    const second = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(3)}` } }), 'reach-tailscale-private')
    if (first.kind !== 'admitted' || second.kind !== 'admitted') throw new Error('not admitted')
    const grants = ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    const open = (fill: number): { deviceId: string; listener: 'reach-tailscale-private' } => {
      const holder = { deviceId: recordOf(fill, ADDRESS).id, listener: 'reach-tailscale-private' } as const
      grants.mint(holder, [{ action: 'terminal/create', hash: 'h', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
      grants.consume(holder, 'terminal/create', 'h', { feature: 'terminal', id: 't-1', scope: 'session:s-1' })
      return holder
    }
    const one = open(2)
    const two = open(3)
    expect(grants.holdAdmits(one, 'terminal', 't-1', 'session:s-1')).toBe(true)
    await first.peer.dispose()
    expect(grants.holdAdmits(one, 'terminal', 't-1', 'session:s-1')).toBe(false)
    expect(grants.holdAdmits(two, 'terminal', 't-1', 'session:s-1')).toBe(true)
  })

  it('refuses a full-access, workspace-management or external-agent grant answered from a reach Peer, and nothing else', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
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

  // Removing the agent or the grants marker from the answer key lets a grant for one prompt answer another that shares its call id.
  it('admits a granting answer only for the prompt, the call id and the answer the person confirmed with Face ID, once', async () => {
    ctx.provide('previewFlags', { isOn: () => true, declare: () => () => {} } as never)
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    const holder = { deviceId: recordOf(2, ADDRESS).id, listener: 'reach-tailscale-private' } as const
    const grants = ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    grants.mintAnswer(holder, answerKey({ agent: 'chat-a', callId: 'call_0', grants: 'full-access' }), 'allowed-once')
    const answer = (agent: string, grantsMarker: string, value: string): void => {
      provider().checkAnswer({ peer: admitted.peer, event: 'approval/request', request: { agent: { id: agent }, callId: 'call_0', grants: grantsMarker }, value })
    }
    expect(() => { answer('chat-b', 'full-access', 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { answer('chat-a', 'workspace-management', 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { answer('chat-a', 'full-access', 'allowed-always') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { answer('chat-a', 'full-access', 'allowed-once') }).not.toThrow()
    expect(() => { answer('chat-a', 'full-access', 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('lets an unlocked device give full-access, workspace-management and external-agent grants while dangerous mode holds, and no other device', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    let mode = true
    let grants: object | undefined = { dangerousMode: () => mode }
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (name === 'reachFullAccessGrants' ? grants : name === 'previewFlags' ? undefined : Context.prototype.get.call(ctx, name as never))) as never)
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
    grants = { dangerousMode: () => { throw new Error('unreadable store') } }
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    expect(() => { give('workspace-management') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('refuses a real-browser grant from a merely signed-in device or one in its approval grace and lets an unlocked device give it, with dangerous mode off', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    let unlock: { id: string; grace?: true } | undefined
    vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => unlock as never)
    const give = (peer: PeerScope, value: unknown = 'allowed-once'): void => {
      provider().checkAnswer({ peer, event: 'approval/request', request: { grants: 'real-browser' }, value })
    }
    // Pins the locked refusal: a signed-in device without a running unlock is refused with its own action and sentence.
    expect(() => { give(admitted.peer) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: REAL_BROWSER_REFUSAL, details: { action: 'real-browser' } }))
    // Pins the refusal the Gateway sees: the guard throws, so the answer is not applied and the prompt stays pending.
    expect(() => { ctx.get('remoteAnswerGuard')?.check({ peer: admitted.peer, event: 'approval/request', request: { grants: 'real-browser' }, value: 'allowed-once' } as never) })
      .toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', details: { action: 'real-browser' } }))
    // A locked device may still say no, and the computer may always say yes.
    for (const value of ['rejected', 'cancelled', 'unavailable']) expect(() => { give(admitted.peer, value) }, value).not.toThrow()
    expect(() => { give(fakePeer('local')) }).not.toThrow()
    // Pins the grace exclusion: a device in its approval grace typed no code or PIN, so it cannot give the grant.
    unlock = { id: 'grace-1', grace: true }
    expect(() => { give(admitted.peer) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: REAL_BROWSER_REFUSAL, details: { action: 'real-browser' } }))
    // Pins the unlocked device: a running unlock gives the grant, while the computer's other reserved grants stay refused.
    unlock = { id: 'elevation-1' }
    expect(() => { give(admitted.peer) }).not.toThrow()
    for (const marker of ['full-access', 'workspace-management', 'external-agent']) {
      expect(() => { provider().checkAnswer({ peer: admitted.peer, event: 'approval/request', request: { grants: marker }, value: 'allowed-once' }) }, marker)
        .toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    }
    // Pins the end of the unlock: the device is refused again.
    unlock = undefined
    expect(() => { give(admitted.peer) }).toThrow(expect.objectContaining({ details: { action: 'real-browser' } }))
  })

  it('refuses a real-browser grant from a device in its approval grace while dangerous mode holds', async () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
    const admitted = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
    if (admitted.kind !== 'admitted') throw new Error('not admitted')
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (name === 'reachFullAccessGrants' ? { dangerousMode: () => true } : name === 'previewFlags' ? undefined : Context.prototype.get.call(ctx, name as never))) as never)
    expect(ctx.homeAuth.dangerousMode()).toBe(true)
    let unlock: { id: string; grace?: true } = { id: 'grace-1', grace: true }
    vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => unlock as never)
    const give = (grantsMarker: string): void => {
      provider().checkAnswer({ peer: admitted.peer, event: 'approval/request', request: { grants: grantsMarker }, value: 'allowed-once' })
    }
    // Pins the grace exclusion in dangerous mode: the mode lifts the computer's grants for the grace, not this one.
    expect(() => { give('real-browser') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', message: REAL_BROWSER_REFUSAL, details: { action: 'real-browser' } }))
    expect(() => { give('full-access') }).not.toThrow()
    unlock = { id: 'elevation-1' }
    expect(() => { give('real-browser') }).not.toThrow()
  })

  it('sets the rolled cookie on a plain request and never on an upgrade', async () => {
    // The home reads the clock it was built with, so it is rebuilt over a faked `Date`.
    await fiber.dispose()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth'), phonePowersOnUpgrade: 'full' })
      await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const token = await session(2, SESSION_LIMITS.reach.absoluteMs)
      const cookie = { cookie: `__Host-delorun-session=${token}` }
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
      expect(rolled.setCookie).toMatch(/^__Host-delorun-session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
      const next = /^__Host-delorun-session=([^;]+);/.exec(rolled.setCookie ?? '')?.[1]
      expect(next).not.toBe(token)
      const after = provider().admit(request({ headers: { cookie: `__Host-delorun-session=${next ?? ''}` } }), 'reach-tailscale-private')
      expect(after.kind === 'admitted' ? after.peer : undefined).toBe(rolled.peer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a signed-in device every target off its paths, after the session\'s own refusals and without a roll', async () => {
    await fiber.dispose()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth'), phonePowersOnUpgrade: 'full' })
      await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      const cookie = { cookie: `__Host-delorun-session=${await session(2, SESSION_LIMITS.reach.absoluteMs)}` }
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
      expect(provider().admit(request({ url: '/api/session.list', headers: cookie }), 'reach-tailscale-private')).toMatchObject({ kind: 'admitted', setCookie: expect.stringMatching(/^__Host-delorun-session=/) })
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
      const policy = createReachAccessPolicy({ admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere', elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => false, keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined, computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set([COMPUTER_ONLY_ROW]), defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => false })
      expect(Object.keys(REACH_ALLOWED_ACTIONS)).toContain('event:approval/request')
      // Pins the guard check: without it a device could answer every approval prompt with nothing to refuse a grant.
      expect(() => registerReachPolicy(undefined, registry, policy)).toThrow(/no remoteAnswerGuard is mounted/)
      expect(registered).toEqual([])
      registerReachPolicy({ check: () => {} }, registry, policy)
      expect(registered).toEqual(['reach-device'])
    })

    it('creates every reach Peer for the device\'s principal, never the owner', async () => {
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
      // Pins the principal: an owner Peer passes every remote access check.
      expect(principals).toEqual([reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')])
    })

    it('binds an admitted device to the global resource, every Workspace and every Session it can name', async () => {
      const access = await fakeRemoteAccess()
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      // Pins the registry fallbacks: without a Workspace registry or a Session store only the global resource is bound.
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      expect(access.policy().bindings(device)).toEqual([])
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
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
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${token}` } }), 'reach-tailscale-private')
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
      const outside = await mkdtemp(join(tmpdir(), 'delorun-home-auth-roots-'))
      try {
        const live = join(outside, 'live')
        const stored = join(outside, 'stored')
        await mkdir(live)
        await mkdir(stored)
        await writeFile(join(live, 'a.txt'), 'a')
        await writeFile(join(stored, 'b.txt'), 'b')
        ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
        provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
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

    it('needs an unlock for a terminal in every folder, whatever the workspaces and dangerous mode grant', async () => {
      const access = await fakeRemoteAccess()
      const outside = await mkdtemp(join(tmpdir(), 'delorun-home-auth-terminal-'))
      try {
        const granted = join(outside, 'granted')
        const moved = join(granted, 'inner')
        const other = join(outside, 'other')
        await mkdir(moved, { recursive: true })
        await mkdir(other)
        ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
        provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
        const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
        const live = { 's-in': { header: { cwd: granted } }, 's-out': { header: { cwd: other } } } as Record<string, { readonly header: { readonly cwd: string } }>
        ctx.provide('sessions', { list: () => [{ id: 's-in' }, { id: 's-out' }, { id: 's-gone' }], get: (id: string) => live[id] } as never)
        ctx.provide('workingDirectory', { get: (session: { readonly header: { readonly cwd: string } }) => (session === live['s-in'] ? moved : session.header.cwd) } as never)
        const binding = access.policy().bindings(device)
          .find((candidate): candidate is Extract<RemoteAccessBinding, { readonly resource: { readonly kind: 'session' } }> => candidate.resource.kind === 'session')
        const open = (id: string) => binding?.condition?.({ action: 'terminal/create', resource: { kind: 'session', id: id as SessionId }, args: {} } as never)
        const denied = { kind: 'deny', reason: 'elevation-required: terminal/create' }
        expect(open('s-in')).toEqual(denied)
        // Pins the lock: neither a workspace the home granted full access, nor dangerous mode, waives a locked device's unlock.
        ctx.provide('reachFullAccessGrants', { dangerousMode: () => true, onDangerousModeEnd: () => () => {} } as never)
        for (const id of ['s-in', 's-out', 's-gone']) expect(open(id), id).toEqual(denied)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('reads the computer-only switches registered now and the rows the plugin-manager row protects, from the Loader', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const condition = access.policy().bindings(device)[0]?.condition
      const decide = (action: string, args: Record<string, unknown>) => condition?.({ action, resource: { kind: 'global' }, args } as never)
      const turnOff = { ns: 'delorun-delegation-consent', patch: { enabled: false } }
      const NO_UNLOCK = { kind: 'deny', reason: 'elevation-required: settings/update' }
      expect(decide('settings/update', turnOff)).toEqual(NO_UNLOCK)
      // Pins the registry fact: a registered switch is kept on while its registration holds.
      const off = ctx.homeAuth.registerComputerOnlySwitch({ ns: 'delorun-delegation-consent', field: 'enabled', label: 'the external-agent consent' })
      expect(ctx.homeAuth.computerOnlySwitches()).toEqual([HOME_AUTH_SWITCH, REACH_SWITCH, { ns: 'delorun-delegation-consent', field: 'enabled', label: 'the external-agent consent' }])
      expect(decide('settings/update', turnOff)).toEqual({ kind: 'deny', reason: 'loopback-required: turning the external-agent consent off' })
      off()
      expect(decide('settings/update', turnOff)).toEqual(NO_UNLOCK)
      // Pins the Loader fact: the rows whose module a plugin-manager row protects, by their entry ids.
      const enable = (id: string) => decide('pluginManager/setPluginEnabled', { id, enabled: false })
      const entries = [
        { id: 'include:plugin-manager', options: { name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: ['@delorun/plugin-mcp-consent'] } } },
        { id: 'include:delorun-mcp-consent', options: { name: '@delorun/plugin-mcp-consent' } },
        { id: 'include:delorun-trash', options: { name: '@delorun/plugin-trash' } },
      ]
      expect(protectedEntryIdsOf(ctx)).toEqual(new Set())
      ctx.provide('loader', { entries: () => entries } as never)
      expect(protectedEntryIdsOf(ctx)).toEqual(new Set(['include:delorun-mcp-consent']))
      // Pins the computer-only rows: the unlock gate, reach and the sandbox, by module.
      expect(computerOnlyEntryIdsOf(ctx)).toEqual(new Set())
      entries.push({ id: 'include:delorun-reach', options: { name: '@delorun/reach' } } as never)
      expect(computerOnlyEntryIdsOf(ctx)).toEqual(new Set(['include:delorun-reach']))
      entries.pop()
      // Pins the namespace form: a row's settings namespace is its `id` option, not its Loader entry id.
      entries.push({ id: 'include:sandbox', options: { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' } } as never)
      expect(computerOnlyEntryIdsOf(ctx)).toEqual(new Set(['include:sandbox', 'sandbox']))
      entries.pop()
      expect(enable('include:delorun-mcp-consent')).toEqual({ kind: 'deny', reason: 'loopback-required: changing a protected plugin row' })
      expect(enable('include:delorun-trash')).toEqual({ kind: 'deny', reason: 'elevation-required: pluginManager/setPluginEnabled' })
      // A list that is not one of names protects every row.
      entries[0] = { id: 'include:plugin-manager', options: { name: '@deepseek-ai/dsh-plugin-manager', config: { protectedPlugins: 'all' } } } as never
      expect(protectedEntryIdsOf(ctx)).toBeUndefined()
      expect(enable('include:delorun-trash')).toEqual({ kind: 'deny', reason: 'loopback-required: changing a protected plugin row' })
    })

    it('refuses a device every write to the home-auth and reach rows, unlocked or not, once the service registers its switches', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      const condition = access.policy().bindings(device)[0]?.condition
      const decide = (action: string, args: Record<string, unknown>) => condition?.({ action, resource: { kind: 'global' }, args } as never)
      const REFUSED = { kind: 'deny', reason: 'loopback-required: turning the home-auth settings off' }
      const off = ctx.homeAuth.registerComputerOnlySwitch(HOME_AUTH_SWITCH)
      const offReach = ctx.homeAuth.registerComputerOnlySwitch(REACH_SWITCH)
      // Pins the switch's field: each way of writing the section is refused, so a device cannot widen who may ask.
      expect(decide('settings/update', { ns: 'delorun-home-auth', patch: { pairing: { mayAskWithoutWindow: 'tailnet' } } })).toEqual(REFUSED)
      expect(decide('settings/mutate', { ns: 'delorun-home-auth', ops: [{ op: 'set', path: ['pairing', 'mayAskWithoutWindow'], value: 'tailnet' }] })).toEqual(REFUSED)
      expect(decide('settings/replace', { ns: 'delorun-home-auth', section: { secretsDirectory: '/x', pairing: { windowMinutes: 15 } } })).toEqual(REFUSED)
      // Pins the whole-row switch: the secrets directory is refused too, so a device cannot point remote access at an empty directory.
      expect(decide('settings/update', { ns: 'delorun-home-auth', patch: { secretsDirectory: '/x' } })).toEqual({ kind: 'deny', reason: 'loopback-required: turning the home-auth settings off' })
      expect(decide('settings/mutate', { ns: 'delorun-reach', ops: [{ op: 'set', path: ['enabled'], value: true }] })).toEqual({ kind: 'deny', reason: 'loopback-required: turning the remote-access settings off' })
      off()
      offReach()
    })

    it('reads the permission new chats start in from the running permission presets', async () => {
      const access = await fakeRemoteAccess()
      ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership' })
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${await session(2)}` } }), 'reach-tailscale-private')
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
      provider().admit(request({ headers: { cookie: `__Host-delorun-session=${token}` } }), 'reach-tailscale-private')
      const device = reachDevicePrincipal(recordOf(2, ADDRESS).id, 'reach-tailscale-private')
      ctx.emit('session/created', {} as never)
      ctx.emit('session/disposed', {} as never)
      ctx.emit('domain/changed', { domain: 'settings' } as never)
      ctx.emit('domain/changed', { domain: 'workspace' } as never)
      // Pins each invalidation: a stale snapshot hides a new chat from the device or keeps a removed one.
      expect(access.invalidated).toEqual([device, device, device])
    })
  })
  describe('PIN mode page unlocks', () => {
    const PRIVATE = 'reach-tailscale-private'
    const PIN = '482916'
    let pinRecord: string | undefined

    /**
     * Turn PIN mode on with a record derived once for the file, so only the first test pays the scrypt cost: the service
     * restarts over a secrets directory that holds the record.
     */
    async function turnPinOn(): Promise<void> {
      const file = join(directory, 'secrets', 'home-auth', 'pin-mode.json')
      if (pinRecord === undefined) {
        await ctx.homeAuth.setPin(PIN, {})
        pinRecord = await readFile(file, 'utf8')
        return
      }
      await fiber.dispose()
      await writeFile(file, pinRecord, { mode: 0o600 })
      fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth'), phonePowersOnUpgrade: 'full' })
      await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
    }

    /**
     * A device's session, with the page unlock a correct PIN mints on it.
     * @param fill - the device's key fill.
     * @param lifetimeMs - the session's lifetime.
     * @returns the cookie token, the device and the unlock.
     */
    async function unlockedPage(fill: number, lifetimeMs = HOUR): Promise<{ readonly cookie: string; readonly deviceId: string; readonly sessionId: string; readonly unlock: { readonly token: string; readonly unlockId: string } }> {
      const cookie = await session(fill, lifetimeMs)
      const admitted = ctx.homeAuth.admitToken(cookie, PRIVATE)
      if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
      const asker = { deviceId: admitted.session.deviceId, listener: PRIVATE, sessionId: admitted.sessionId } as const
      const unlock = await ctx.homeAuth['state']().pin.unlock(asker, PIN)
      return { cookie, deviceId: admitted.session.deviceId, sessionId: admitted.sessionId, unlock }
    }

    const admitAs = (cookie: string, headers: Record<string, string> = {}, url = '/api/x'): Admission => provider().admit(request({ url, headers: { cookie: `__Host-delorun-session=${cookie}`, ...headers } }), PRIVATE)
    const peerOf = (admission: Admission): PeerScope => {
      if (admission.kind !== 'admitted') throw new Error(`not admitted: ${JSON.stringify(admission)}`)
      return admission.peer
    }

    /** A remote access double that records the policy, as the principal and policy tests above do. */
    async function policyOf(): Promise<RemoteAccessPolicy<ReachDevicePrincipal>> {
      let registered: RemoteAccessPolicy<ReachDevicePrincipal> | undefined
      ctx.provide('remoteAccess')
      ctx.set('remoteAccess', { registerPolicy: (_kind: string, policy: RemoteAccessPolicy<ReachDevicePrincipal>) => { registered = policy; return () => {} }, invalidate: () => {} } as never)
      await new Promise<void>((resolve) => { ctx.inject(['remoteAccess'], () => { resolve() }) })
      if (registered === undefined) throw new Error('no reach-device policy was registered')
      return registered
    }

    it('gives each page its own Peer: a request without the token is locked, the token is stripped, and a sibling tab is not unlocked by it', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const policy = await policyOf()
      const carried = request({ url: '/api/x', headers: { cookie: `__Host-delorun-session=${page.cookie}`, 'delorun-unlock': page.unlock.token } })
      const unlocked = provider().admit(carried, PRIVATE)
      // Pins the strip: no route, upgrade handler or plugin downstream reads the token.
      expect(JSON.stringify(carried.headers)).not.toContain(page.unlock.token)
      const idleEnd = (): number | undefined => ctx.homeAuth.elevationsAtComputer().running.find(record => record.id === page.unlock.unlockId)?.endsAt
      const before = idleEnd()
      await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
      admitAs(page.cookie, { 'delorun-unlock': page.unlock.token })
      // Pins the idle rule: a request that carries the token is a poll, not activity, so it moves no end.
      expect(idleEnd()).toBe(before)
      const locked = admitAs(page.cookie)
      // Pins the per-page Peer: a reload, a new tab or a restored page arrives without the token and gets the locked Peer.
      expect(peerOf(locked)).not.toBe(peerOf(unlocked))
      expect(provider().reachPeer(peerOf(unlocked).id)?.unlockId).toBe(page.unlock.unlockId)
      expect(provider().reachPeer(peerOf(locked).id)?.unlockId).toBeUndefined()
      expect(peerOf(admitAs(page.cookie))).toBe(peerOf(locked))
      const create = (unlockId: string | undefined) => policy.bindings(reachDevicePrincipal(page.deviceId, PRIVATE, unlockId))[0]?.condition?.({ action: 'terminal/create', resource: { kind: 'global' }, args: {} } as never)
      expect(create(page.unlock.unlockId)).toEqual({ kind: 'allow' })
      // Pins the policy's own lookup: the sibling locked tab holds nothing while this page is unlocked.
      expect(create(undefined)).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
      const give = (peer: PeerScope): void => { provider().checkAnswer({ peer, event: 'approval/request', request: { grants: 'full-access' }, value: 'allowed-once' }) }
      expect(() => { give(peerOf(unlocked)) }).not.toThrow()
      // Pins the answer guard: it reads the answering page's Peer, so a locked tab cannot answer what a sibling could.
      expect(() => { give(peerOf(locked)) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    })

    it('reads the token from the WebSocket subprotocol, strips it and keeps the other protocols', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const upgrade = request({ url: '/api/remote.mux', headers: { cookie: `__Host-delorun-session=${page.cookie}`, upgrade: 'websocket', 'sec-websocket-protocol': `delorun.mux, delorun-unlock.${page.unlock.token}` } })
      const admission = provider().admit(upgrade, PRIVATE)
      expect(provider().reachPeer(peerOf(admission).id)?.unlockId).toBe(page.unlock.unlockId)
      // Pins the strip: the upgrade handler sees only the protocol it answers with.
      expect(upgrade.headers).toMatchObject({ 'sec-websocket-protocol': 'delorun.mux' })
      expect(JSON.stringify(upgrade.headers)).not.toContain(page.unlock.token)
    })

    it.each([
      { mode: false, unlocked: false },
      { mode: false, unlocked: true },
      { mode: true, unlocked: false },
      { mode: true, unlocked: true },
    ])('with PIN mode off, a Delorun-Unlock header changes no decision (dangerous mode $mode, device unlocked $unlocked)', async ({ mode, unlocked }) => {
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const cookie = await session(2)
      const plain = provider().admit(request({ url: '/api/x', headers: { cookie: `__Host-delorun-session=${cookie}` } }), PRIVATE)
      const carried = provider().admit(request({ url: '/api/x', headers: { cookie: `__Host-delorun-session=${cookie}`, 'delorun-unlock': 'any-token-at-all' } }), PRIVATE)
      // Pins the ignore: with the mode off the header is stripped and neither refuses nor unlocks the page.
      expect(carried).toMatchObject({ kind: 'admitted' })
      const principalOf = (admission: Admission) => provider().reachPeer(peerOf(admission).id)
      expect(principalOf(carried)).toEqual(principalOf(plain))
      const decide = (admission: Admission, action: string) => {
        const peer = principalOf(admission)
        if (peer === undefined) throw new Error('no principal')
        const principal = reachDevicePrincipal(peer.deviceId, peer.listener, peer.unlockId)
        const policy = createReachAccessPolicy({ admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere', elevationOf: () => (unlocked ? { id: 'elevation-1' } : undefined), pageUnlockOf: () => undefined, unlockModeEnabled: () => false, keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined, computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set([COMPUTER_ONLY_ROW]), defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => mode })
        return policy.bindings(principal)[0]?.condition?.({ action, resource: { kind: 'global' }, args: {} } as never)
      }
      for (const action of [...Object.keys(REACH_ALLOWED_ACTIONS), ...Object.keys(REACH_KEY_ACTIONS), ...Object.keys(REACH_ELEVATED_ACTIONS), ...Object.keys(REACH_DENIED_ACTIONS), 'terminal/create']) {
        expect(decide(carried, action), action).toEqual(decide(plain, action))
      }
      vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (name === 'reachFullAccessGrants' ? { dangerousMode: () => mode } : Context.prototype.get.call(ctx, name as never))) as never)
      vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => (unlocked ? { id: 'elevation-1' } as never : undefined))
      const give = (admission: Admission, grants: string): boolean => {
        try {
          provider().checkAnswer({ peer: peerOf(admission), event: 'approval/request', request: { grants }, value: 'allowed-once' })
          return true
        } catch (_refused) {
          return false
        }
      }
      for (const grants of ['full-access', 'workspace-management', 'external-agent']) expect(give(carried, grants), grants).toBe(give(plain, grants))
    })

    it('completes a real WebSocket handshake for a browser offering delorun.mux and the unlock subprotocol', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const admissions: Admission[] = []
      const server = createServer()
      server.on('upgrade', (upgrade: IncomingMessage, socket: Duplex) => {
        // The admission reads the request as the Connection hands it over: real headers, the token stripped on admit.
        const admission = provider().admit(upgrade, PRIVATE)
        admissions.push(admission)
        if (admission.kind !== 'admitted') {
          socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
          return
        }
        const accept = createHash('sha1').update(`${String(upgrade.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        const offered = String(upgrade.headers['sec-websocket-protocol'] ?? '').split(',').map(entry => entry.trim())
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n${offered.includes('delorun.mux') ? 'sec-websocket-protocol: delorun.mux\r\n' : ''}\r\n`)
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as AddressInfo).port
      // The runtime's own client, as a browser sets the cookie: a header the test adds, since Node has no cookie jar.
      const connect = (token: string): Promise<{ readonly protocol: string } | 'refused'> => new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/remote.mux`, { protocols: ['delorun.mux', `delorun-unlock.${token}`], headers: { cookie: `__Host-delorun-session=${page.cookie}` } } as never)
        socket.addEventListener('open', () => { const { protocol } = socket; socket.close(); resolve({ protocol }) })
        socket.addEventListener('error', () => { resolve('refused') })
      })
      try {
        // Pins the selection and the binding: delorun.mux is the protocol the server answers with, on an unlocked Peer.
        expect(await connect(page.unlock.token)).toEqual({ protocol: 'delorun.mux' })
        const accepted = admissions[0]
        if (accepted?.kind !== 'admitted') throw new Error('the upgrade was not admitted')
        expect(provider().reachPeer(accepted.peer.id)?.unlockId).toBe(page.unlock.unlockId)
        // An unknown token is refused with UNLOCK_INVALID and the handshake does not complete.
        expect(await connect('not-a-token')).toBe('refused')
        expect(admissions[1]).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
      } finally {
        server.closeAllConnections()
        server.close()
      }
    })

    it('lets only an unlocked page give a real-browser grant, and refuses its locked sibling tab and the page once it locks', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const unlocked = peerOf(admitAs(page.cookie, { 'delorun-unlock': page.unlock.token }))
      const sibling = peerOf(admitAs(page.cookie))
      const give = (peer: PeerScope): void => {
        provider().checkAnswer({ peer, event: 'approval/request', request: { grants: 'real-browser' }, value: 'allowed-once' })
      }
      expect(() => { give(unlocked) }).not.toThrow()
      // Pins the per-page rule: a tab of the same device without the unlock is merely signed in.
      expect(() => { give(sibling) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', details: { action: 'real-browser' } }))
      // Pins the end of the page's unlock (its idle end, say) while its Peer still stands: the page is refused.
      vi.spyOn(ctx.homeAuth, 'pageUnlockOf').mockReturnValue(undefined)
      expect(() => { give(unlocked) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', details: { action: 'real-browser' } }))
    })

    it('ignores a token in a query and refuses a repeated or mismatched one, burning the unlock', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const other = await session(3)
      const queried = admitAs(page.cookie, {}, `/api/x?delorun-unlock=${page.unlock.token}`)
      // Pins the carriers: a URL is logged and cached, so it never unlocks.
      expect(provider().reachPeer(peerOf(queried).id)?.unlockId).toBeUndefined()
      expect(ctx.homeAuth.pageUnlockOf(page.unlock.unlockId)).toBeDefined()
      // Pins the binding: another device's cookie with this device's token is refused, and the unlock ends.
      expect(admitAs(other, { 'delorun-unlock': page.unlock.token })).toMatchObject({ kind: 'refused', status: 401, code: 'UNLOCK_INVALID' })
      expect(ctx.homeAuth.pageUnlockOf(page.unlock.unlockId)).toBeUndefined()
      expect(admitAs(page.cookie, { 'delorun-unlock': page.unlock.token })).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
      // Pins the ambiguity rule: two tokens in one request name no unlock.
      expect(admitAs(page.cookie, { 'delorun-unlock': 'a', 'sec-websocket-protocol': 'delorun-unlock.b' })).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
    })

    it('refuses a token from another session of the same device and ends the unlock', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const second = (await ctx.homeAuth.openSession({ deviceId: recordOf(2, ADDRESS).id, listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })).token
      // Pins the session binding: a token copied into another browser profile of the same device is refused.
      expect(admitAs(second, { 'delorun-unlock': page.unlock.token })).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
      expect(ctx.homeAuth.pageUnlockOf(page.unlock.unlockId)).toBeUndefined()
    })

    it('refuses the token after the PIN changes, and ignores it with the mode off', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      await ctx.homeAuth.setPin('739150', {})
      // Pins the end at a PIN change: the old token names nothing.
      expect(admitAs(page.cookie, { 'delorun-unlock': page.unlock.token })).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
      await ctx.homeAuth.turnPinOff()
      const header = { 'delorun-unlock': page.unlock.token }
      const carried = request({ url: '/api/x', headers: { cookie: `__Host-delorun-session=${page.cookie}`, ...header } })
      const off = provider().admit(carried, PRIVATE)
      // Pins the mode check: with the mode off the header is stripped and ignored, and the request is a locked page's.
      expect(provider().reachPeer(peerOf(off).id)?.unlockId).toBeUndefined()
      expect(JSON.stringify(carried.headers)).not.toContain(page.unlock.token)
    })

    it('ends the unlock on the server at lock, closes its session\'s connections and disposes its Peer', async () => {
      await turnPinOn()
      ctx.homeAuth.serve({ listener: PRIVATE, address: ADDRESS, factor: 'tailnet-membership' })
      const page = await unlockedPage(2)
      const closed = vi.spyOn(ctx.connection, 'closeReachConnections')
      const peer = peerOf(admitAs(page.cookie, { 'delorun-unlock': page.unlock.token }))
      const index = created.findIndex(candidate => candidate.id === peer.id)
      ctx.homeAuth['state']().pin.lock(page.unlock.token, { deviceId: page.deviceId as never, listener: PRIVATE, sessionId: page.sessionId })
      // Pins the server-side end: a page that merely hides its screen is still locked here.
      expect(ctx.homeAuth.pageUnlockOf(page.unlock.unlockId)).toBeUndefined()
      expect(closed).toHaveBeenCalledWith({ sessionId: page.sessionId })
      expect(created[index]?.disposal.disposed).toBe(true)
      expect(admitAs(page.cookie, { 'delorun-unlock': page.unlock.token })).toMatchObject({ kind: 'refused', code: 'UNLOCK_INVALID' })
    })
  })
})
