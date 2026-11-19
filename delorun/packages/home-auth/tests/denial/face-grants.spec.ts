/**
 * Denial specs for the Face ID grants as the reach policy and the Fetch gate use them (`src/reach-access.ts`,
 * `src/auth-gate.ts`, `src/authenticator.ts`). A refusal here is never weakened: each test names the check whose
 * removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import { gateByClass, GRANT_HEADER, type GrantGateHome } from '../../src/auth-gate.ts'
import { answerKey, GrantStore, hashArgs, hashRequest } from '../../src/grants.ts'
import { createCondition, reachDevicePrincipal, type ReachAccessFacts } from '../../src/reach-access.ts'
import { REACH_DEVICE } from '../../src/reach-access.ts'

const LISTENER = 'reach-tailscale-private'
const DEVICE = reachDevicePrincipal('device-1', LISTENER)
const HOLDER = { deviceId: 'device-1', listener: LISTENER } as const
const GLOBAL = { kind: 'global' } as const

function world(options: { passkey?: boolean; unlockMode?: boolean; flag?: boolean; elevation?: boolean } = {}): { grants: GrantStore; clock: { at: number }; facts: ReachAccessFacts; decide: (action: string, args?: Record<string, unknown>, resource?: object) => { kind: string; reason?: string } } {
  const clock = { at: 5_000_000 }
  let counter = 0
  const grants = new GrantStore({ now: () => clock.at, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1) })
  const facts: ReachAccessFacts = {
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => (options.elevation === true ? { id: 'unlock-1' } : undefined), pageUnlockOf: () => undefined,
    unlockModeEnabled: () => options.unlockMode ?? true, keyRefs: () => new Set(['DEEPSEEK_API_KEY']),
    logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined, computerOnlySwitches: () => [],
    protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(), defaultPermission: () => undefined,
    phonePowers: () => 'full' as const, dangerousMode: () => false,
    faceGrants: () => (options.flag === false ? undefined : { grants, deviceHasPasskey: () => options.passkey ?? true }),
  }
  const condition = createCondition(facts, DEVICE)
  return { grants, clock, facts, decide: (action, args, resource = GLOBAL) => condition({ action: action as RemoteAccessAction, resource: resource as never, ...args === undefined ? {} : { args } }) }
}

describe('a face action in the reach policy', () => {
  const ARGS = { id: 'p1' }
  const hash = hashArgs(ARGS) ?? ''

  // Removing the grant check lets a passkey device run an elevated action with nothing.
  it('is refused without a grant', () => {
    expect(world().decide('pluginManager/installBundle', ARGS)).toEqual({ kind: 'deny', reason: 'elevation-required: pluginManager/installBundle' })
  })

  // Removing the hash from the key lets a grant for body A admit body B.
  it('is refused for other arguments than the grant covers, and the grant survives', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(decide('pluginManager/installBundle', { id: 'p2' }).kind).toBe('deny')
    expect(grants.has(HOLDER, 'pluginManager/installBundle', hash)).toBe(true)
  })

  // Removing the consume-after-allow makes the grant reusable; removing it from the allow path spends nothing.
  it('is admitted once by its grant and refused when replayed', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(decide('pluginManager/installBundle', ARGS).kind).toBe('allow')
    expect(decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
  })

  // A question without arguments lists the action and never spends a grant.
  it('is listed by a question without arguments, which uses nothing up', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(decide('pluginManager/installBundle').kind).toBe('allow')
    expect(grants.has(HOLDER, 'pluginManager/installBundle', hash)).toBe(true)
  })

  // Removing the expiry lets a grant outlive 30 seconds.
  it('is refused after the grant expired', () => {
    const { grants, clock, decide } = world()
    grants.mint(HOLDER, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    clock.at += 30_000
    expect(decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
  })

  // A passkey device is admitted by a grant alone: its running unlock (a code or a PIN window) opens nothing.
  it('is refused to a passkey device that holds a running unlock', () => {
    expect(world({ elevation: true }).decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
  })

  // A device with no passkey keeps the unlock a code or its PIN started.
  it('is admitted to a device with no passkey by its running unlock', () => {
    expect(world({ passkey: false, elevation: true }).decide('pluginManager/installBundle', ARGS).kind).toBe('allow')
    expect(world({ passkey: false }).decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
  })

  // While the preview flag is off no grant counts and the unlock decides, as before.
  it('keeps the unlock check while the flag is off', () => {
    const { grants, decide } = world({ flag: false, passkey: false })
    grants.mint(HOLDER, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
    expect(world({ flag: false, elevation: true }).decide('pluginManager/installBundle', ARGS).kind).toBe('allow')
  })

  // Another device's grant never admits this one.
  it('is refused with another device\'s grant', () => {
    const { grants, decide } = world()
    grants.mint({ deviceId: 'device-2', listener: LISTENER }, [{ action: 'pluginManager/installBundle', hash }], 'passkey')
    expect(decide('pluginManager/installBundle', ARGS).kind).toBe('deny')
  })
})

describe('credentials/set on a home with only a passkey', () => {
  const ARGS = { ref: 'DEEPSEEK_API_KEY', value: 'k' }
  // Removing unlockModeEnabled (reading pinEnabled again) leaves a home with a passkey and no PIN open to a key swap.
  it('is refused without a grant', () => {
    expect(world({ unlockMode: true }).decide('credentials/set', ARGS).kind).toBe('deny')
  })
  it('is admitted with a grant for exactly those arguments, and presence stays free', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'credentials/set', hash: hashArgs(ARGS) ?? '' }], 'passkey')
    expect(decide('credentials/set', ARGS).kind).toBe('allow')
    expect(decide('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] }).kind).toBe('allow')
  })
})

describe('holds for terminals', () => {
  // The Remote method takes (agent, request), so the wire arguments nest the request.
  const create = { request: { id: 't-1', cols: 80, rows: 24 } }
  // Removing the id binding lets a hold for one terminal admit another; removing the opener rule lets any grant open a hold.
  it('admit the terminal the tap opened and no other', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'terminal/create', hash: hashArgs(create) ?? '', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
    expect(decide('terminal/create', create).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-1' }).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-2' }).kind).toBe('deny')
    expect(decide('terminal/create', { request: { ...create.request, id: 't-2' } }).kind).toBe('deny')
  })
  // Removing the metadata-only rule lets a hold on terminal A stream the events or output of terminal B.
  it('give no output or events of another terminal: id-less watch needs its own grant, listing rides the hold', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'terminal/create', hash: hashArgs(create) ?? '', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
    decide('terminal/create', create)
    expect(decide('terminal/list', {}).kind).toBe('allow')
    expect(decide('terminal/shells', {}).kind).toBe('allow')
    expect(decide('terminal/watch', {}).kind).toBe('deny')
    expect(decide('terminal/retain', { id: 't-2' }).kind).toBe('deny')
    expect(decide('terminal/attach', { id: 't-2' }).kind).toBe('deny')
  })
  it('are not opened by a grant whose call opens no terminal', () => {
    const { grants, decide } = world()
    const settings = { ns: 'x', patch: {} }
    grants.mint(HOLDER, [{ action: 'settings/update', hash: hashArgs(settings) ?? '', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
    expect(decide('settings/update', settings).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-1' }).kind).toBe('deny')
  })
})

describe('an event question (P1-1)', () => {
  // Removing the `event:` refusal in grantFor lets a locked phone receive the dynamic-plugin and inspect events.
  it('is refused to a passkey device and to a locked no-passkey device on a PIN home, however it is asked', () => {
    for (const action of ['event:cordis/dynamic-package', 'event:cordis/request-run', 'event:cordis/inspect-query']) {
      expect(world({ passkey: true }).decide(action), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
      expect(world({ passkey: false, unlockMode: true }).decide(action), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
    }
  })
  it('is still admitted to a no-passkey device that holds a running unlock, and a method listing stays allowed', () => {
    expect(world({ passkey: false, elevation: true }).decide('event:cordis/dynamic-package').kind).toBe('allow')
    expect(world().decide('pluginManager/installBundle').kind).toBe('allow')
  })
})

describe('holds are bound to the resource and the device (P2-1, P2-2)', () => {
  const create = { request: { id: 't-1', cols: 80, rows: 24 } }
  const sessionA = { kind: 'session', id: 'session-a' }
  const sessionB = { kind: 'session', id: 'session-b' }
  // Removing the scope from the hold key lets a hold on terminal X of chat A admit terminal X of chat B.
  it('admit the terminal of the chat the tap opened and not the same id in another chat', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'terminal/create', hash: hashArgs(create) ?? '', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
    expect(decide('terminal/create', create, sessionA).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-1' }, sessionA).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-1' }, sessionB).kind).toBe('deny')
    expect(decide('terminal/list', {}, sessionB).kind).toBe('deny')
    expect(decide('terminal/list', {}, sessionA).kind).toBe('allow')
  })
  // Removing unlockId from the hold key lets another page's Peer of the same device use a hold it never opened; removing endPeer leaves the hold after its Peer is disposed.
  it('belong to the Peer that opened them: another page of the device is refused, and the hold ends with its Peer', () => {
    const { grants, facts } = world()
    const peerA = reachDevicePrincipal('device-1', LISTENER, 'unlock-a')
    const peerB = reachDevicePrincipal('device-1', LISTENER, 'unlock-b')
    const ask = (principal: typeof peerA, action: string, args: Record<string, unknown>): string => createCondition(facts, principal)({ action: action as RemoteAccessAction, resource: sessionA as never, args }).kind
    grants.mint({ ...HOLDER, unlockId: 'unlock-a' }, [{ action: 'terminal/create', hash: hashArgs(create) ?? '', hold: { feature: 'terminal', id: 't-1' } }], 'passkey')
    expect(ask(peerA, 'terminal/create', create)).toBe('allow')
    expect(ask(peerA, 'terminal/attach', { id: 't-1' })).toBe('allow')
    expect(ask(peerB, 'terminal/attach', { id: 't-1' })).toBe('deny')
    expect(ask(peerB, 'terminal/list', {})).toBe('deny')
    grants.endPeer({ ...HOLDER, unlockId: 'unlock-a' })
    expect(ask(peerA, 'terminal/attach', { id: 't-1' })).toBe('deny')
  })
  // Removing the scope on the picker keeps it a device-wide hold.
  it('give the folder picker a hold but never a folder write: createDirectory needs its own grant (P3-7)', () => {
    const { grants, decide } = world()
    grants.mint(HOLDER, [{ action: 'directoryPicker/list', hash: hashArgs({ path: '/' }) ?? '', hold: { feature: 'picker', id: 'directoryPicker' } }], 'passkey')
    expect(decide('directoryPicker/list', { path: '/' }).kind).toBe('allow')
    expect(decide('directoryPicker/list', { path: '/home' }).kind).toBe('allow')
    expect(decide('directoryPicker/createDirectory', { path: '/home/new' }).kind).toBe('deny')
    grants.mint(HOLDER, [{ action: 'directoryPicker/createDirectory', hash: hashArgs({ path: '/home/new' }) ?? '' }], 'passkey')
    expect(decide('directoryPicker/createDirectory', { path: '/home/new' }).kind).toBe('allow')
    expect(decide('directoryPicker/createDirectory', { path: '/home/new' }).kind).toBe('deny')
  })
})

describe('a page unlock made before enrolment (P3-1)', () => {
  // Removing the passkey check on pageUnlocked lets a PIN page unlock made before enrolment skip the key-write grant.
  it('does not lift the grant for credentials/set on a device that now holds a passkey', () => {
    const clock = { at: 5_000_000 }
    const grants = new GrantStore({ now: () => clock.at, random: size => new Uint8Array(size).fill(7) })
    const facts: ReachAccessFacts = {
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: () => undefined, pageUnlockOf: () => ({ id: 'page-1' } as never), unlockModeEnabled: () => true, keyRefs: () => new Set(['DEEPSEEK_API_KEY']),
      logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined, computerOnlySwitches: () => [],
      protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(), defaultPermission: () => undefined,
      phonePowers: () => 'full' as const, dangerousMode: () => false,
      faceGrants: () => ({ grants, deviceHasPasskey: () => true }),
    }
    const condition = createCondition(facts, reachDevicePrincipal('device-1', LISTENER, 'page-1'))
    expect(condition({ action: 'credentials/set' as RemoteAccessAction, resource: GLOBAL as never, args: { ref: 'DEEPSEEK_API_KEY', value: 'k' } }).kind).toBe('deny')
  })
})

describe('answer grants (P2-3)', () => {
  const key = (agent: string, callId: string, marker: string): string => answerKey({ agent, callId, grants: marker })
  // Removing the agent or the marker from the key lets a grant for one prompt answer another that shares its call id.
  it('keeps two prompts that share a call id apart', () => {
    const grants = new GrantStore({ now: () => 5_000_000, random: size => new Uint8Array(size).fill(3) })
    grants.mintAnswer(HOLDER, key('chat-a', 'call_0', 'full-access'), 'allowed-once')
    expect(grants.consumeAnswer(HOLDER, key('chat-b', 'call_0', 'full-access'), 'allowed-once')).toBeUndefined()
    expect(grants.consumeAnswer(HOLDER, key('chat-a', 'call_0', 'workspace-management'), 'allowed-once')).toBeUndefined()
    expect(grants.consumeAnswer(HOLDER, key('chat-a', 'call_0', 'full-access'), 'allowed-once')).toBeDefined()
  })
})

describe('Phone powers Careful on a Fetch gate (P2-5, F11)', () => {
  const ROW = 'route:plugin-packs/src/routes.ts#path (write)'
  const peer = { principal: DEVICE }
  const careful = async (options: { passkey: boolean; level: 'careful' | 'full' }): Promise<{ status: number; ran: number }> => {
    const { grants } = world()
    let ran = 0
    const home: GrantGateHome = {
      passkeysEnabled: () => true, faceGrants: () => grants, deviceHasPasskey: () => options.passkey,
      arrivalOf: () => ({ listener: LISTENER, host: 'h.ts.net', source: 'test' }), dangerousMode: () => false, elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => true,
      phonePowers: () => ({ level: options.level }) as never,
    }
    const gate = gateByClass(() => home, () => { ran += 1; return Promise.resolve(new Response('ok')) }, { row: ROW, action: 'plugin-packs/enqueue', legacy: { renews: false, phonePowers: 'full' } })
    const body = '{"pack":"a"}'
    const hash = hashRequest({ method: 'POST', path: '/api/delorun/packs/enqueue', body: new TextEncoder().encode(body) }) ?? ''
    const id = grants.mint(HOLDER, [{ action: 'plugin-packs/enqueue', hash }], 'passkey').grantId
    const request = new Request('https://h.ts.net/api/delorun/packs/enqueue', { method: 'POST', body, headers: { [GRANT_HEADER]: id } })
    gate.admitPeer(request, peer)
    const response = await gate.fetch(request)
    return { status: response.status, ran }
  }
  // Removing the Careful check before the grant lookup lets a grant open a route Careful refuses.
  it('refuses a Full-only route under Careful for a device with a matching grant, passkey or not', async () => {
    expect(await careful({ passkey: true, level: 'careful' })).toEqual({ status: 403, ran: 0 })
    expect(await careful({ passkey: false, level: 'careful' })).toEqual({ status: 403, ran: 0 })
    expect(await careful({ passkey: true, level: 'full' })).toEqual({ status: 200, ran: 1 })
  })
})

describe('the Fetch gate hashes the query string (P3-2)', () => {
  const ROW = 'route:plugin-packs/src/routes.ts#path (write)'
  // Removing the search from the hashed path lets a grant for one query admit another.
  it('refuses the same path with another query', async () => {
    const { grants } = world()
    const home: GrantGateHome = {
      passkeysEnabled: () => true, faceGrants: () => grants, deviceHasPasskey: () => true,
      arrivalOf: () => ({ listener: LISTENER, host: 'h.ts.net', source: 'test' }), dangerousMode: () => false, elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => true,
    }
    let ran = 0
    const gate = gateByClass(() => home, () => { ran += 1; return Promise.resolve(new Response('ok')) }, { row: ROW, action: 'plugin-packs/enqueue', legacy: { renews: true } })
    const hash = hashRequest({ method: 'POST', path: '/api/delorun/packs/enqueue?pack=a', body: new Uint8Array(0) }) ?? ''
    const id = grants.mint(HOLDER, [{ action: 'plugin-packs/enqueue', hash }], 'passkey').grantId
    const other = new Request('https://h.ts.net/api/delorun/packs/enqueue?pack=b', { method: 'POST', headers: { [GRANT_HEADER]: id } })
    gate.admitPeer(other, { principal: DEVICE })
    expect((await gate.fetch(other)).status).toBe(403)
    const same = new Request('https://h.ts.net/api/delorun/packs/enqueue?pack=a', { method: 'POST', headers: { [GRANT_HEADER]: id } })
    gate.admitPeer(same, { principal: DEVICE })
    expect((await gate.fetch(same)).status).toBe(200)
    expect(ran).toBe(1)
  })
})

describe('the Fetch gate for a face route', () => {
  const ROW = 'route:plugin-packs/src/routes.ts#path (write)'
  const ACTION = 'plugin-packs/enqueue'
  const peer = { principal: DEVICE }

  function gateWorld(options: { passkey?: boolean; flag?: boolean } = {}): { grants: GrantStore; ran: Request[]; gate: ReturnType<typeof gateByClass> } {
    const { grants } = world()
    const ran: Request[] = []
    const home: GrantGateHome = {
      passkeysEnabled: () => options.flag ?? true, faceGrants: () => grants, deviceHasPasskey: () => options.passkey ?? true,
      arrivalOf: () => ({ listener: LISTENER, host: 'h.ts.net', source: 'test' }), dangerousMode: () => false, elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => true,
    }
    const gate = gateByClass(() => home, (request) => { ran.push(request); return Promise.resolve(new Response('ok')) }, { row: ROW, action: ACTION, legacy: { renews: true } })
    return { grants, ran, gate }
  }

  const call = (body: string, headers: Record<string, string> = {}): Request => new Request('https://h.ts.net/api/delorun/packs/enqueue', { method: 'POST', body, headers })
  const grantFor = (grants: GrantStore, body: string): string => {
    const hash = hashRequest({ method: 'POST', path: '/api/delorun/packs/enqueue', body: new TextEncoder().encode(body) }) ?? ''
    return grants.mint(HOLDER, [{ action: ACTION, hash }], 'passkey').grantId
  }

  // Removing the home's own hashing and trusting a client-sent hash would admit body B on a grant for body A.
  it('refuses body B on a grant for body A and runs body A once', async () => {
    const { grants, ran, gate } = gateWorld()
    const id = grantFor(grants, '{"pack":"a"}')
    const requestB = call('{"pack":"b"}', { [GRANT_HEADER]: id })
    expect(gate.admitPeer(requestB, peer)).toBe(true)
    expect((await gate.fetch(requestB)).status).toBe(403)
    const requestA = call('{ "pack": "a" }', { [GRANT_HEADER]: id })
    gate.admitPeer(requestA, peer)
    expect((await gate.fetch(requestA)).status).toBe(200)
    expect(ran).toHaveLength(1)
    // The header never reaches the route's handler.
    expect(ran[0]?.headers.has(GRANT_HEADER)).toBe(false)
    expect(await ran[0]?.text()).toBe('{ "pack": "a" }')
    const replay = call('{"pack":"a"}', { [GRANT_HEADER]: id })
    gate.admitPeer(replay, peer)
    expect((await gate.fetch(replay)).status).toBe(403)
  })

  // The header names the grant: removing the comparison lets a call run on a hash match alone, or on any id.
  it('refuses a call whose header names another grant or none', async () => {
    const { grants, gate } = gateWorld()
    grantFor(grants, '{"pack":"a"}')
    for (const headers of [{}, { [GRANT_HEADER]: 'wrong' }]) {
      const request = call('{"pack":"a"}', headers)
      gate.admitPeer(request, peer)
      expect((await gate.fetch(request)).status).toBe(403)
    }
  })

  // Removing the size cap lets an unbounded body be read to hash it.
  it('refuses a body over the cap', async () => {
    const { gate } = gateWorld()
    const request = call('x'.repeat(1024 * 1024 + 1))
    gate.admitPeer(request, peer)
    expect((await gate.fetch(request)).status).toBe(403)
  })

  // A row the table does not list, or a computer row, fails at registration.
  it('throws at registration for an unlisted row and a computer row', () => {
    const home = (): undefined => undefined
    expect(() => gateByClass(home, () => Promise.resolve(new Response('')), { row: 'route:nothing', action: 'x', legacy: { renews: true } })).toThrow(/does not list/)
    expect(() => gateByClass(home, () => Promise.resolve(new Response('')), { row: 'auth:/auth/passkey/add/approve', action: 'x', legacy: { renews: true } })).toThrow(/computer row/)
    expect(() => gateByClass(home, () => Promise.resolve(new Response('')), { row: 'auth:/auth/passkey/register', action: 'x', legacy: { renews: true } })).toThrow(/ticket row/)
  })

  // Removing the terminal refusal lets a Fetch route open a hold pinned to the global scope that every chat shares (P3-1).
  it('refuses a terminal hold at registration until it carries a scope', () => {
    expect(() => gateByClass(() => undefined, () => Promise.resolve(new Response('')), { row: ROW, action: 'x', legacy: { renews: true }, hold: { feature: 'terminal', idOf: () => 't-1', opens: true } })).toThrow(/terminal hold/)
  })

  it('admits only a reach device', () => {
    const { gate } = gateWorld()
    expect(gate.admitPeer(call('{}'), { principal: { kind: 'owner' } })).toBe(false)
    expect(REACH_DEVICE).toBe('reach-device')
  })
})
