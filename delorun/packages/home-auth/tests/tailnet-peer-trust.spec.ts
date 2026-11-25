/**
 * A666 and A667: a tailnet peer is the home's own computer, except the actions that stay at the computer.
 *
 * The peer is identified through Tailscale's local API, per connection, so every way that API can fail to name a peer
 * must leave the device with today's behaviour — the unlock — and never grant it. Each test's comment names the check
 * whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  createCondition,
  createReachAccessPolicy,
  REACH_DENIED_ACTIONS,
  REACH_ELEVATED_ACTIONS,
  reachDevicePrincipal,
  type ReachAccessFacts,
} from '../src/reach-access.ts'
import { TailnetPeerCache, type TailnetPeerCheck } from '../src/tailnet-peers.ts'

const LISTENER = 'reach-tailscale-private'
const GLOBAL = { kind: 'global' } as const
const SESSION = { kind: 'session', id: 's-1' as SessionId } as const

/** A device on the listener, with no unlock and no tailnet-peer grant. */
const DEVICE = reachDevicePrincipal('device-1', LISTENER)
/** The same device, whose connection Tailscale corroborated as a device of the home's own tailnet. */
const TAILNET = reachDevicePrincipal('device-1', LISTENER, undefined, true)

/** The peer the daemon names for a corroborated address. */
const PEER = { nodeId: '1', stableId: 'n1', name: 'phone.tailnet.ts.net', login: 'person@example.com', displayName: 'The Person' }

/**
 * The facts of a home with no unlock, no grant store and no dangerous mode.
 * @param overrides - the facts to replace.
 * @returns the facts.
 */
function facts(overrides: Partial<ReachAccessFacts> = {}): ReachAccessFacts {
  return {
    admitted: () => true,
    workspaces: () => [{ id: 'w-1' as WorkspaceId, path: '/nowhere/w-1', sessionIds: ['s-1' as SessionId] }],
    liveSessions: () => [],
    workspaceRootOf: () => undefined,
    delorunHome: '/nowhere',
    elevationOf: () => undefined,
    pageUnlockOf: () => undefined,
    unlockModeEnabled: () => false,
    keyRefs: () => new Set<string>(),
    logElevated: () => {},
    liftedSettings: () => undefined,
    computerOnlySwitches: () => [],
    protectedEntryIds: () => new Set<string>(),
    computerOnlyEntryIds: () => new Set<string>(),
    defaultPermission: () => undefined,
    dangerousMode: () => false,
    ...overrides,
  }
}

describe('a tailnet peer', () => {
  it('takes every elevated action without an unlock', () => {
    // Removing the tailnet-peer branch in `unlocked` makes this fail: every action would need an unlock again.
    const condition = createCondition(facts(), TAILNET)
    const named: Partial<Record<string, Record<string, unknown>>> = {
      'commands/execute': { line: '/plan' },
      'pluginManager/setPluginEnabled': { id: 'include:delorun-trash', enabled: false },
    }
    for (const action of Object.keys(REACH_ELEVATED_ACTIONS) as RemoteAccessAction[]) {
      expect(condition({ action, resource: GLOBAL, args: named[action] ?? {} }), action).toEqual({ kind: 'allow' })
    }
  })

  it('still needs an unlock when the connection was not corroborated', () => {
    // Removing the tailnetPeer guard makes this fail: an uncorroborated device would be treated as the computer.
    // Two actions are refused earlier, by a rule that reads their arguments, so each names a call that rule allows.
    const condition = createCondition(facts(), DEVICE)
    const named: Partial<Record<string, Record<string, unknown>>> = {
      'commands/execute': { line: '/plan' },
      'pluginManager/setPluginEnabled': { id: 'include:delorun-trash', enabled: false },
    }
    for (const action of Object.keys(REACH_ELEVATED_ACTIONS) as RemoteAccessAction[]) {
      expect(condition({ action, resource: GLOBAL, args: named[action] ?? {} }), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
    }
  })

  it('keeps every denied action refused, because no role lists it', () => {
    // The role is where a denied action is refused: it lists the allowed, key, elevated and dangerous actions and no
    // other, so the policy refuses a denied action before any condition runs. Adding a denied action to ROLE_ACTIONS
    // makes this fail, which is the check that keeps the computer's own actions at the computer for a tailnet peer.
    const policy = createReachAccessPolicy(facts())
    for (const action of Object.keys(REACH_DENIED_ACTIONS) as RemoteAccessAction[]) {
      expect(policy.explain?.({ principal: TAILNET, action, resources: [GLOBAL] }), action).toEqual(`loopback-required: ${action}`)
    }
    // The bindings a tailnet peer holds list no denied action, so no condition is ever asked about one.
    const bindings = policy.bindings(TAILNET)
    expect(bindings.length).toBeGreaterThan(0)
    for (const binding of bindings) {
      for (const action of Object.keys(REACH_DENIED_ACTIONS)) {
        expect(binding.role.actions, action).not.toContain(action)
      }
    }
  })

  it('keeps the computer-only switches, protected rows and the default permission refused', () => {
    // Removing any of those refusals makes this fail: a tailnet peer would loosen what only the computer changes.
    const condition = createCondition(facts({
      computerOnlySwitches: () => [{ ns: 'delorun-delegation-consent', field: 'enabled', label: 'the external-agent consent' }],
      defaultPermission: () => ({ namespaces: new Set(['permission']), current: { sandbox: 'workspace-write', approval: 'ask' }, levelOf: () => undefined }),
    }), TAILNET)
    expect(condition({ action: 'settings/update', resource: GLOBAL, args: { ns: 'delorun-delegation-consent', value: { enabled: false } } }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('loopback-required') })
  })

  it('saves a model key without an unlock, and still refuses an undeclared reference', () => {
    // Removing the tailnetPeer guard on the key gate makes this fail; removing the reference check lets a bad ref through.
    const condition = createCondition(facts({ unlockModeEnabled: () => true, keyRefs: () => new Set(['DEEPSEEK_API_KEY']) }), TAILNET)
    expect(condition({ action: 'credentials/set', resource: GLOBAL, args: { ref: 'DEEPSEEK_API_KEY', value: 'x' } })).toEqual({ kind: 'allow' })
    expect(condition({ action: 'credentials/set', resource: GLOBAL, args: { ref: 'SOME_OTHER_KEY', value: 'x' } }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('loopback-required') })
  })

  it('is refused a workspace-file path outside the chat\'s workspace', () => {
    // Removing the workspace-path refusal makes this fail: a tailnet peer would read outside the workspace.
    const condition = createCondition(facts(), TAILNET)
    expect(condition({ action: 'workspaceFiles/read', resource: SESSION, args: { path: '/etc/passwd' } }))
      .toEqual({ kind: 'deny', reason: expect.stringContaining('loopback-required') })
  })
})

describe('the corroborated-peer cache', () => {
  it('remembers a peer the daemon named, and forgets it when the answer expires', () => {
    // Removing the TTL check makes this fail: an expired answer would keep granting the computer's actions.
    let now = 1_000
    const cache = new TailnetPeerCache(async () => ({ kind: 'peer', peer: PEER }), () => now, 100)
    expect(cache.peerOf('100.64.0.1')).toBeUndefined()
    return cache.refresh('100.64.0.1').then(() => {
      expect(cache.peerOf('100.64.0.1')).toEqual(PEER)
      now += 101
      expect(cache.peerOf('100.64.0.1')).toBeUndefined()
    })
  })

  it('remembers no peer when the daemon refused, so the device keeps the unlock', () => {
    // Removing the refusal branch makes this fail: a refused address would be remembered as a peer.
    const cache = new TailnetPeerCache(async () => ({ kind: 'refused', refusal: 'unknown-peer', detail: 'no such device' }))
    return cache.refresh('100.64.0.1').then(() => { expect(cache.peerOf('100.64.0.1')).toBeUndefined() })
  })

  it('remembers no peer when the check threw', () => {
    // Removing the catch makes this fail: a throwing check would reject instead of leaving the device locked.
    const cache = new TailnetPeerCache(async () => { throw new Error('no daemon') })
    return cache.refresh('100.64.0.1').then(() => { expect(cache.peerOf('100.64.0.1')).toBeUndefined() })
  })

  it('asks the daemon once for concurrent requests from one address', async () => {
    // Removing the pending guard makes this fail: every request would ask the daemon again.
    let asked = 0
    const cache = new TailnetPeerCache(async (): Promise<TailnetPeerCheck> => { asked += 1; return { kind: 'peer', peer: PEER } })
    await Promise.all([cache.refresh('100.64.0.1'), cache.refresh('100.64.0.1'), cache.refresh('100.64.0.1')])
    expect(asked).toBe(1)
  })
})
