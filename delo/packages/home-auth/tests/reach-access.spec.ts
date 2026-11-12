/**
 * The `reach-device` policy over plain facts: what an admitted device is bound to, the refusal reasons, and the two
 * tables it is built from. The denial suite under `denial/reach/` decides the same policy through the Gateway.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  REACH_ALLOWED_ACTIONS,
  REACH_DENIED_ACTIONS,
  REACH_DEVICE,
  assertDisjoint,
  createCondition,
  createReachAccessPolicy,
  reachDevicePrincipal,
  reachRefusal,
  type ReachAccessFacts,
} from '../src/reach-access.ts'

const session = (id: string): SessionId => id as SessionId
const workspace = (id: string): WorkspaceId => id as WorkspaceId
const DEVICE = reachDevicePrincipal('device-1')

function facts(overrides: Partial<ReachAccessFacts> = {}): ReachAccessFacts {
  return {
    admitted: deviceId => deviceId === 'device-1',
    workspaces: () => [
      { id: workspace('w-1'), sessionIds: [session('s-1'), session('s-2')] },
      { id: workspace('w-2'), sessionIds: [session('s-2')] },
    ],
    liveSessions: () => [session('s-2'), session('s-live')],
    ...overrides,
  }
}

describe('the reach-device principal', () => {
  it('carries the device id alone', () => {
    expect(reachDevicePrincipal('device-1')).toEqual({ kind: REACH_DEVICE, deviceId: 'device-1' })
  })
})

describe('the reach-device policy', () => {
  it('binds an admitted device to the global resource, each Workspace and each Session once', () => {
    const resources = createReachAccessPolicy(facts()).bindings(DEVICE).map(binding => binding.resource)
    // Pins the Session union: a Session of two Workspaces that is also live is bound once, and a live Session of no
    // Workspace is bound too.
    expect(resources).toEqual([
      { kind: 'global' },
      { kind: 'workspace', id: 'w-1' },
      { kind: 'workspace', id: 'w-2' },
      { kind: 'session', id: 's-1' },
      { kind: 'session', id: 's-2' },
      { kind: 'session', id: 's-live' },
    ])
  })

  it('keeps a workspace-file read inside the chat\'s workspace', () => {
    const allow = { kind: 'allow' }
    // Pins the workspace-file condition: the service reads an absolute path wherever it points, so the policy keeps a
    // device to a relative one that does not walk out of the workspace.
    for (const path of ['src/index.ts', 'a/b/c.txt', '.']) {
      expect(createCondition({ action: 'workspaceFiles/read', args: { workspaceFileScopeId: 's-1', path } })).toEqual(allow)
    }
    // A `..` segment is refused even where it would resolve back inside: the rule is the path's text, not a resolution
    // the policy would have to redo.
    for (const path of ['/etc/hostname', 'C:\\Windows\\win.ini', '\\\\server\\share', '..', '../outside.txt', 'a/b/../c.txt', 7, undefined]) {
      expect(createCondition({ action: 'workspaceFiles/read', args: { path } }))
        .toEqual({ kind: 'deny', reason: 'loopback-required: workspaceFiles/read with a path outside the chat\'s workspace' })
    }
    // The condition belongs to the reads that take a path, and leaves every other action alone.
    expect(createCondition({ action: 'workspaceFiles/readBytes', args: { path: '/etc/hostname' } })).toMatchObject({ kind: 'deny' })
    expect(createCondition({ action: 'workspaceFiles/stat', args: { path: '/etc/hostname' } })).toMatchObject({ kind: 'deny' })
    expect(createCondition({ action: 'officeToPdf/render', args: { path: '/etc/hostname', priority: 'foreground' } })).toMatchObject({ kind: 'deny' })
    // `list` is confined by the service itself, which refuses a folder outside the workspace.
    expect(createCondition({ action: 'workspaceFiles/list', args: { path: '/etc' } })).toEqual(allow)
    // A workspace-file read names a path; one that names none is refused like an absolute one.
    expect(createCondition({ action: 'workspaceFiles/read', args: { workspaceFileScopeId: 's-1' } })).toMatchObject({ kind: 'deny' })
  })

  it('binds only the allowed actions, on every role', () => {
    for (const binding of createReachAccessPolicy(facts()).bindings(DEVICE)) {
      // Pins the roles: a role listing a denied action would allow it on every bound resource.
      expect(binding.role.actions).toEqual(Object.keys(REACH_ALLOWED_ACTIONS))
      expect(binding.role.resource).toBe(binding.resource.kind)
      // Pins where the condition sits: on every role, because `session/create` names a global or Workspace resource
      // and a workspace-file read names a Session one.
      expect(binding.condition).toBe(createCondition)
    }
  })

  it('refuses a session/create naming a folder or a preset, and nothing else', () => {
    const allow = { kind: 'allow' }
    expect(createCondition({ action: 'session/create' })).toEqual(allow)
    expect(createCondition({ action: 'session/create', args: { request: { workspaceId: 'w' }, flag: 1, nothing: null } })).toEqual(allow)
    expect(createCondition({ action: 'session/prompt', args: { request: { cwd: '/' } } })).toEqual(allow)
    for (const request of [{ cwd: '/' }, { agentPreset: 'any' }]) {
      expect(createCondition({ action: 'session/create', args: { request } })).toEqual({ kind: 'deny', reason: 'loopback-required: session/create with a folder or a preset' })
    }
  })

  it('binds a device no reach listener holds a Peer for to nothing', () => {
    // Pins the admission fact: a removed device keeps no binding while a stale principal is still asked about.
    expect(createReachAccessPolicy(facts({ admitted: () => false })).bindings(DEVICE)).toEqual([])
  })

  it('explains a refusal by naming the action', () => {
    const policy = createReachAccessPolicy(facts())
    // Pins `explain`: the refusal names the action, and tells a resource it cannot name from an action it refuses.
    expect(policy.explain?.({ principal: DEVICE, action: 'pluginManager/installBundle', resources: [{ kind: 'global' }] }))
      .toBe('loopback-required: pluginManager/installBundle')
    expect(policy.explain?.({ principal: DEVICE, action: 'session/cancel', resources: [{ kind: 'session', id: session('cold') }] }))
      .toBe('resource-unlisted: session/cancel')
  })
})

describe('the refusal reasons', () => {
  it('require the home\'s own computer for every action not allowed, classified or not', () => {
    expect(reachRefusal('settings/mutate')).toBe('loopback-required: settings/mutate')
    expect(reachRefusal('unclassified/method' as RemoteAccessAction)).toBe('loopback-required: unclassified/method')
    expect(reachRefusal('event:plugin-manager/install-log')).toBe('loopback-required: event:plugin-manager/install-log')
    expect(reachRefusal('session/list')).toBe('resource-unlisted: session/list')
  })
})

describe('the tables', () => {
  it('list no action as both allowed and denied', () => {
    expect(() => { assertDisjoint(REACH_ALLOWED_ACTIONS, REACH_DENIED_ACTIONS) }).not.toThrow()
    // Pins the check the module runs at load.
    expect(() => { assertDisjoint({ 'b/x': 'x', 'a/y': 'y', 'c/z': 'z' }, { 'a/y': 'y', 'b/x': 'x' }) })
      .toThrow('reach access lists ["a/y","b/x"] as both allowed and denied')
  })

  it('give every entry a one-line reason', () => {
    for (const reason of [...Object.values(REACH_ALLOWED_ACTIONS), ...Object.values(REACH_DENIED_ACTIONS)]) {
      expect(reason).toMatch(/^[^\n]{8,}$/)
    }
  })
})
