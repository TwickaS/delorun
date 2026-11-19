/**
 * The approval grace: a newly approved device's first sign-in starts an unlock that runs from the approval for the
 * grace minutes, at most the listener's unlock minutes, and ends with the device's own call, a lock, a revoke, the
 * device's removal and the session's end. It never stands for a computer-only row.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import type { DeviceId, StudioAddress } from '@delorun/contract-admission'
import type { Base64Url, DevicePublicKeyJwk } from '@delorun/contract-device-approval'
import { matchCode } from '../src/match-code.ts'
import { signInMessage } from '../src/sign-in.ts'
import { deviceIdOf } from '../src/records.ts'
import type { ElevationChange } from '../src/elevation.ts'
import type { HomeAuth } from '../src/home-auth.ts'
import { createCondition, createReachAccessPolicy, GRACE_REFUSED_ACTIONS, PROTECTED_ROW_REFUSAL, REACH_ELEVATED_ACTIONS, reachDevicePrincipal, type ReachAccessFacts } from '../src/reach-access.ts'
import { HOME_AUTH_SWITCH, REACH_SWITCH } from '../src/service.ts'
import { homeFixture, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const SERVED = { listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', elevationMinutes: 20 } as const
const MINUTE = 60_000

/** A real P-256 device key, as a browser makes one. */
function device(): { readonly jwk: DevicePublicKeyJwk; readonly id: DeviceId; readonly sign: (challenge: string) => string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  const jwk: DevicePublicKeyJwk = { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(exported.x ?? ''), y: brandString<Base64Url>(exported.y ?? '') }
  return { jwk, id: deviceIdOf(jwk), sign: challenge => sign('sha256', signInMessage(ADDRESS, challenge), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
}

type Phone = ReturnType<typeof device>

/** Approve a device at the computer through the window and the local approval. */
async function approve(auth: HomeAuth, phone: Phone): Promise<void> {
  await auth.openApprovalWindow()
  const deviceNonce = brandString<Base64Url>(Buffer.alloc(16, 3).toString('base64url'))
  const accepted = await auth.requestApproval({ devicePublicKey: phone.jwk, deviceId: phone.id, deviceNonce, label: 'Phone', platform: 'iOS' }, { listener: LISTENER, source: '127.0.0.1' })
  await auth.approveLocally(accepted.requestId, matchCode({ homePublicKey: Buffer.from(accepted.homePublicKey, 'base64url'), deviceId: phone.id, homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS }))
}

/** Sign a device in, optionally rotating a session token. */
async function signIn(auth: HomeAuth, phone: Phone, rotate?: string) {
  const challenge = await auth.challenge(phone.id, LISTENER, '127.0.0.1')
  return auth.signIn({ deviceId: phone.id, challenge, signature: phone.sign(challenge), listener: LISTENER, ...rotate === undefined ? {} : { rotate } })
}

let home: Home | undefined

/**
 * A served home with the grace set.
 * @param approvalGraceMinutes - the grace, 0 for off.
 * @returns the fixture and the changes its elevations recorded.
 */
async function graced(approvalGraceMinutes: number): Promise<{ readonly home: Home; readonly changes: ElevationChange[] }> {
  home = await homeFixture({ approvalGraceMinutes })
  home.auth.serve(SERVED)
  const changes: ElevationChange[] = []
  home.auth.onElevationChange((change) => { changes.push(change) })
  return { home, changes }
}

afterEach(async () => {
  await home?.dispose()
  home = undefined
})

describe('the approval grace', () => {
  it('starts an unlock at the first sign-in that ends at the approval plus the grace minutes, shown as approval-grace', async () => {
    const { home: served } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    const approvedAt = served.clock.now
    served.clock.advance(MINUTE)
    await signIn(served.auth, phone)
    // Pins the grant: the unlock is the device's own, so the policy and the routes see it as any unlock.
    const unlock = served.auth.elevationOf(phone.id, LISTENER)
    expect(unlock).toMatchObject({ deviceId: phone.id, listener: LISTENER, endsAt: approvedAt + 10 * MINUTE, grace: true })
    expect(served.auth.elevationState(phone.id, LISTENER)).toEqual({ kind: 'elevated', elevationId: unlock?.id, endsAt: approvedAt + 10 * MINUTE, reason: 'approval-grace' })
  })

  it('is capped at the listener\'s unlock minutes', async () => {
    const { home: served } = await graced(60)
    const phone = device()
    await approve(served.auth, phone)
    const approvedAt = served.clock.now
    await signIn(served.auth, phone)
    // Pins the cap: a grace of an hour on a listener that unlocks for 20 minutes lasts 20.
    expect(served.auth.elevationOf(phone.id, LISTENER)?.endsAt).toBe(approvedAt + 20 * MINUTE)
  })

  it('starts nothing with the grace at 0, after the grace window, or for a second sign-in', async () => {
    const off = await graced(0)
    const first = device()
    await approve(off.home.auth, first)
    await signIn(off.home.auth, first)
    // Pins the off switch.
    expect(off.home.auth.elevationOf(first.id, LISTENER)).toBeUndefined()
    await home?.dispose()

    const { home: served } = await graced(10)
    const late = device()
    await approve(served.auth, late)
    served.clock.advance(11 * MINUTE)
    await signIn(served.auth, late)
    // Pins the window: a device approved long before its first sign-in gets no unlock.
    expect(served.auth.elevationOf(late.id, LISTENER)).toBeUndefined()

    const phone = device()
    await approve(served.auth, phone)
    const first2 = await signIn(served.auth, phone)
    served.auth.endApprovalGrace(phone.id, LISTENER)
    await signIn(served.auth, phone, first2.token)
    await signIn(served.auth, phone)
    // Pins the first-sign-in rule: a rotation and a later sign-in start no new unlock.
    expect(served.auth.elevationOf(phone.id, LISTENER)).toBeUndefined()
  })

  it('ends when the device finishes setup, leaving an unlock the computer approved', async () => {
    const { home: served, changes } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    const opened = await signIn(served.auth, phone)
    expect(served.auth.elevationOf(phone.id, LISTENER)).toBeDefined()
    served.auth.endApprovalGrace(phone.id, LISTENER)
    expect(served.auth.elevationOf(phone.id, LISTENER)).toBeUndefined()
    expect(changes.filter(change => change.kind === 'ended').map(change => change.reason)).toEqual(['grace-ended'])
    // Pins the grace flag: ending the grace must not end the unlock a person approved at the computer.
    const admitted = served.auth.admitToken(opened.token, LISTENER)
    if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
    const state = served.auth.requestElevation(admitted.sessionId, admitted.session)
    if (state.kind !== 'pending') throw new Error('no request is waiting')
    const approved = served.auth.approveElevation(state.requestId, state.code)
    served.auth.endApprovalGrace(phone.id, LISTENER)
    expect(served.auth.elevationOf(phone.id, LISTENER)).toEqual(approved)
  })

  it('ends with the computer\'s revoke, the device\'s lock, its removal and the end of its session', async () => {
    const { home: served, changes } = await graced(10)
    const startedFor = async (): Promise<{ phone: Phone, id: string | undefined }> => {
      const phone = device()
      await approve(served.auth, phone)
      await signIn(served.auth, phone)
      return { phone, id: served.auth.elevationOf(phone.id, LISTENER)?.id }
    }
    const revoked = await startedFor()
    expect(served.auth.revokeElevation(revoked.id ?? '')).toBe(true)
    expect(served.auth.elevationOf(revoked.phone.id, LISTENER)).toBeUndefined()
    const locked = await startedFor()
    served.auth.lockElevation(locked.phone.id, LISTENER)
    expect(served.auth.elevationOf(locked.phone.id, LISTENER)).toBeUndefined()
    const removed = await startedFor()
    await served.auth.revokeDevice(removed.phone.id)
    expect(served.auth.elevationOf(removed.phone.id, LISTENER)).toBeUndefined()
    expect(changes.filter(change => change.kind === 'ended').map(change => change.reason)).toEqual(['revoked-at-computer', 'locked-from-device', 'device-removed'])
  })

  it('is replaced by a code approval, so the unlock the device reads is the code\'s, not the grace', async () => {
    const { home: served, changes } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    const opened = await signIn(served.auth, phone)
    expect(served.auth.elevationOf(phone.id, LISTENER)).toMatchObject({ grace: true })
    const admitted = served.auth.admitToken(opened.token, LISTENER)
    if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
    const state = served.auth.requestElevation(admitted.sessionId, admitted.session)
    if (state.kind !== 'pending') throw new Error('no request is waiting')
    const code = served.auth.approveElevation(state.requestId, state.code)
    // Pins the replacement: the loosening routes read the device's one unlock, which must be the code's.
    expect(served.auth.elevationOf(phone.id, LISTENER)).toEqual(code)
    expect(served.auth.elevationOf(phone.id, LISTENER)?.grace).toBeUndefined()
    expect(changes.filter(change => change.kind === 'ended').map(change => change.reason)).toEqual(['replaced'])
  })

  it('expires with the grace minutes', async () => {
    const { home: served } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    await signIn(served.auth, phone)
    served.clock.advance(10 * MINUTE)
    // Pins the end time: the unlock is gone when the minutes are over.
    expect(served.auth.elevationOf(phone.id, LISTENER)).toBeUndefined()
  })
})

describe('the approval grace and PIN mode', () => {
  it('starts nothing while PIN mode is on, and hides a running grace once it turns on', async () => {
    const { home: served } = await graced(10)
    await served.auth.pin.set('739150', {})
    const phone = device()
    await approve(served.auth, phone)
    await signIn(served.auth, phone)
    // Pins the PIN check: with PIN mode on the first unlock-needing action asks for the PIN.
    expect(served.auth.elevationOf(phone.id, LISTENER)).toBeUndefined()
    expect(served.auth.elevationState(phone.id, LISTENER)).toMatchObject({ kind: 'none' })
    await served.auth.pin.off()
    const other = device()
    await approve(served.auth, other)
    await signIn(served.auth, other)
    expect(served.auth.elevationOf(other.id, LISTENER)).toMatchObject({ grace: true })
    await served.auth.pin.set('739150', {})
    expect(served.auth.elevationOf(other.id, LISTENER)).toBeUndefined()
  })

  // Reverting either unlockModeEnabled check in startApprovalGrace or elevationOf to this.pin.enabled() gives a passkey-only home a grace (R2-P2-3).
  it('gives no grace on a home whose only factor is a passkey, and hides a running one once the first passkey is enrolled', async () => {
    const { home: served } = await graced(10)
    const running = device()
    await approve(served.auth, running)
    await signIn(served.auth, running)
    expect(served.auth.elevationOf(running.id, LISTENER)).toMatchObject({ grace: true })
    const enrolled = device()
    await served.auth.passkeyStore.add({ credentialId: 'cred-1', publicKey: 'key', counter: 0, backupEligible: false, backupState: false, transports: [], createdAt: served.clock.now, lastUsedAt: null, address: ADDRESS, rpId: 'home.example.ts.net', deviceId: enrolled.id })
    expect(served.auth.pin.enabled()).toBe(false)
    expect(served.auth.elevationOf(running.id, LISTENER)).toBeUndefined()
    const fresh = device()
    await approve(served.auth, fresh)
    await signIn(served.auth, fresh)
    expect(served.auth.elevationOf(fresh.id, LISTENER)).toBeUndefined()
    expect(served.auth.elevationState(fresh.id, LISTENER)).toMatchObject({ kind: 'none' })
  })

  it('does not cover a consent or guard row\'s settings, which need a code or a PIN page', async () => {
    const { home: served } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    await signIn(served.auth, phone)
    const grace = served.auth.elevationOf(phone.id, LISTENER)
    const facts = (elevation: { readonly id: string; readonly grace?: true } | undefined): ReachAccessFacts => ({
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: () => elevation, pageUnlockOf: () => undefined, unlockModeEnabled: () => false,
      keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => [], protectedEntryIds: () => new Set(['include:delorun-mcp-consent', 'delorun-mcp-consent']), computerOnlyEntryIds: () => new Set(),
      defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => false,
    })
    const call = { action: 'settings/update' as const, resource: { kind: 'global' } as const, args: { ns: 'delorun-mcp-consent', patch: {} } }
    const principal = reachDevicePrincipal(phone.id, LISTENER)
    // Pins the grace flag: the same write under a code is the unlock's to allow.
    expect(createCondition(facts(grace), principal)(call)).toEqual({ kind: 'deny', reason: 'elevation-required: settings/update' })
    expect(createCondition(facts({ id: 'code' }), principal)(call).kind).toBe('allow')
    // An ordinary write is the grace's to allow.
    expect(createCondition(facts(grace), principal)({ ...call, args: { ns: 'delorun-cost-meter', patch: {} } }).kind).toBe('allow')
  })

  it('opens no terminal, which needs a code, a PIN page or the unlock the person chose', async () => {
    const { home: served } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    await signIn(served.auth, phone)
    const grace = served.auth.elevationOf(phone.id, LISTENER)
    expect(grace?.grace).toBe(true)
    const facts = (elevation: { readonly id: string; readonly grace?: true } | undefined, page?: { readonly id: string }): ReachAccessFacts => ({
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: () => elevation, pageUnlockOf: () => page, unlockModeEnabled: () => page !== undefined,
      keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(),
      defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => false,
    })
    const principal = reachDevicePrincipal(phone.id, LISTENER)
    const resource = { kind: 'global' } as const
    const terminals = Object.keys(REACH_ELEVATED_ACTIONS).filter((action): action is RemoteAccessAction => action.startsWith('terminal/'))
    expect([...GRACE_REFUSED_ACTIONS].sort()).toEqual([...terminals].sort())
    expect(terminals).toEqual(expect.arrayContaining(['terminal/create', 'terminal/attach']))
    for (const action of terminals) {
      // Pins GRACE_REFUSED_ACTIONS in the unlock check, for a call and for a question without arguments alike.
      expect(createCondition(facts(grace), principal)({ action, resource, args: {} }), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
      expect(createCondition(facts(grace), principal)({ action, resource }), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
      // A code from the computer and an unlocked PIN page open it.
      expect(createCondition(facts({ id: 'code' }), principal)({ action, resource, args: {} }).kind, action).toBe('allow')
      expect(createCondition(facts(undefined, { id: 'page' }), { ...principal, unlockId: 'page' })({ action, resource, args: {} }).kind, action).toBe('allow')
    }
    // Every other elevated action stays the grace's to allow.
    for (const action of Object.keys(REACH_ELEVATED_ACTIONS).filter(action => !action.startsWith('terminal/'))) {
      expect(createCondition(facts(grace), principal)({ action: action as RemoteAccessAction, resource }).kind, action).toBe('allow')
    }
  })
})

describe('the approval grace and the computer-only table', () => {
  it('admits no computer-only row to a device holding the grace, in either dangerous mode', async () => {
    const { home: served } = await graced(10)
    const phone = device()
    await approve(served.auth, phone)
    await signIn(served.auth, phone)
    const facts = (dangerous: boolean): ReachAccessFacts => ({
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: (deviceId, listener) => served.auth.elevationOf(deviceId, listener), pageUnlockOf: () => undefined, unlockModeEnabled: () => false,
      keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => [HOME_AUTH_SWITCH, REACH_SWITCH], protectedEntryIds: () => new Set(['include:home-auth']), computerOnlyEntryIds: () => new Set(['include:home-auth']),
      defaultPermission: () => undefined, phonePowers: () => 'full' as const, dangerousMode: () => dangerous,
    })
    const principal = reachDevicePrincipal(phone.id, LISTENER)
    for (const dangerous of [false, true]) {
      const condition = createCondition(facts(dangerous), principal)
      const resource = { kind: 'global' } as const
      // Pins the table: the grace is an unlock, so everything an unlock cannot do it cannot do either.
      expect(condition({ action: 'pluginManager/setPluginEnabled', resource, args: { id: 'include:home-auth', enabled: false } })).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
      expect(condition({ action: 'settings/update', resource, args: { ns: REACH_SWITCH.ns, patch: { enabled: false } } })).toMatchObject({ kind: 'deny' })
      expect(condition({ action: 'settings/update', resource, args: { ns: HOME_AUTH_SWITCH.ns, patch: { pairing: {} } } })).toMatchObject({ kind: 'deny' })
      for (const binding of createReachAccessPolicy(facts(dangerous)).bindings(principal)) expect(binding.role.actions).not.toContain('account/startSignIn')
      // And what an unlock does is open to it, except a terminal (GRACE_REFUSED_ACTIONS), in either mode.
      expect(condition({ action: 'directoryPicker/list', resource, args: {} })).toEqual({ kind: 'allow' })
      expect(condition({ action: 'terminal/create', resource, args: {} })).toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
    }
  })
})
