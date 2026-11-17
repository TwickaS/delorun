/**
 * PIN mode asks for the PIN only at an action that needs an unlock: a paired phone's locked page reads, a PIN unlock
 * lets it pass the unlock routes and actions, and what stays at the computer is refused in every state.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import { admitApprovedDevice, gateByUnlock } from '../src/computer-only.ts'
import { createCondition, PROTECTED_ROW_REFUSAL, reachDevicePrincipal, REACH_ALLOWED_ACTIONS, type ReachAccessFacts } from '../src/reach-access.ts'

const LISTENER = 'reach-tailscale-private'
const GLOBAL = { kind: 'global' } as const
const ROW = 'include:delorun-home-auth'

/**
 * A home in PIN mode where the page `page-1` is unlocked or not.
 * @param pageUnlocked - whether the page holds a PIN unlock.
 * @returns the part of the service the routes read, and the policy facts.
 */
function pinHome(pageUnlocked: boolean) {
  const unlock = { id: 'page-1' }
  const home = { pinEnabled: () => true, pageUnlockOf: (id: string) => (pageUnlocked && id === 'page-1' ? unlock : undefined), elevationOf: () => undefined, dangerousMode: () => false } as never
  const facts: ReachAccessFacts = {
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => undefined, pageUnlockOf: id => (pageUnlocked && id === 'page-1' ? unlock : undefined), pinEnabled: () => true,
    keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
    computerOnlySwitches: () => [], protectedEntryIds: () => new Set([ROW]), computerOnlyEntryIds: () => new Set([ROW]),
    defaultPermission: () => undefined, dangerousMode: () => false,
  }
  return { home, facts }
}

/** A locked page's Peer carries no unlock id; an unlocked page's carries the id of its unlock. */
const principal = (pageUnlocked: boolean) => reachDevicePrincipal('device-1', LISTENER, pageUnlocked ? 'page-1' : undefined)
const peer = (pageUnlocked: boolean) => ({ principal: principal(pageUnlocked) })

describe('a paired phone in PIN mode', () => {
  it('reads with a locked page: the read routes admit it and the policy allows the read actions', () => {
    const { facts } = pinHome(false)
    // Pins the read level: no PIN is asked to load the studio or to read.
    expect(admitApprovedDevice()({} as never, peer(false))).toBe(true)
    const condition = createCondition(facts, principal(false))
    for (const action of Object.keys(REACH_ALLOWED_ACTIONS)) {
      expect(condition({ action: action as never, resource: GLOBAL }).kind, action).not.toBe('deny')
    }
  })

  it('is told to unlock at each unlock route and unlock action, and passes them after the PIN unlock', async () => {
    for (const unlocked of [false, true]) {
      const { home, facts } = pinHome(unlocked)
      const route = gateByUnlock(() => home, () => Promise.resolve(new Response('ran')))
      const request = new Request('http://localhost/x', { method: 'POST' })
      expect(route.admitPeer(request, peer(unlocked))).toBe(true)
      const answer = await route.fetch(request)
      if (unlocked) expect(await answer.text()).toBe('ran')
      else expect([answer.status, await answer.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      const action = createCondition(facts, principal(unlocked))({ action: 'terminal/create' as never, resource: GLOBAL, args: {} })
      expect(action, String(unlocked)).toEqual(unlocked ? { kind: 'allow' } : { kind: 'deny', reason: 'elevation-required: terminal/create' })
    }
  })

  it('is refused what stays at the computer in every state, locked or after the PIN unlock', () => {
    for (const unlocked of [false, true]) {
      const { facts } = pinHome(unlocked)
      const condition = createCondition(facts, principal(unlocked))
      expect(condition({ action: 'pluginManager/setPluginEnabled', resource: GLOBAL, args: { id: ROW, enabled: false } }), String(unlocked)).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
      expect(condition({ action: 'settings/update', resource: GLOBAL, args: { ns: 'delorun-home-auth', patch: { pairing: {} } } }), String(unlocked)).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
    }
  })
})
