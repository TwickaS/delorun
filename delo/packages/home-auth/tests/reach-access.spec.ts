/**
 * The `reach-device` policy over plain facts: what an admitted device is bound to on its listener, the refusal reasons,
 * the unlock that admits an elevated action on one listener only, and the three tables it is built from, each action in
 * the class the owner's rule (A297) gives it. The denial suite under `denial/reach/` decides the same policy through the Gateway.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  REACH_ALLOWED_ACTIONS,
  REACH_DENIED_ACTIONS,
  REACH_DEVICE,
  REACH_ELEVATED_ACTIONS,
  CREATE_OUTSIDE_WORKSPACES,
  assertDisjoint,
  createCondition,
  createReachAccessPolicy,
  reachDevicePrincipal,
  reachRefusal,
  type ReachAccessFacts,
} from '../src/reach-access.ts'

const session = (id: string): SessionId => id as SessionId
const workspace = (id: string): WorkspaceId => id as WorkspaceId
const LISTENER = 'reach-tailscale-private'
const OTHER_LISTENER = 'reach-tailscale-funnel'
const DEVICE = reachDevicePrincipal('device-1', LISTENER)
const GLOBAL = { kind: 'global' } as const

function facts(overrides: Partial<ReachAccessFacts> = {}): ReachAccessFacts {
  return {
    admitted: (deviceId, listener) => deviceId === 'device-1' && listener === LISTENER,
    workspaces: () => [
      { id: workspace('w-1'), path: '/nowhere/w-1', sessionIds: [session('s-1'), session('s-2')] },
      { id: workspace('w-2'), path: '/nowhere/w-2', sessionIds: [session('s-2')] },
    ],
    liveSessions: () => [session('s-2'), session('s-live')],
    workspaceRootOf: () => undefined,
    deloHome: '/nowhere',
    elevationOf: () => undefined,
    logElevated: () => {},
    ...overrides,
  }
}

describe('the reach-device principal', () => {
  it('carries the device id and the listener alone', () => {
    expect(reachDevicePrincipal('device-1', LISTENER)).toEqual({ kind: REACH_DEVICE, deviceId: 'device-1', listener: LISTENER })
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

  it('binds only the allowed and the elevated actions, on every role', () => {
    for (const binding of createReachAccessPolicy(facts()).bindings(DEVICE)) {
      // Pins the roles: a role listing a never action would allow it on every bound resource, and the condition alone
      // keeps an elevated one to a device that holds an elevation.
      expect(binding.role.actions).toEqual([...Object.keys(REACH_ALLOWED_ACTIONS), ...Object.keys(REACH_ELEVATED_ACTIONS)])
      expect(binding.role.resource).toBe(binding.resource.kind)
      // Pins where the condition sits: on every role, because `session/create` names a global or Workspace resource
      // and a workspace-file read names a Session one.
      expect(binding.condition).toBeTypeOf('function')
    }
  })

  it('binds a device no reach listener holds a Peer for to nothing', () => {
    // Pins the admission fact: a removed device keeps no binding while a stale principal is still asked about.
    expect(createReachAccessPolicy(facts({ admitted: () => false })).bindings(DEVICE)).toEqual([])
    // Pins the listener in the admission fact: a Peer on one listener binds nothing to the device's principal on another.
    expect(createReachAccessPolicy(facts()).bindings(reachDevicePrincipal('device-1', OTHER_LISTENER))).toEqual([])
  })

  it('explains a refusal by naming the action', () => {
    const policy = createReachAccessPolicy(facts())
    // Pins `explain`: the refusal names the action, and tells a resource it cannot name from an action it refuses.
    expect(policy.explain?.({ principal: DEVICE, action: 'credentials/set', resources: [{ kind: 'global' }] }))
      .toBe('loopback-required: credentials/set')
    expect(policy.explain?.({ principal: DEVICE, action: 'session/cancel', resources: [{ kind: 'session', id: session('cold') }] }))
      .toBe('resource-unlisted: session/cancel')
  })
})

describe('a device\'s workspace-file call', () => {
  const ALLOW = { kind: 'allow' }
  let directory = ''
  let root = ''
  let deloHome = ''
  const chat = { kind: 'session', id: session('s-1') } as const

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delo-reach-paths-'))
    root = join(directory, 'workspace')
    // A workspace that holds the Delo home, as a live chat whose folder is the person's home directory does.
    deloHome = join(root, '.delo')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(deloHome, 'secrets'), { recursive: true })
    await mkdir(join(directory, 'outside'))
    await writeFile(join(root, 'src', 'index.ts'), 'inside')
    await writeFile(join(root, 'notes.md'), 'inside')
    await writeFile(join(deloHome, 'secrets', 'key'), 'secret')
    // Another folder whose name differs from the Delo home's only in case, which a case-folding filesystem would not hold.
    await mkdir(join(root, '.DELO'))
    await writeFile(join(root, '.DELO', 'key'), 'other')
    await writeFile(join(directory, 'outside', 'secret.txt'), 'outside')
    await symlink(join(directory, 'outside'), join(root, 'linked-dir'))
    await symlink(join(directory, 'outside', 'secret.txt'), join(root, 'linked-file'))
    await symlink(join(root, 'src'), join(root, 'src-link'))
  })
  afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

  const conditionOf = (overrides: Partial<ReachAccessFacts> = {}) =>
    createCondition(facts({ workspaceRootOf: id => (id === 's-1' ? root : undefined), deloHome, ...overrides }), DEVICE)
  const refusal = (action: RemoteAccessAction) => ({ kind: 'deny', reason: `loopback-required: ${action} with a path outside the chat's workspace` })

  it('reaches a file or folder whose real path lies inside the chat\'s workspace', () => {
    const condition = conditionOf()
    // The files tree names absolute paths, which the service reads as they are.
    for (const path of ['src/index.ts', 'notes.md', '.', 'src', 'src-link/index.ts', join(root, 'notes.md'), root]) {
      expect(condition({ action: 'workspaceFiles/read', resource: chat, args: { workspaceFileScopeId: 's-1', path } })).toEqual(ALLOW)
    }
    expect(condition({ action: 'workspaceFiles/list', resource: chat, args: { path: 'src' } })).toEqual(ALLOW)
  })

  it('refuses a path outside the workspace, and one the policy would not resolve as the service does', () => {
    const condition = conditionOf()
    // Pins the containment and the text checks: `~` is the person's home directory to the service, and a `..` segment
    // is walked physically through a link, so both are refused even where they would land inside.
    for (const path of ['/etc/hostname', join(directory, 'outside', 'secret.txt'), '~', '~/notes.md', '..', '../outside/secret.txt', 'src/../notes.md', 'src\\..\\notes.md', 'notes.md\0', 7, undefined]) {
      expect(condition({ action: 'workspaceFiles/read', resource: chat, args: { path } })).toEqual(refusal('workspaceFiles/read'))
    }
  })

  it('refuses a symbolic link in any directory of the path that leads outside the workspace', () => {
    const condition = conditionOf()
    // Pins the real-path check: the service follows a link in a parent directory, so `linked-dir/secret.txt` would
    // read a file outside the workspace through a link the chat's agent can create.
    for (const action of ['workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'officeToPdf/render', 'workspaceFiles/list', 'workspaceFiles/changes'] as const) {
      expect(condition({ action, resource: chat, args: { path: 'linked-dir/secret.txt' } })).toEqual(refusal(action))
      expect(condition({ action, resource: chat, args: { path: 'linked-file' } })).toEqual(refusal(action))
    }
    expect(condition({ action: 'workspaceFiles/list', resource: chat, args: { path: 'linked-dir' } })).toEqual(refusal('workspaceFiles/list'))
  })

  it('refuses the Delo home even inside the workspace', () => {
    // Pins the Delo home check: its secrets and tokens are never a device's to read, wherever a chat's folder lies.
    for (const path of ['.delo', '.delo/secrets/key']) {
      expect(conditionOf()({ action: 'workspaceFiles/read', resource: chat, args: { path } })).toEqual(refusal('workspaceFiles/read'))
    }
  })

  it('compares the Delo home without case where the platform\'s filesystem does', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('process.platform has no descriptor')
    const read = () => conditionOf()({ action: 'workspaceFiles/read', resource: chat, args: { path: '.DELO/key' } })
    try {
      expect(read()).toEqual(ALLOW)
      // Pins the folding: on macOS or Windows `.DELO` is the Delo home itself, spelled another way.
      for (const value of ['darwin', 'win32']) {
        Object.defineProperty(process, 'platform', { value })
        expect(read()).toEqual(refusal('workspaceFiles/read'))
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('refuses a path that does not exist, and a chat whose workspace the home cannot name', () => {
    expect(conditionOf({ deloHome: join(directory, 'gone') })({ action: 'workspaceFiles/read', resource: chat, args: { path: 'notes.md' } }))
      .toEqual(refusal('workspaceFiles/read'))
    expect(conditionOf()({ action: 'workspaceFiles/stat', resource: chat, args: { path: 'missing.txt' } })).toEqual(refusal('workspaceFiles/stat'))
    expect(conditionOf()({ action: 'workspaceFiles/read', resource: { kind: 'session', id: session('other') }, args: { path: 'notes.md' } }))
      .toEqual(refusal('workspaceFiles/read'))
    expect(conditionOf({ workspaceRootOf: () => join(directory, 'gone') })({ action: 'workspaceFiles/read', resource: chat, args: { path: 'notes.md' } }))
      .toEqual(refusal('workspaceFiles/read'))
    expect(conditionOf()({ action: 'workspaceFiles/read', resource: GLOBAL, args: { path: 'notes.md' } })).toEqual(refusal('workspaceFiles/read'))
  })

  it('resolves a byte read from its base file, which must itself be reachable', () => {
    const condition = conditionOf()
    const read = (path: string, baseFile: unknown) => condition({ action: 'workspaceFiles/readBytes', resource: chat, args: { path, options: { baseFile } } })
    expect(read('index.ts', 'src/index.ts')).toEqual(ALLOW)
    // Pins the base-file check: a base file outside the workspace would move where the relative path starts.
    expect(read('secret.txt', 'linked-dir/secret.txt')).toEqual(refusal('workspaceFiles/readBytes'))
    expect(read('secret.txt', '/etc/hostname')).toEqual(refusal('workspaceFiles/readBytes'))
    expect(read('notes.md', 'src/index.ts')).toEqual(refusal('workspaceFiles/readBytes'))
    // The path resolves from the base file's real directory, with `..` and `\\` as the service reads them.
    expect(read('../notes.md', 'src-link/index.ts')).toEqual(ALLOW)
    expect(read('..\\notes.md', 'src/index.ts')).toEqual(ALLOW)
    expect(read('../../outside/secret.txt', 'src/index.ts')).toEqual(refusal('workspaceFiles/readBytes'))
    expect(read('notes.md\0', 'src/index.ts')).toEqual(refusal('workspaceFiles/readBytes'))
    expect(condition({ action: 'workspaceFiles/readBytes', resource: chat, args: { path: 7, options: { baseFile: 'src/index.ts' } } })).toEqual(refusal('workspaceFiles/readBytes'))
    expect(condition({ action: 'workspaceFiles/readBytes', resource: chat, args: { path: 'notes.md', options: {} } })).toEqual(ALLOW)
  })

  it('leaves a call without arguments and every other action alone', () => {
    const condition = conditionOf()
    expect(condition({ action: 'workspaceFiles/read', resource: chat })).toEqual(ALLOW)
    expect(condition({ action: 'session/prompt', resource: chat, args: { path: '/etc/hostname' } })).toEqual(ALLOW)
  })
})

describe('a session/create', () => {
  const ALLOW = { kind: 'allow' }
  const OUTSIDE = { kind: 'deny', reason: CREATE_OUTSIDE_WORKSPACES }
  let directory = ''
  let known = ''
  let linked = ''
  let other = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delo-reach-create-'))
    known = join(directory, 'known')
    other = join(directory, 'other')
    linked = join(directory, 'linked')
    await mkdir(join(known, 'inner'), { recursive: true })
    await mkdir(other)
    await symlink(known, linked)
  })
  afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

  const workspaces = () => [{ id: workspace('w-1'), path: known, sessionIds: [] }]
  const create = (request: unknown, overrides: Partial<ReachAccessFacts> = {}) =>
    createCondition(facts({ workspaces, ...overrides }), DEVICE)({ action: 'session/create', resource: GLOBAL, args: { request } })

  it('starts a chat in a known workspace with any preset', () => {
    expect(create({ workspaceId: 'w-1' })).toEqual(ALLOW)
    expect(create({ workspaceId: 'w-1', agentPreset: 'any', sessionId: 's-blank' })).toEqual(ALLOW)
    // A folder whose real path is a known workspace's, through a link included, is that workspace.
    expect(create({ cwd: known, agentPreset: 'any' })).toEqual(ALLOW)
    expect(create({ cwd: linked })).toEqual(ALLOW)
    // A workspace recorded at a link is the folder the link resolves to.
    expect(create({ cwd: known }, { workspaces: () => [{ id: workspace('w-linked'), path: linked, sessionIds: [] }] })).toEqual(ALLOW)
    // A question without a call's arguments is the snapshot's: a device sees that it may start chats.
    expect(createCondition(facts({ workspaces }), DEVICE)({ action: 'session/create', resource: GLOBAL })).toEqual(ALLOW)
  })

  it('needs an unlock for a folder outside the known workspaces, and for the Host\'s own folder', () => {
    // Pins the known-workspace check: a folder decides where the chat's commands may write.
    for (const request of [{ cwd: other }, { cwd: join(known, 'inner') }, { cwd: '/' }, { cwd: 'known' }, { cwd: `${known}\0` }, { cwd: join(directory, 'gone') }, { cwd: 7 }, {}, { workspaceId: 'w-unknown' }, { workspaceId: 'w-1', cwd: known }, undefined]) {
      expect(create(request), JSON.stringify(request)).toEqual(OUTSIDE)
    }
    expect(create({ cwd: known }, { workspaces: () => [{ id: workspace('w-gone'), path: join(directory, 'gone'), sessionIds: [] }] })).toEqual(OUTSIDE)
  })

  it('starts one outside the known workspaces under an unlock, and logs it', () => {
    const lines: string[] = []
    const unlocked = { elevationOf: () => ({ id: 'elevation-1' }), logElevated: (line: string) => { lines.push(line) } }
    expect(create({ cwd: other }, unlocked)).toEqual(ALLOW)
    expect(create({ workspaceId: 'w-1' }, unlocked)).toEqual(ALLOW)
    expect(lines).toEqual([`home-auth: elevated action: device=device-1 listener=${LISTENER} action=session/create elevation=elevation-1`])
  })
})

describe('an elevated action', () => {
  const ELEVATION = { id: 'elevation-1' }

  it('is refused without an unlock, for a call and for an event, a snapshot or a list filter', () => {
    const condition = createCondition(facts(), DEVICE)
    // Pins the unlock check, and that it runs before a question without arguments is allowed.
    for (const action of Object.keys(REACH_ELEVATED_ACTIONS) as RemoteAccessAction[]) {
      expect(condition({ action, resource: GLOBAL })).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
      expect(condition({ action, resource: GLOBAL, args: {} })).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
    }
  })

  it('is allowed while this device holds an unlock on this listener, and logged with it', () => {
    const lines: string[] = []
    const asked: string[] = []
    const elevationOf = (deviceId: string, listener: string) => {
      asked.push(`${deviceId}@${listener}`)
      return deviceId === 'device-1' && listener === LISTENER ? ELEVATION : undefined
    }
    const condition = createCondition(facts({ elevationOf, logElevated: (line) => { lines.push(line) } }), DEVICE)
    expect(condition({ action: 'terminal/create', resource: GLOBAL, args: { shell: 'x' } })).toEqual({ kind: 'allow' })
    expect(condition({ action: 'terminal/create', resource: GLOBAL })).toEqual({ kind: 'allow' })
    // Pins the device the condition asks for: device B's condition does not borrow device A's unlock.
    expect(createCondition(facts({ elevationOf }), reachDevicePrincipal('device-2', LISTENER))({ action: 'terminal/create', resource: GLOBAL, args: {} }))
      .toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
    // Pins the listener the condition asks for: an unlock on one listener admits nothing on another.
    expect(createCondition(facts({ elevationOf }), reachDevicePrincipal('device-1', OTHER_LISTENER))({ action: 'terminal/create', resource: GLOBAL, args: {} }))
      .toEqual({ kind: 'deny', reason: 'elevation-required: terminal/create' })
    expect(asked).toEqual([`device-1@${LISTENER}`, `device-1@${LISTENER}`, `device-2@${LISTENER}`, `device-1@${OTHER_LISTENER}`])
    // Only a call is logged; an event or a snapshot question is not one.
    expect(lines).toEqual([`home-auth: elevated action: device=device-1 listener=${LISTENER} action=terminal/create elevation=elevation-1`])
  })

  it('keeps the workspace-file rule under an unlock', () => {
    const condition = createCondition(facts({ elevationOf: () => ELEVATION }), DEVICE)
    expect(condition({ action: 'workspaceFiles/changes', resource: GLOBAL, args: { path: '.' } }))
      .toEqual({ kind: 'deny', reason: 'loopback-required: workspaceFiles/changes with a path outside the chat\'s workspace' })
  })
})

describe('the refusal reasons', () => {
  it('require the home\'s own computer for every action not allowed, classified or not', () => {
    expect(reachRefusal('credentials/set')).toBe('loopback-required: credentials/set')
    expect(reachRefusal('unclassified/method' as RemoteAccessAction)).toBe('loopback-required: unclassified/method')
    expect(reachRefusal('event:deepseek-account/session-expired')).toBe('loopback-required: event:deepseek-account/session-expired')
    expect(reachRefusal('session/list')).toBe('resource-unlisted: session/list')
    expect(reachRefusal('terminal/create')).toBe('resource-unlisted: terminal/create')
  })
})

/** The owner's classification (A297), stated as families, which every table entry is checked against. */
const NEVER = [/^credentials\//, /^event:credentials\//, /^account\//, /^event:deepseek-account\//, /^settings\/openSettingsDocument$/, /^session\/openWorkspacePath$/, /^session\/workspacePathApplications$/]
const UNLOCK = [
  /^settings\/(mutate|replace|update)$/, /^commands\/execute$/,
  /^pluginManager\/(installBundle|removeBundle|setBundleEnabled|setPluginEnabled|setVersionExemption|updateBundle|cancelInstall|undo|restore)$/,
  /^terminal\//, /^directoryPicker\//, /^workspace\/create$/, /^dynamicCordisRunner\//, /^event:cordis\//,
]

/**
 * The class A297 gives an action.
 * @param action - the action.
 * @returns its class.
 */
function classOf(action: string): 'allowed' | 'elevated' | 'never' {
  if (NEVER.some(pattern => pattern.test(action))) return 'never'
  return UNLOCK.some(pattern => pattern.test(action)) ? 'elevated' : 'allowed'
}

describe('the tables', () => {
  it('list no action in two of the three tables', () => {
    expect(() => { assertDisjoint({ allowed: REACH_ALLOWED_ACTIONS, elevated: REACH_ELEVATED_ACTIONS, never: REACH_DENIED_ACTIONS }) }).not.toThrow()
    // Pins the check the module runs at load.
    expect(() => { assertDisjoint({ allowed: { 'b/x': 'x', 'a/y': 'y' }, elevated: { 'a/y': 'y' }, never: { 'b/x': 'x', 'c/z': 'z' } }) })
      .toThrow('reach access lists ["a/y (allowed, elevated)","b/x (allowed, never)"] in two tables')
  })

  it('put every action in the class the owner\'s rule gives it', () => {
    // Pins each table entry: moving an action to another table fails here, naming it.
    const tables = { allowed: REACH_ALLOWED_ACTIONS, elevated: REACH_ELEVATED_ACTIONS, never: REACH_DENIED_ACTIONS }
    for (const [name, table] of Object.entries(tables)) {
      for (const action of Object.keys(table)) expect(classOf(action), action).toBe(name)
    }
    // The families each class names are all present.
    for (const action of ['workspace/delete', 'workspace/initializeDefault', 'session/selectModel', 'goals/create', 'schedule/run', 'workspaceFiles/changes', 'llm/discoverModels', 'sessionFeedback/record', 'messageFeedback/put', 'event:plugin-manager/install-log', 'session/create']) {
      expect(Object.hasOwn(REACH_ALLOWED_ACTIONS, action), action).toBe(true)
    }
    for (const action of ['settings/update', 'commands/execute', 'pluginManager/restore', 'terminal/attach', 'directoryPicker/pick', 'workspace/create', 'dynamicCordisRunner/invoke', 'event:cordis/request-run']) {
      expect(Object.hasOwn(REACH_ELEVATED_ACTIONS, action), action).toBe(true)
    }
    for (const action of ['credentials/set', 'event:credentials/record-updated', 'account/startSignIn', 'event:deepseek-account/session-expired', 'settings/openSettingsDocument', 'session/openWorkspacePath', 'session/workspacePathApplications']) {
      expect(Object.hasOwn(REACH_DENIED_ACTIONS, action), action).toBe(true)
    }
  })

  it('give every entry a one-line reason', () => {
    for (const reason of [...Object.values(REACH_ALLOWED_ACTIONS), ...Object.values(REACH_ELEVATED_ACTIONS), ...Object.values(REACH_DENIED_ACTIONS)]) {
      expect(reason).toMatch(/^[^\n]{8,}$/)
    }
  })
})
