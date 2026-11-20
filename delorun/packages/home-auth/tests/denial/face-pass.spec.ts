/**
 * Denial specs for the Face ID pass (A499, `src/grants.ts`, `src/auth-classes.ts`, the reach policy and the Fetch gate):
 * a pass is bound to one Peer, lasts a fixed time, ends on Lock now, Peer disposal, device removal and restart, and never
 * admits an always-ask or computer row. Each test's comment names the check whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import { ALWAYS_ASK_ACTIONS, AUTH_CLASSES, passAdmitsRow } from '../../src/auth-classes.ts'
import { gateByClass, type GrantGateHome } from '../../src/auth-gate.ts'
import { DEVICE_REMOVE_ACTION, GrantStore, PASS_SETTING_ACTION, type GrantHolder } from '../../src/grants.ts'
import { PASSKEY_DEVICES_ACTION, PASSKEY_REMOVE_ACTION } from '../../src/passkey-routes.ts'
import { createCondition, reachDevicePrincipal, type ReachAccessFacts } from '../../src/reach-access.ts'

const LISTENER = 'reach-tailscale-private'
const OTHER_LISTENER = 'reach-tailscale-funnel'
const HOLDER: GrantHolder = { deviceId: 'device-1', listener: LISTENER }
const GLOBAL = { kind: 'global' } as const
const MINUTE = 60_000

function store(): { grants: GrantStore; clock: { at: number }; lines: string[] } {
  const clock = { at: 5_000_000 }
  const lines: string[] = []
  let counter = 0
  const grants = new GrantStore({ now: () => clock.at, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1), log: (line) => { lines.push(line) } })
  return { grants, clock, lines }
}

function policy(grants: GrantStore, options: { principal?: ReturnType<typeof reachDevicePrincipal>; noPassSeam?: boolean } = {}): (action: string, args?: Record<string, unknown>, resource?: object) => { kind: string; reason?: string } {
  const facts: ReachAccessFacts = {
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => true, keyRefs: () => new Set(['DEEPSEEK_API_KEY']),
    logElevated: () => {}, liftedSettings: () => undefined, computerOnlySwitches: () => [],
    protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(), defaultPermission: () => undefined,
    dangerousMode: () => false,
    faceGrants: () => ({ grants, deviceHasPasskey: () => true, ...options.noPassSeam === true ? {} : { passAdmits: (holder: GrantHolder, row: string) => passAdmitsRow(grants, holder, row) } }),
  }
  const condition = createCondition(facts, options.principal ?? reachDevicePrincipal('device-1', LISTENER))
  return (action, args, resource = GLOBAL) => condition({ action: action as RemoteAccessAction, resource: resource as never, ...args === undefined ? {} : { args } })
}

const INSTALL = { id: 'p1' }

describe('the pass in the store', () => {
  // Removing the minutes check opens a pass at "Every time".
  it('opens none when the setting is Every time', () => {
    const { grants } = store()
    expect(grants.openPass(HOLDER, 0)).toBeUndefined()
    expect(grants.passOf(HOLDER)).toBeUndefined()
  })

  // Removing the end-time check lets a pass live for ever; reopening must not slide it.
  it('lasts exactly the minutes from the Face ID and never slides', () => {
    const { grants, clock } = store()
    const opened = grants.openPass(HOLDER, 15)
    expect(opened?.endsAt).toBe(clock.at + 15 * MINUTE)
    clock.at += 10 * MINUTE
    expect(grants.openPass(HOLDER, 15)?.endsAt).toBe(opened?.endsAt)
    expect(grants.passOf(HOLDER)).toBeDefined()
    clock.at += 5 * MINUTE
    expect(grants.passOf(HOLDER)).toBeUndefined()
  })

  // Removing the Peer from the pass key lets one device's pass admit another device, listener or page.
  it('belongs to one device, listener and Peer', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(grants.passOf({ deviceId: 'device-2', listener: LISTENER })).toBeUndefined()
    expect(grants.passOf({ deviceId: 'device-1', listener: OTHER_LISTENER })).toBeUndefined()
    expect(grants.passOf({ ...HOLDER, unlockId: 'page-2' })).toBeUndefined()
    expect(grants.passOf(HOLDER)).toBeDefined()
  })

  // Each removal of an ending path leaves the pass running after it.
  it('ends on Lock now, Peer disposal, the end of the device\'s session, its removal and a rotation of every session', () => {
    const cases: readonly [string, (grants: GrantStore) => void][] = [
      ['lock-now', grants => { expect(grants.endPass(HOLDER, 'lock-now')).toBe(true) }],
      ['peer-ended', (grants) => { grants.endPeer(HOLDER) }],
      ['session-ended', (grants) => { grants.endDevice('device-1') }],
      ['device-removed', (grants) => { grants.endDevice('device-1', 'device-removed') }],
      ['sessions-rotated', (grants) => { grants.endAll() }],
    ]
    for (const [reason, end] of cases) {
      const { grants, lines } = store()
      grants.openPass(HOLDER, 15)
      end(grants)
      expect(grants.passOf(HOLDER), reason).toBeUndefined()
      expect(lines.at(-1)).toBe(`home-auth: pass.ended device=device-1 listener=${LISTENER} reason=${reason}`)
    }
  })

  // The store lives in memory: a new store, as after a restart, holds no pass.
  it('does not survive a restart', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(store().grants.passOf(HOLDER)).toBeUndefined()
  })

  it('logs its start and its expiry', () => {
    const { grants, clock, lines } = store()
    grants.openPass(HOLDER, 5)
    expect(lines).toEqual([`home-auth: pass.started device=device-1 listener=${LISTENER} minutes=5`])
    clock.at += 5 * MINUTE
    expect(grants.passOf(HOLDER)).toBeUndefined()
    expect(lines.at(-1)).toBe(`home-auth: pass.ended device=device-1 listener=${LISTENER} reason=expired`)
  })

  // Removing the live-pass check in openHoldByPass lets a terminal open a hold with no pass and no grant.
  it('opens a hold for a pass-admitted opener only while the pass is live', () => {
    const { grants } = store()
    const target = { feature: 'terminal', id: 't-1', scope: 'session:s-1' } as const
    grants.openHoldByPass(HOLDER, target)
    expect(grants.holdAdmits(HOLDER, 'terminal', 't-1', 'session:s-1')).toBe(false)
    grants.openPass(HOLDER, 15)
    grants.openHoldByPass(HOLDER, target)
    expect(grants.holdAdmits(HOLDER, 'terminal', 't-1', 'session:s-1')).toBe(true)
  })
})

describe('the always-ask rows', () => {
  // The column is the gate: these are the rows the owner named (A499), and the check fails on any drift.
  it('are exactly devices, passkeys, the Face ID settings and the pass setting', () => {
    expect(AUTH_CLASSES.filter(row => row.alwaysAsk === true).map(row => row.id).sort()).toEqual([
      'auth:/auth/devices/remove', 'auth:/auth/passkey/devices', 'auth:/auth/passkey/pass (write)', 'auth:/auth/passkey/remove',
    ])
    expect([...ALWAYS_ASK_ACTIONS].sort()).toEqual([DEVICE_REMOVE_ACTION, PASSKEY_DEVICES_ACTION, PASS_SETTING_ACTION, PASSKEY_REMOVE_ACTION].sort())
  })

  // Reach and the PIN's own settings have no face row a pass could admit: every row that names them is computer-only.
  it('leave Reach and the PIN mode settings at the computer', () => {
    const named = AUTH_CLASSES.filter(row => /reach|\/auth\/pin\/|home-auth/i.test(row.id))
    expect(named.length).toBeGreaterThan(0)
    for (const row of named) expect(row.authClass === 'computer' || row.alwaysAsk === true, row.id).toBe(true)
  })

  // Removing the alwaysAsk check in passAdmitsRow lets a pass stand in for each family's grant.
  it('are never admitted by a live pass, one family at a time', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 60)
    for (const row of ['auth:/auth/devices/remove', 'auth:/auth/passkey/remove', 'auth:/auth/passkey/devices', 'auth:/auth/passkey/pass (write)']) {
      expect(passAdmitsRow(grants, HOLDER, row), row).toBe(false)
    }
  })

  // Removing the class check lets a pass admit a computer row, a ticket row or a row the table does not list.
  it('leave computer, ticket and unknown rows to their own rules', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 60)
    expect(passAdmitsRow(grants, HOLDER, 'remote:settings/openSettingsDocument')).toBe(false)
    expect(passAdmitsRow(grants, HOLDER, 'auth:/auth/passkey/register')).toBe(false)
    expect(passAdmitsRow(grants, HOLDER, 'remote:nothing/here')).toBe(false)
    expect(passAdmitsRow(grants, HOLDER, 'remote:pluginManager/installBundle')).toBe(true)
  })
})

describe('the pass in the reach policy', () => {
  // Removing the pass branch in grantFor makes a passkey phone confirm every install in a pass.
  it('admits a face row from the same device, listener and Peer, over and over, within the pass', () => {
    const { grants } = store()
    const decide = policy(grants)
    expect(decide('pluginManager/installBundle', INSTALL).kind).toBe('deny')
    grants.openPass(HOLDER, 15)
    expect(decide('pluginManager/installBundle', INSTALL).kind).toBe('allow')
    expect(decide('pluginManager/installBundle', { id: 'p2' }).kind).toBe('allow')
    expect(decide('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'k' }).kind).toBe('allow')
  })

  // Removing the end-time check admits a call after the pass ended.
  it('refuses after expiry', () => {
    const { grants, clock } = store()
    grants.openPass(HOLDER, 5)
    clock.at += 5 * MINUTE
    expect(policy(grants)('pluginManager/installBundle', INSTALL).kind).toBe('deny')
  })

  // Removing the device, listener or page unlock from the pass key admits another Peer on this pass.
  it('refuses another device, another listener and another Peer', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(policy(grants, { principal: reachDevicePrincipal('device-2', LISTENER) })('pluginManager/installBundle', INSTALL).kind).toBe('deny')
    expect(policy(grants, { principal: reachDevicePrincipal('device-1', OTHER_LISTENER) })('pluginManager/installBundle', INSTALL).kind).toBe('deny')
    expect(policy(grants, { principal: reachDevicePrincipal('device-1', LISTENER, 'page-2') })('pluginManager/installBundle', INSTALL).kind).toBe('deny')
  })

  it('refuses after Lock now, device removal and restart', () => {
    for (const end of [(grants: GrantStore) => { grants.endPass(HOLDER, 'lock-now') }, (grants: GrantStore) => { grants.endDevice('device-1', 'device-removed') }]) {
      const { grants } = store()
      grants.openPass(HOLDER, 15)
      end(grants)
      expect(policy(grants)('pluginManager/installBundle', INSTALL).kind).toBe('deny')
    }
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(policy(store().grants)('pluginManager/installBundle', INSTALL).kind).toBe('deny')
  })

  // The pass never lifts the refusals that come before any grant: a protected row or an unlisted command stays refused.
  it('keeps the refusals no grant lifts', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(policy(grants)('commands/execute', { command: '/not-a-device-command' }).kind).toBe('deny')
  })

  // Without the hold opened by the pass, a terminal created in a pass would stop when the pass ends.
  it('admits terminal/create with no grant and keeps the terminal on its hold after the pass ends', () => {
    const { grants, clock } = store()
    grants.openPass(HOLDER, 5)
    const decide = policy(grants)
    const chat = { kind: 'session', id: 's-1' }
    expect(decide('terminal/create', { request: { id: 't-1', cols: 80, rows: 24 } }, chat).kind).toBe('allow')
    clock.at += 4 * MINUTE
    expect(decide('terminal/attach', { id: 't-1' }, chat).kind).toBe('allow')
    clock.at += 2 * MINUTE
    expect(grants.passOf(HOLDER)).toBeUndefined()
    expect(decide('terminal/attach', { id: 't-1' }, chat).kind).toBe('allow')
    expect(decide('terminal/attach', { id: 't-2' }, chat).kind).toBe('deny')
  })

  // A policy built without the pass seam admits nothing by a pass.
  it('admits nothing by a pass when the facts carry no pass seam', () => {
    const { grants } = store()
    grants.openPass(HOLDER, 15)
    expect(policy(grants, { noPassSeam: true })('pluginManager/installBundle', INSTALL).kind).toBe('deny')
  })
})

describe('the pass at the Fetch gate', () => {
  const peer = { principal: reachDevicePrincipal('device-1', LISTENER) }
  function gateWorld(row: string): { grants: GrantStore; clock: { at: number }; ran: Request[]; gate: ReturnType<typeof gateByClass> } {
    const { grants, clock } = store()
    const ran: Request[] = []
    const home: GrantGateHome = {
      faceGrants: () => grants, deviceHasPasskey: () => true,
      arrivalOf: () => ({ listener: LISTENER, host: 'h.example.ts.net', source: 'test' }), dangerousMode: () => false, elevationOf: () => undefined, pageUnlockOf: () => undefined, unlockModeEnabled: () => true,
    }
    const gate = gateByClass(() => home, (request) => { ran.push(request); return Promise.resolve(new Response('ok')) }, { row, action: 'plugin-packs/enqueue', legacy: { renews: true } })
    return { grants, clock, ran, gate }
  }
  const call = (): Request => new Request('https://h.example.ts.net/api/delorun/packs/enqueue', { method: 'POST', body: '{"pack":"a"}' })

  // Removing the pass branch in gateByClass makes every plugin pack install ask in a pass; removing its end check admits after expiry.
  it('admits a face route within the pass and refuses after it', async () => {
    const { grants, clock, ran, gate } = gateWorld('route:plugin-packs/src/routes.ts#path (write)')
    const first = call()
    gate.admitPeer(first, peer)
    expect((await gate.fetch(first)).status).toBe(403)
    grants.openPass(HOLDER, 5)
    const second = call()
    gate.admitPeer(second, peer)
    expect((await gate.fetch(second)).status).toBe(200)
    clock.at += 5 * MINUTE
    const third = call()
    gate.admitPeer(third, peer)
    expect((await gate.fetch(third)).status).toBe(403)
    expect(ran).toHaveLength(1)
  })

  // Removing the Peer from the pass key admits another device's request on this device's pass.
  it('refuses another device\'s request', async () => {
    const { grants, gate } = gateWorld('route:plugin-packs/src/routes.ts#path (write)')
    grants.openPass({ deviceId: 'device-2', listener: LISTENER }, 15)
    const request = call()
    gate.admitPeer(request, peer)
    expect((await gate.fetch(request)).status).toBe(403)
  })
})
