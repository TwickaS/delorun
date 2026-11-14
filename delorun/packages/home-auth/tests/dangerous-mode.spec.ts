/**
 * Dangerous mode in the reach policy and the shared route helpers: each refusal that only keeps a device from what the
 * computer does is refused with the mode off and lifted for an unlocked device with it on, a locked device keeps its
 * refusal in both, and the routes that approve a device or sign one in are not among them.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  admitUnlockedDevice,
  requireComputer,
  requireComputerUnlessDangerous,
} from '../src/computer-only.ts'
import {
  DANGEROUS_LIFTABLE_SWITCHES,
  DEFAULT_PERMISSION_REFUSAL,
  PROTECTED_ROW_REFUSAL,
  REACH_DANGEROUS_ACTIONS,
  REACH_DENIED_ACTIONS,
  UNLISTED_COMMAND_REFUSAL,
  createCondition,
  createReachAccessPolicy,
  reachDevicePrincipal,
  switchOffRefusal,
  type ComputerOnlySwitch,
  type DefaultPermission,
  type PermissionLevel,
  type ReachAccessFacts,
} from '../src/reach-access.ts'
import { HOME_AUTH_SWITCH, REACH_SWITCH } from '../src/service.ts'

const LISTENER = 'reach-tailscale-private'
const DEVICE = reachDevicePrincipal('device-1', LISTENER)
const GLOBAL = { kind: 'global' } as const
const CONSENT: ComputerOnlySwitch = { ns: 'delorun-delegation-consent', field: 'enabled', label: 'the external-agent consent' }
const PROTECTED_ROW = 'include:delorun-permission-defaults'
const LEVELS: Readonly<Record<string, PermissionLevel>> = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}
const PERMISSION: DefaultPermission = { namespaces: new Set(['permission']), current: LEVELS['workspace-write'], levelOf: name => LEVELS[name] }
const UNLOCK = { id: 'elevation-1' }

/**
 * Policy facts for one device, with dangerous mode and the device's unlock set by the test.
 * @param mode - whether dangerous mode holds.
 * @param unlocked - whether the device holds an unlock.
 * @returns the facts.
 */
function facts(mode: boolean, unlocked: boolean): ReachAccessFacts {
  return {
    admitted: () => true,
    workspaces: () => [{ id: 'w-1' as WorkspaceId, path: '/nowhere/w-1', sessionIds: ['s-1' as SessionId] }],
    liveSessions: () => [],
    workspaceRootOf: () => undefined,
    delorunHome: '/nowhere',
    elevationOf: () => (unlocked ? UNLOCK : undefined),
    pageUnlockOf: () => undefined,
    logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
    computerOnlySwitches: () => [CONSENT],
    protectedEntryIds: () => new Set([PROTECTED_ROW]),
    defaultPermission: () => PERMISSION,
    dangerousMode: () => mode,
  }
}

/** One call per lifted refusal of the policy: what the device sends, and the refusal the mode lifts. */
const LIFTED: readonly { readonly name: string; readonly action: string; readonly args: Record<string, unknown>; readonly reason: string }[] = [
  { name: 'turning a computer-only switch off', action: 'settings/update', args: { ns: CONSENT.ns, patch: { enabled: false } }, reason: switchOffRefusal(CONSENT.label) },
  { name: 'loosening the permission new chats start in', action: 'settings/update', args: { ns: 'permission', patch: { defaultPreset: 'danger-full-access' } }, reason: DEFAULT_PERMISSION_REFUSAL },
  { name: 'changing a protected plugin row', action: 'pluginManager/setPluginEnabled', args: { id: PROTECTED_ROW, enabled: false }, reason: PROTECTED_ROW_REFUSAL },
  { name: 'a slash command a device does not run', action: 'commands/execute', args: { line: '/config set enabled false' }, reason: UNLISTED_COMMAND_REFUSAL },
  { name: 'saving a provider key', action: 'credentials/set', args: { ref: 'DEEPSEEK_API_KEY', value: 'sk-test' }, reason: 'loopback-required: credentials/set' },
  { name: 'removing a provider key', action: 'credentials/unset', args: { ref: 'DEEPSEEK_API_KEY' }, reason: 'loopback-required: credentials/unset' },
  { name: 'reading whether a provider key is saved', action: 'credentials/describe', args: { ref: 'DEEPSEEK_API_KEY' }, reason: 'loopback-required: credentials/describe' },
  { name: 'opening a chat\'s folder in an application', action: 'session/openWorkspacePath', args: { sessionId: 's-1' }, reason: 'loopback-required: session/openWorkspacePath' },
  { name: 'listing the applications that open a chat\'s folder', action: 'session/workspacePathApplications', args: { sessionId: 's-1' }, reason: 'loopback-required: session/workspacePathApplications' },
]

describe('the reach policy in dangerous mode', () => {
  for (const lifted of LIFTED) {
    it(`refuses ${lifted.name} with the mode off, and admits it to an unlocked device with the mode on`, () => {
      const call = { action: lifted.action as never, resource: GLOBAL, args: lifted.args }
      // Pins the mode check: without it the mode lifts nothing, or lifts the refusal in every mode.
      expect(createCondition(facts(false, true), DEVICE)(call)).toEqual({ kind: 'deny', reason: lifted.reason })
      expect(createCondition(facts(false, false), DEVICE)(call)).toEqual({ kind: 'deny', reason: lifted.reason })
      expect(createCondition(facts(true, true), DEVICE)(call)).toEqual({ kind: 'allow' })
      // Pins the unlock check after the lift: a locked device keeps a refusal, with the elevation reason.
      expect(createCondition(facts(true, false), DEVICE)(call)).toEqual({ kind: 'deny', reason: `elevation-required: ${lifted.action}` })
    })
  }

  it('lifts only the computer-only switches on the allow list: the real reach and home-auth (pairing) switches stay refused in the mode', () => {
    const state = { ...facts(true, true), computerOnlySwitches: () => [CONSENT, REACH_SWITCH, HOME_AUTH_SWITCH] }
    const calls = [
      { target: REACH_SWITCH, args: { ns: REACH_SWITCH.ns, patch: { [REACH_SWITCH.field]: false } } },
      // The pairing choices live in the home-auth row, whose every write is computer-only.
      { target: HOME_AUTH_SWITCH, args: { ns: HOME_AUTH_SWITCH.ns, ops: [{ op: 'set', path: ['pairing', 'mayAskWithoutWindow'], value: 'tailnet' }] } },
    ]
    for (const { target, args } of calls) {
      const action = (args.ops === undefined ? 'settings/update' : 'settings/mutate') as never
      // Pins the allow list: the mode never lifts a switch that is not named in DANGEROUS_LIFTABLE_SWITCHES.
      expect(createCondition(state, DEVICE)({ action, resource: GLOBAL, args }), target.ns).toEqual({ kind: 'deny', reason: switchOffRefusal(target.label) })
    }
    expect([...DANGEROUS_LIFTABLE_SWITCHES]).toEqual([CONSENT.ns])
  })

  it('lifts every action of the dangerous table, for a call and for a question without arguments', () => {
    for (const action of Object.keys(REACH_DANGEROUS_ACTIONS)) {
      const ask = (mode: boolean, unlocked: boolean) => createCondition(facts(mode, unlocked), DEVICE)({ action: action as never, resource: GLOBAL })
      // Pins the table: an action listed there is decided by the mode and the unlock, a snapshot question included.
      expect(ask(false, true), action).toEqual({ kind: 'deny', reason: `loopback-required: ${action}` })
      expect(ask(true, false), action).toEqual({ kind: 'deny', reason: `elevation-required: ${action}` })
      expect(ask(true, true), action).toEqual({ kind: 'allow' })
    }
  })

  it('keeps the rest of the never table out of every role, in the mode and unlocked', () => {
    // Pins the role: account actions and the settings document are not among the lifts, so no condition admits them.
    const lifted = new Set(Object.keys(REACH_DANGEROUS_ACTIONS))
    const stays = Object.keys(REACH_DENIED_ACTIONS).filter(action => !lifted.has(action))
    expect(stays).toContain('account/startSignIn')
    expect(stays).toContain('settings/openSettingsDocument')
    for (const binding of createReachAccessPolicy(facts(true, true)).bindings(DEVICE)) {
      for (const action of stays) expect(binding.role.actions, action).not.toContain(action)
      for (const action of lifted) expect(binding.role.actions, action).toContain(action)
    }
  })
})

describe('a workspace-file path outside the chat\'s workspace', () => {
  const SESSION = 's-1' as SessionId
  let directory = ''
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  /**
   * A workspace, a file beside it and a file in the Delorun home, all real.
   * @returns the paths and the policy facts that name the workspace.
   */
  function layout() {
    directory = mkdtempSync(join(tmpdir(), 'delorun-dangerous-'))
    const workspace = join(directory, 'workspace')
    const home = join(directory, '.delorun')
    mkdirSync(workspace)
    mkdirSync(join(home, 'secrets'), { recursive: true })
    writeFileSync(join(workspace, 'inside.txt'), 'in')
    writeFileSync(join(directory, 'outside.txt'), 'out')
    writeFileSync(join(home, 'secrets', 'key'), 'secret')
    symlinkSync(join(home, 'secrets'), join(workspace, 'link'))
    return { workspace, home, outside: join(directory, 'outside.txt'), with: (mode: boolean, unlocked: boolean): ReachAccessFacts => ({ ...facts(mode, unlocked), workspaceRootOf: () => workspace, delorunHome: home }) }
  }
  const read = (state: ReachAccessFacts, path: string) =>
    createCondition(state, DEVICE)({ action: 'workspaceFiles/read' as never, resource: { kind: 'session', id: SESSION }, args: { path } })

  it('is refused with the mode off, unlocked or not, and to a locked device in the mode, and read by an unlocked one in the mode', () => {
    const { outside, with: at } = layout()
    const refusal = { kind: 'deny', reason: 'loopback-required: workspaceFiles/read with a path outside the chat\'s workspace' }
    // Pins the mode check, then the unlock check, one each.
    expect(read(at(false, true), outside)).toEqual(refusal)
    expect(read(at(false, false), outside)).toEqual(refusal)
    expect(read(at(true, false), outside)).toEqual(refusal)
    expect(read(at(true, true), outside)).toEqual({ kind: 'allow' })
  })

  it('still reads the workspace without an unlock, and never reaches the Delorun home, a link into it or an unresolved path', () => {
    const { workspace, home, with: at } = layout()
    expect(read(at(false, false), join(workspace, 'inside.txt'))).toEqual({ kind: 'allow' })
    // Pins the Delorun home check, which the mode does not move.
    for (const path of [join(home, 'secrets', 'key'), 'link/key', '~/.delorun/secrets/key', '../.delorun/secrets/key', join(workspace, 'missing.txt')]) {
      expect(read(at(true, true), path), path).toMatchObject({ kind: 'deny' })
    }
  })
})

/**
 * A response that records what was answered.
 * @returns the response and the answer.
 */
function recording(): { response: ServerResponse; answered: { status?: number; body?: string } } {
  const answered: { status?: number; body?: string } = {}
  const response = { writeHead(status: number) { answered.status = status }, end(body: string) { answered.body = body } }
  return { response: response as never, answered }
}

/**
 * A `homeAuth` that places every request on one listener.
 * @param listener - the listener, or undefined for a request it cannot place.
 * @param mode - whether dangerous mode holds.
 * @param unlocked - whether every device holds an unlock.
 * @returns the part of the service the helpers read.
 */
function home(listener: string | undefined, mode: boolean, unlocked = true, pin = false, pageUnlocked = false) {
  return {
    pinEnabled: () => pin,
    pageUnlockOf: id => (pageUnlocked && id === 'page-1' ? { id: 'page-1' } : undefined),
    arrivalOf: () => ({ listener, host: undefined, source: 'unknown' as const }),
    dangerousMode: () => mode,
    elevationOf: () => (unlocked ? { id: 'elevation-1' } : undefined),
  } as never
}

describe('requireComputerUnlessDangerous', () => {
  it('refuses a reach request with the mode off, as requireComputer does, and lets it through with the mode on', () => {
    const request = { headers: { host: 'home.example.ts.net' } } as never
    const off = recording()
    expect(requireComputerUnlessDangerous(request, off.response, home(LISTENER, false), 'Turning on full access')).toBe(false)
    expect(off.answered.status).toBe(403)
    expect(JSON.parse(off.answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
    const on = recording()
    // Pins the mode check: the route then reaches `admitPeer`, which decides the device.
    expect(requireComputerUnlessDangerous(request, on.response, home(LISTENER, true), 'Turning on full access')).toBe(true)
    expect(on.answered).toEqual({})
  })

  it('still refuses what the home cannot place, a foreign Host on loopback and a home without homeAuth, in the mode', () => {
    const cases: [string | undefined, string, boolean][] = [
      [undefined, 'localhost:3080', true],
      ['loopback', 'attacker.example', true],
      ['loopback', 'localhost:3080', false],
    ]
    for (const [listener, host, mounted] of cases) {
      const { response, answered } = recording()
      expect(requireComputerUnlessDangerous({ headers: { host } } as never, response, mounted ? home(listener, true) : undefined, 'Turning on full access')).toBe(false)
      expect(answered.status).toBe(403)
    }
  })

  it('lets the computer through in both modes', () => {
    for (const mode of [false, true]) {
      const { response, answered } = recording()
      expect(requireComputerUnlessDangerous({ headers: { host: 'localhost:3080' } } as never, response, home('loopback', mode), 'Turning on full access')).toBe(true)
      expect(answered).toEqual({})
    }
  })

  it('leaves requireComputer refusing a reach request in the mode: device approval and sign-in use it', () => {
    // Pins the split: the approval and sign-in routes keep `requireComputer`, which never reads the mode.
    const { response, answered } = recording()
    expect(requireComputer({ headers: { host: 'home.example.ts.net' } } as never, response, home(LISTENER, true), 'Approving a device')).toBe(false)
    expect(answered.status).toBe(403)
  })
})

describe('admitUnlockedDevice', () => {
  const peer = (kind: string, principal: object = {}) => ({ principal: { kind, ...principal } })
  const device = peer('reach-device', { deviceId: 'device-1', listener: LISTENER })
  const admits = (service: ReturnType<typeof home> | undefined, who: ReturnType<typeof peer>): boolean =>
    admitUnlockedDevice(() => service)({} as never, who)

  it('admits a reach device that holds an unlock while the mode holds, and no other Peer', () => {
    expect(admits(home(LISTENER, true), device)).toBe(true)
    // Pins the mode check, the unlock check, the principal check and the mounted check, one each.
    expect(admits(home(LISTENER, false), device)).toBe(false)
    expect(admits(home(LISTENER, true, false), device)).toBe(false)
    expect(admits(home(LISTENER, true), peer('anonymous'))).toBe(false)
    expect(admits(undefined, device)).toBe(false)
  })
})

describe('an unlocked PIN page without dangerous mode', () => {
  const page = { principal: { kind: 'reach-device', deviceId: 'device-1', listener: LISTENER, unlockId: 'page-1' } }
  const request = { headers: { host: 'home.example.ts.net' } } as never

  it('is admitted to the consent and permission routes, and a locked page, a tokenless Peer and a device unlock are not', () => {
    const { response } = recording()
    expect(requireComputerUnlessDangerous(request, response, home(LISTENER, false, false, true), 'Turning on full access')).toBe(true)
    expect(admitUnlockedDevice(() => home(LISTENER, false, false, true, true))({} as never, page)).toBe(true)
    // Pins the unlock check: a page whose unlock ended is refused although PIN mode is on.
    expect(admitUnlockedDevice(() => home(LISTENER, false, false, true, false))({} as never, page)).toBe(false)
    // A device with no page unlock (a tokenless Peer) needs dangerous mode and its elevation.
    const tokenless = { principal: { kind: 'reach-device', deviceId: 'device-1', listener: LISTENER } }
    expect(admitUnlockedDevice(() => home(LISTENER, false, true, true, true))({} as never, tokenless)).toBe(false)
    expect(admitUnlockedDevice(() => home(LISTENER, false, true, true, true))({} as never, { principal: { kind: 'anonymous' } })).toBe(false)
    // With PIN mode and dangerous mode both off the hook refuses the reach request.
    const off = recording()
    expect(requireComputerUnlessDangerous(request, off.response, home(LISTENER, false, false, false), 'Turning on full access')).toBe(false)
    expect(off.answered.status).toBe(403)
  })

  it('is bound to no settings-document or account action, and no mode or unlock lifts them', () => {
    const pagePrincipal = reachDevicePrincipal('device-1', LISTENER, 'page-1')
    const state: ReachAccessFacts = { ...facts(false, false), pageUnlockOf: id => (id === 'page-1' ? { id: 'page-1' } : undefined) }
    const denied = Object.keys(REACH_DENIED_ACTIONS).filter(action => action === 'settings/openSettingsDocument' || action.startsWith('account/'))
    expect(denied).toContain('settings/openSettingsDocument')
    expect(denied).toContain('account/signOut')
    const bindings = createReachAccessPolicy(state).bindings(pagePrincipal)
    expect(bindings.length).toBeGreaterThan(0)
    for (const binding of bindings) {
      // Pins the role lists: an action outside them is refused by default, whatever the unlock.
      for (const action of denied) expect(binding.role.actions, action).not.toContain(action)
    }
  })

  it('is refused approving a device, reach and network exposure, and PIN changes, which keep requireComputer', () => {
    const request = { headers: { host: 'home.example.ts.net' } } as never
    for (const action of ['Approving a device', 'Changing remote access', 'Changing network exposure', 'Changing the PIN']) {
      const { response, answered } = recording()
      expect(requireComputer(request, response, home(LISTENER, false, false, true, true), action), action).toBe(false)
      expect(answered.status).toBe(403)
    }
  })

  it('is still refused the step-up routes, which keep requireComputer and read neither mode nor unlock', () => {
    const { response, answered } = recording()
    expect(requireComputer(request, response, home(LISTENER, false, false, true, true), 'Changing remote access')).toBe(false)
    expect(answered.status).toBe(403)
  })
})

describe('the routes that approve a device, sign one in, remove one or change remote access', () => {
  it('never read dangerous mode, so no mode lifts their refusal', () => {
    // Pins the split: these route files decide the arrival from the home's core, which has no dangerous-mode input.
    for (const file of ['reach-routes.ts', 'routes.ts', 'elevation-routes.ts', 'sign-in.ts', 'approvals.ts', 'pairing.ts', 'sessions.ts', '../../reach/src/service.ts', '../../reach/src/front.ts', '../../home-process/src/reach.ts', '../../home-process/src/devices-approve.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      expect(source, file).not.toMatch(/dangerousMode|pinEnabled|pageUnlockOf|requireComputerUnlessDangerous|admitUnlockedDevice/)
    }
  })
})
