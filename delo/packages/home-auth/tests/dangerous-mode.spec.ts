/**
 * Dangerous mode in the reach policy and the shared route helpers: each refusal that only keeps a device from what the
 * computer does is refused with the mode off and lifted for an unlocked device with it on, a locked device keeps its
 * refusal in both, and the routes that approve a device or sign one in are not among them.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  admitUnlockedDevice,
  requireComputer,
  requireComputerUnlessDangerous,
} from '../src/computer-only.ts'
import {
  DEFAULT_PERMISSION_REFUSAL,
  PROTECTED_ROW_REFUSAL,
  UNLISTED_COMMAND_REFUSAL,
  createCondition,
  reachDevicePrincipal,
  switchOffRefusal,
  type ComputerOnlySwitch,
  type DefaultPermission,
  type PermissionLevel,
  type ReachAccessFacts,
} from '../src/reach-access.ts'

const LISTENER = 'reach-tailscale-private'
const DEVICE = reachDevicePrincipal('device-1', LISTENER)
const GLOBAL = { kind: 'global' } as const
const CONSENT: ComputerOnlySwitch = { ns: 'delo-delegation-consent', field: 'enabled', label: 'the external-agent consent' }
const PROTECTED_ROW = 'include:delo-permission-defaults'
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
    deloHome: '/nowhere',
    elevationOf: () => (unlocked ? UNLOCK : undefined),
    logElevated: () => {},
    terminalFoldersOf: () => undefined,
    grantedFolders: () => [],
    terminalWithoutUnlock: () => false,
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

  it('keeps a path outside the chat\'s workspace refused to an unlocked device', () => {
    // Pins the path jail: the mode lifts computer-only refusals, not the bounds of the files a device reads.
    const read = createCondition(facts(true, true), DEVICE)({ action: 'workspaceFiles/read' as never, resource: { kind: 'session', id: 's-1' as SessionId }, args: { path: '/etc/passwd' } })
    expect(read).toMatchObject({ kind: 'deny' })
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
function home(listener: string | undefined, mode: boolean, unlocked = true) {
  return {
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

describe('the routes that approve a device, sign one in or extend remote access', () => {
  it('never read dangerous mode, so no mode lifts their refusal', () => {
    // Pins the split: these route files decide the arrival from the home's core, which has no dangerous-mode input.
    for (const file of ['reach-routes.ts', 'routes.ts', 'elevation-routes.ts', 'sign-in.ts', 'approvals.ts', 'sessions.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      expect(source, file).not.toMatch(/dangerousMode|requireComputerUnlessDangerous|admitUnlockedDevice/)
    }
  })
})
