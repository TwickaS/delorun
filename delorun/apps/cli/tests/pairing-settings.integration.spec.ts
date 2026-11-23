/**
 * Settings → Devices writes the home-auth row's `pairing` section (contract C5, "Pop-up pairing"). Over a booted Host with
 * upstream's configuration editor and Settings service and the real `homeAuth` service on the `delorun-home-auth` row, a
 * write from the computer takes effect without a restart, an out-of-bounds value is refused with nothing saved, and the
 * reach-device policy built from the switches the mounted service registered refuses the same write from a device.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import Settings from '@deepseek-ai/dsh-settings'
import { createReachAccessPolicy, HomeAuthService, reachDevicePrincipal } from '@delorun/home-auth'

let home: string
let profile: ProfileContext
let ctx: Context

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-pairing-settings-')))
  const dir = join(home, 'profiles', 'default')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'delorun-home-auth', name: 'cordis:homeAuth', config: { secretsDirectory: join(home, 'secrets', 'home-auth') } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  profile = {
    name: 'default', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx = await boot('default', join(profile.dir, 'cordis.yml'), readProfilePatches('default', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    root.provide('webServer', { port: 0, register: () => () => {} } as never)
    Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, homeAuth: HomeAuthService })
  })
  await new Promise<void>((resolve) => { ctx.inject(['homeAuth'], () => { resolve() }) })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

describe('Settings → Devices writing the pairing section', () => {
  it('applies a write from the computer to the running home without a restart', async () => {
    expect(ctx.homeAuth.pairing()).toMatchObject({ mayAskWithoutWindow: 'own-user', showRequest: 'dialog', windowMinutes: 5 })
    const service = ctx.homeAuth
    await ctx.settings.mutate('delorun-home-auth', [{ op: 'set', path: ['pairing', 'mayAskWithoutWindow'], value: 'tailnet' }])
    await ctx.settings.mutate('delorun-home-auth', [{ op: 'set', path: ['pairing', 'windowMinutes'], value: 10 }])
    // Pins the per-call read: the service object that was running before the write answers the new values.
    expect(service.pairing()).toMatchObject({ mayAskWithoutWindow: 'tailnet', windowMinutes: 10 })
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('tailnet')
  })

  it('refuses a value outside the schema bounds and keeps the saved choices', async () => {
    const before = readFileSync(profile.patchPath, 'utf8')
    await expect(ctx.settings.mutate('delorun-home-auth', [{ op: 'set', path: ['pairing', 'windowMinutes'], value: 99 }])).rejects.toThrow()
    expect(ctx.homeAuth.pairing().windowMinutes).toBe(5)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  })

  it('refuses the same write from a reach device, under the switches the mounted service registered', () => {
    ctx.homeAuth.serve({ listener: 'reach-tailscale-private', address: 'https://home.example.ts.net' as never, factor: 'tailnet-membership' })
    const policy = createReachAccessPolicy({
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: home, unlockModeEnabled: () => false, keyRefs: () => new Set<string>(),
      elevationOf: () => undefined, logElevated: () => {}, liftedSettings: () => undefined,
      computerOnlySwitches: () => ctx.homeAuth.computerOnlySwitches(),
      protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(), defaultPermission: () => undefined, dangerousMode: () => false, pageUnlockOf: () => undefined,
    })
    const condition = policy.bindings(reachDevicePrincipal('device-1' as never, 'reach-tailscale-private'))[0]?.condition
    const write = { action: 'settings/mutate', resource: { kind: 'global' }, args: { ns: 'delorun-home-auth', ops: [{ op: 'set', path: ['pairing', 'mayAskWithoutWindow'], value: 'tailnet' }] } }
    expect(condition?.(write as never)).toEqual({ kind: 'deny', reason: 'loopback-required: turning the home-auth settings off' })
    expect(ctx.homeAuth.pairing().mayAskWithoutWindow).toBe('own-user')
  })
})
