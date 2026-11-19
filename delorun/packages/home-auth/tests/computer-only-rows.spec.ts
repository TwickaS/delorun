/**
 * What a device never changes, whatever unlocks it: the settings of the gate, reach and sandbox rows, the programs of the
 * computer's own screen, and (in PIN mode) what the approval grace does not reach. Each test's comment names the check
 * whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { createCondition, createReachAccessPolicy, PROTECTED_ROW_REFUSAL, reachDevicePrincipal, REACH_DANGEROUS_ACTIONS, type ReachAccessFacts } from '../src/reach-access.ts'

const LISTENER = 'reach-tailscale-private'
const GLOBAL = { kind: 'global' } as const
const SANDBOX_IDS = ['include:sandbox-local', 'include:sandbox-policy', 'include:delorun-home-auth', 'include:delorun-reach']
const UNLOCK = { id: 'unlock-1' }

/** Which unlock a device holds in a scenario. */
type Kind = 'code' | 'grace' | 'pin-page' | 'dangerous'

/**
 * Facts for a device holding one kind of unlock; a code and a grace are both the device's own elevation.
 * @param kind - the unlock.
 * @returns the facts.
 */
function facts(kind: Kind): ReachAccessFacts {
  return {
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => (kind === 'code' || kind === 'grace' || kind === 'dangerous' ? UNLOCK : undefined),
    pageUnlockOf: () => (kind === 'pin-page' ? UNLOCK : undefined), unlockModeEnabled: () => kind === 'pin-page',
    keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
    computerOnlySwitches: () => [], protectedEntryIds: () => new Set(SANDBOX_IDS), computerOnlyEntryIds: () => new Set(SANDBOX_IDS),
    defaultPermission: () => undefined, dangerousMode: () => kind === 'dangerous',
  }
}

const KINDS: readonly Kind[] = ['code', 'grace', 'pin-page', 'dangerous']
const principal = (kind: Kind) => reachDevicePrincipal('device-1', LISTENER, kind === 'pin-page' ? 'page-1' : undefined)

describe('the settings of the gate, reach and sandbox rows', () => {
  it('are refused to a device under every unlock kind and in dangerous mode, for update, mutate and replace', () => {
    for (const kind of KINDS) {
      for (const ns of ['sandbox-local', 'sandbox-policy', 'include:sandbox-policy', 'delorun-reach']) {
        const calls = [
          { action: 'settings/update', args: { ns, patch: { protectedHomeReadable: ['trust'] } } },
          { action: 'settings/mutate', args: { ns, ops: [{ op: 'set', path: ['protectedHome'], value: '/tmp' }] } },
          { action: 'settings/replace', args: { ns, section: {} } },
        ] as const
        for (const call of calls) {
          // Pins the namespace check: a write to the sandbox row's settings replaces the row in effect.
          expect(createCondition(facts(kind), principal(kind))({ ...call, resource: GLOBAL }), `${kind} ${call.action} ${ns}`).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
        }
      }
      // A namespace of another row is unaffected by this check.
      expect(createCondition(facts(kind), principal(kind))({ action: 'settings/update', resource: GLOBAL, args: { ns: 'delorun-cost-meter', patch: {} } }).kind).toBe('allow')
    }
  })

  it('are refused while the rows cannot be read', () => {
    const unreadable = { ...facts('code'), computerOnlyEntryIds: () => undefined }
    expect(createCondition(unreadable, principal('code'))({ action: 'settings/update', resource: GLOBAL, args: { ns: 'sandbox-policy', patch: {} } })).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
  })
})

describe('opening a chat\'s folder in an application, and listing the applications', () => {
  it('stay at the computer under every unlock kind and in dangerous mode', () => {
    expect(Object.keys(REACH_DANGEROUS_ACTIONS)).toEqual([])
    for (const kind of KINDS) {
      for (const binding of createReachAccessPolicy(facts(kind)).bindings(principal(kind))) {
        // Pins the empty lift table: the role lists neither action, so no condition is asked.
        expect(binding.role.actions).not.toContain('session/openWorkspacePath')
        expect(binding.role.actions).not.toContain('session/workspacePathApplications')
      }
    }
  })
})

describe('mcpManager/watch', () => {
  it('needs an unlock, because a server\'s last error is free text that can name paths and tokens', () => {
    const locked = { ...facts('code'), elevationOf: () => undefined }
    expect(createCondition(locked, principal('code'))({ action: 'mcpManager/watch', resource: GLOBAL, args: {} })).toEqual({ kind: 'deny', reason: 'elevation-required: mcpManager/watch' })
    expect(createCondition(facts('code'), principal('code'))({ action: 'mcpManager/watch', resource: GLOBAL, args: {} }).kind).toBe('allow')
  })
})

describe('the approval grace while PIN mode is on', () => {
  it('unlocks the device\'s elevated actions as a code does, and not the key actions or the lifts a PIN page alone has', () => {
    // A Peer with no page unlock falls back to the device's own elevation, which the grace is.
    const grace = { ...facts('grace'), unlockModeEnabled: () => true }
    const device = reachDevicePrincipal('device-1', LISTENER)
    const condition = createCondition(grace, device)
    expect(condition({ action: 'directoryPicker/pick' as never, resource: GLOBAL, args: {} }).kind).toBe('allow')
    // Pins the PIN check: model keys need an unlocked page in PIN mode, and the grace is no page.
    expect(condition({ action: 'credentials/set', resource: GLOBAL, args: { ref: 'DEEPSEEK_API_KEY' } })).toEqual({ kind: 'deny', reason: 'elevation-required: credentials/set' })
    // A lifted refusal (an unlisted command) stays refused: only a PIN page or dangerous mode lifts it.
    expect(condition({ action: 'commands/execute', resource: GLOBAL, args: { line: '/config set x' } }).kind).toBe('deny')
  })
})

describe('the bundles that carry a computer-only row', () => {
  it('are all listed: a bundle patch that names one of the modules and is missing from COMPUTER_ONLY_BUNDLES fails', async () => {
    const { readdirSync, readFileSync, existsSync, statSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { COMPUTER_ONLY_BUNDLES, COMPUTER_ONLY_ROW_MODULES } = await import('../src/reach-access.ts')
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
    const roots = [join(repo, 'delorun', 'packages'), ...readdirSync(join(repo, 'packages')).map(group => join(repo, 'packages', group))]
    const missing: string[] = []
    for (const root of roots) {
      for (const entry of statSync(root).isDirectory() ? readdirSync(root) : []) {
        const patch = join(root, entry, 'cordis.patch.yml')
        const manifest = join(root, entry, 'package.json')
        if (!existsSync(patch) || !existsSync(manifest)) continue
        const text = readFileSync(patch, 'utf8')
        if (!Object.keys(COMPUTER_ONLY_ROW_MODULES).some(module => text.includes(module))) continue
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name
        // Pins the list: a bundle that mounts the gate, reach or the sandbox must be refused to a device.
        if (!COMPUTER_ONLY_BUNDLES.includes(name)) missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('the settings namespace of a composed row', () => {
  it('is refused when the row\'s `id` option, not its entry id, names the namespace, as the real profile composes it', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { computerOnlyEntryIdsOf } = await import('../src/authenticator.ts')
    const ctx = new Context()
    ctx.provide('loader', { entries: () => [
      { id: 'include:sandbox', options: { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' } },
      { id: 'include:sandbox-policy', options: { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' } },
      { id: 'include:home-auth', options: { id: 'delorun-home-auth', name: '@delorun/home-auth' } },
      { id: 'include:reach', options: { id: 'delorun-reach', name: '@delorun/reach' } },
    ] } as never)
    for (const kind of KINDS) {
      const real = { ...facts(kind), computerOnlyEntryIds: () => computerOnlyEntryIdsOf(ctx) }
      for (const ns of ['sandbox', 'sandbox-policy', 'delorun-home-auth', 'delorun-reach']) {
        expect(createCondition(real, principal(kind))({ action: 'settings/update', resource: GLOBAL, args: { ns, patch: {} } }), `${kind} ${ns}`).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
      }
    }
  })
})

describe('the webhook server row of @delorun/bundle-webhooks', () => {
  const ctx = async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const context = new Context()
    context.provide('loader', { entries: () => [
      { id: 'include:github-webhook-ingress', options: { id: 'github-webhook-ingress', name: 'cordis:group' } },
      { id: 'github-webhook-ingress:github-webhook-server', options: { id: 'github-webhook-server', name: '@delorun/bundle-webhooks/server' } },
    ] } as never)
    return context
  }

  it('is refused to a device under every unlock kind and in dangerous mode: no write moves its listener off loopback', async () => {
    const { computerOnlyEntryIdsOf } = await import('../src/authenticator.ts')
    const context = await ctx()
    for (const kind of KINDS) {
      const real = { ...facts(kind), computerOnlyEntryIds: () => computerOnlyEntryIdsOf(context) }
      const calls = [
        { action: 'settings/update', args: { ns: 'github-webhook-server', patch: { host: '0.0.0.0' } } },
        { action: 'settings/mutate', args: { ns: 'github-webhook-server', ops: [{ op: 'set', path: ['port'], value: 80 }] } },
        { action: 'settings/replace', args: { ns: 'github-webhook-server', section: { host: '0.0.0.0', port: 3081 } } },
        { action: 'pluginManager/setPluginEnabled', args: { id: 'github-webhook-server', enabled: false } },
        { action: 'pluginManager/setBundleEnabled', args: { name: '@delorun/bundle-webhooks', enabled: false } },
      ] as const
      for (const call of calls) {
        // Pins `@delorun/bundle-webhooks/server` in COMPUTER_ONLY_ROW_MODULES and the bundle in COMPUTER_ONLY_BUNDLES.
        expect(createCondition(real, principal(kind))({ ...call, resource: GLOBAL }), `${kind} ${call.action}`).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
      }
    }
  })
})
