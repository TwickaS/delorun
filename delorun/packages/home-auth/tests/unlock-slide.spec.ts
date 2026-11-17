/**
 * An unlock approved at the computer slides: its minutes count from the last action that needed it, an absolute cap
 * ends it however much it is used, and only an action that needed the unlock renews it.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type StudioAddress } from '@delorun/contract-admission'
import { gateByUnlock } from '../src/computer-only.ts'
import { createCondition, ELEVATED_READS, REACH_ELEVATED_ACTIONS, reachDevicePrincipal, RENEWING_ACTIONS, type ReachAccessFacts } from '../src/reach-access.ts'
import { claimOf, homeFixture, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const MINUTE = 60_000

let home: Home | undefined
afterEach(async () => {
  await home?.dispose()
  home = undefined
})

/**
 * A served home with an unlock of 15 minutes and the cap given, and one device unlocked at the computer.
 * @param cap - the cap in minutes.
 * @returns the home, the device and its unlock.
 */
async function unlocked(cap: number) {
  home = await homeFixture({ unlockCapMinutes: cap })
  home.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', elevationMinutes: 15 })
  const issued = await home.auth.issueOwnerCode()
  const claimed = await home.auth.claim(claimOf(issued.code, { address: ADDRESS }))
  const opened = await home.auth.openSession({ deviceId: claimed.device.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: SESSION_LIMITS.reach.absoluteMs })
  const admitted = home.auth.admitToken(opened.token, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  const state = home.auth.requestElevation(admitted.sessionId, admitted.session)
  if (state.kind !== 'pending') throw new Error('no request is waiting')
  const record = home.auth.approveElevation(state.requestId, state.code)
  return { home, deviceId: claimed.device.id, record }
}

describe('a sliding unlock', () => {
  it('lasts its minutes after the last action that needed it, not after the unlock', async () => {
    const { home: served, deviceId, record } = await unlocked(480)
    served.clock.advance(14 * MINUTE)
    served.auth.touchUnlock(record.id)
    // Pins the renewal: an action at minute 14 keeps the unlock past minute 15.
    served.clock.advance(14 * MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)?.endsAt).toBe(record.startedAt + 29 * MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeDefined()
    served.clock.advance(15 * MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
  })

  it('is not revived by a renewal after its end has passed', async () => {
    const { home: served, deviceId, record } = await unlocked(480)
    served.clock.advance(15 * MINUTE)
    // Pins the end check: a touch in the gap before the timer reaps the unlock must not extend it.
    served.auth.touchUnlock(record.id)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
  })

  it('ends after the minutes without an action that needed it', async () => {
    const { home: served, deviceId } = await unlocked(480)
    served.clock.advance(15 * MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
  })

  it('ends at the absolute cap however much it is used', async () => {
    const { home: served, deviceId, record } = await unlocked(40)
    for (let used = 0; used < 3; used += 1) {
      served.clock.advance(10 * MINUTE)
      served.auth.touchUnlock(record.id)
    }
    // Pins the cap: the third touch at minute 30 would reach minute 45, and the unlock still ends at minute 40.
    expect(served.auth.elevationOf(deviceId, LISTENER)?.endsAt).toBe(record.startedAt + 40 * MINUTE)
    served.clock.advance(10 * MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
  })

  it('ends at once for a lock, a revoke and a removal, however far it slid', async () => {
    const { home: served, deviceId, record } = await unlocked(480)
    served.clock.advance(10 * MINUTE)
    served.auth.touchUnlock(record.id)
    served.auth.lockElevation(deviceId, LISTENER)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
  })

  it('refuses a listener whose unlock minutes exceed the cap', async () => {
    home = await homeFixture({ unlockCapMinutes: 10 })
    expect(() => home?.auth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', elevationMinutes: 15 })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
  })
})

describe('which actions renew an unlock', () => {
  it('classify every elevated action, in exactly one of the renewing and non-renewing lists', () => {
    // Pins the gate: a new elevated action fails here until its author decides whether it renews.
    const unclassified = Object.keys(REACH_ELEVATED_ACTIONS).filter(action => !RENEWING_ACTIONS.has(action) && !ELEVATED_READS.has(action))
    expect(unclassified).toEqual([])
    expect([...RENEWING_ACTIONS].filter(action => ELEVATED_READS.has(action))).toEqual([])
    const known = new Set([...Object.keys(REACH_ELEVATED_ACTIONS), 'session/create'])
    expect([...RENEWING_ACTIONS, ...ELEVATED_READS].filter(action => !known.has(action))).toEqual([])
  })

  it('keep the keepalives off the renewing list and the everyday state-changing steps on it', () => {
    for (const action of ['terminal/retain', 'terminal/attach', 'terminal/watch', 'terminal/list', 'mcpManager/watch', 'dynamicCordisRunner/reportRenderFailure']) expect(RENEWING_ACTIONS.has(action), action).toBe(false)
    for (const action of ['terminal/create', 'settings/update', 'pluginManager/setBundleEnabled', 'commands/execute', 'mcpManager/restart', 'workspace/create', 'session/create']) expect(RENEWING_ACTIONS.has(action), action).toBe(true)
  })

  it('end the unlock at its original end when only reads and keepalives are polled past the slide minutes', async () => {
    const { home: served, deviceId, record } = await unlocked(480)
    const real: ReachAccessFacts = {
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: (id, listener) => served.auth.elevationOf(id, listener), touchUnlock: id => { served.auth.touchUnlock(id) },
      pageUnlockOf: () => undefined, pinEnabled: () => false,
      keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(),
      defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => false,
    }
    const condition = createCondition(real, reachDevicePrincipal(deviceId, LISTENER))
    const polled = ['terminal/list', 'terminal/watch', 'terminal/retain', 'terminal/attach', 'mcpManager/watch', 'directoryPicker/list', 'dynamicCordisRunner/getClientCode']
    for (let minute = 1; minute < 15; minute += 1) {
      served.clock.advance(MINUTE)
      for (const action of polled) expect(condition({ action: action as never, resource: { kind: 'global' }, args: {} }).kind, `${action} at ${String(minute)}`).toBe('allow')
    }
    // Pins the original end: fourteen minutes of polling moved nothing, so the unlock ends at its fifteenth minute.
    expect(served.auth.elevationOf(deviceId, LISTENER)?.endsAt).toBe(record.endsAt)
    served.clock.advance(MINUTE)
    expect(served.auth.elevationOf(deviceId, LISTENER)).toBeUndefined()
    expect(condition({ action: 'terminal/list' as never, resource: { kind: 'global' }, args: {} })).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/list' })
  })
})

describe('what renews an unlock', () => {
  const facts = (touch: (id: string) => void): ReachAccessFacts => ({
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => ({ id: 'unlock-1' }), touchUnlock: touch, pageUnlockOf: () => undefined, pinEnabled: () => false,
    keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
    computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(),
    defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => false,
  })
  const principal = reachDevicePrincipal('device-1', LISTENER)
  const resource = { kind: 'global' } as const

  it('is an action that needed the unlock, and not a read, polling or a question without arguments', () => {
    const touch = vi.fn()
    const condition = createCondition(facts(touch), principal)
    // Pins the reads: they decide without the unlock, so they never touch it.
    condition({ action: 'session/list', resource, args: {} })
    condition({ action: 'session/state', resource })
    condition({ action: 'terminal/create' as never, resource })
    expect(touch).not.toHaveBeenCalled()
    // Pins the renewal: a call of an elevated action renews the unlock it ran under.
    condition({ action: 'terminal/create' as never, resource, args: {} })
    expect(touch).toHaveBeenCalledWith('unlock-1')
  })

  it('is never an elevated read: listing, watching and reattaching leave the unlock to end at its own time', () => {
    const touch = vi.fn()
    const condition = createCondition(facts(touch), principal)
    expect([...ELEVATED_READS].every(action => Object.hasOwn(REACH_ELEVATED_ACTIONS, action))).toBe(true)
    for (const action of ELEVATED_READS) {
      // Pins the read list: a studio that re-lists or reopens a watch on reconnect must not keep an idle unlock alive.
      expect(condition({ action: action as never, resource, args: {} }).kind, action).toBe('allow')
    }
    expect(touch).not.toHaveBeenCalled()
    for (const action of ['terminal/create', 'terminal/close', 'mcpManager/restart', 'directoryPicker/pick', 'pluginManager/setBundleEnabled']) {
      condition({ action: action as never, resource, args: { name: '@delorun/plugin-trash' } })
    }
    expect(touch).toHaveBeenCalledTimes(5)
  })

  it('is not a call the condition refuses after the unlock check', () => {
    const touch = vi.fn()
    const loosening = {
      ...facts(touch), dangerousMode: () => true, liftedSettings: () => 'could not record',
      defaultPermission: () => ({ namespaces: new Set(['permission']), current: { sandbox: 'workspace-write', approval: 'ask' }, levelOf: () => ({ sandbox: 'danger-full-access', approval: 'never' }) }),
    } as ReachAccessFacts
    const refused = createCondition(loosening, principal)({ action: 'settings/update', resource, args: { ns: 'permission', patch: { defaultPreset: 'danger-full-access' } } })
    // Pins the order: the unlock is renewed only once the whole condition allows the call.
    expect(refused.kind).toBe('deny')
    expect(touch).not.toHaveBeenCalled()
  })

  it('is a call of an unlock-gated route, and not one a locked device made or a polled route', () => {
    const touch = vi.fn()
    const home = { elevationOf: (deviceId: string) => (deviceId === 'unlocked' ? { id: 'unlock-2' } : undefined), pageUnlockOf: () => undefined, touchUnlock: touch } as never
    const route = gateByUnlock(() => home, () => Promise.resolve(new Response('ran')), { renews: true })
    route.admitPeer(new Request('http://localhost/x'), { principal: reachDevicePrincipal('locked', LISTENER) })
    expect(touch).not.toHaveBeenCalled()
    route.admitPeer(new Request('http://localhost/x'), { principal: reachDevicePrincipal('unlocked', LISTENER) })
    expect(touch).toHaveBeenCalledWith('unlock-2')
    touch.mockClear()
    // Pins the option: a polled route needs the unlock and does not renew it.
    gateByUnlock(() => home, () => Promise.resolve(new Response('ran')), { renews: false }).admitPeer(new Request('http://localhost/x'), { principal: reachDevicePrincipal('unlocked', LISTENER) })
    expect(touch).not.toHaveBeenCalled()
  })
})

describe('gateByUnlock with the grace excluded', () => {
  it('records a grace-only unlock as locked, and a code unlock as unlocked', () => {
    const touch = vi.fn()
    const home = { elevationOf: (deviceId: string) => (deviceId === 'grace' ? { id: 'g', grace: true } : deviceId === 'code' ? { id: 'c' } : undefined), pageUnlockOf: () => undefined, touchUnlock: touch } as never
    const ask = async (deviceId: string, options: { grace?: boolean, renews: boolean } = { renews: true }) => {
      const route = gateByUnlock(() => home, () => Promise.resolve(new Response('ran')), options)
      const request = new Request('http://localhost/x')
      route.admitPeer(request, { principal: reachDevicePrincipal(deviceId, LISTENER) })
      return (await route.fetch(request)).status
    }
    return Promise.all([ask('grace', { grace: false, renews: true }), ask('grace'), ask('code', { grace: false, renews: true })]).then((statuses) => {
      // Pins the option: the grace opens an ordinary unlock route and not one that loosens a consent row.
      expect(statuses).toEqual([403, 200, 200])
      expect(touch).toHaveBeenCalledTimes(2)
    })
  })
})
