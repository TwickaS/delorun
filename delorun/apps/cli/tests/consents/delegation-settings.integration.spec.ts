/**
 * @file The external-agent consent's fields saved from Settings on a booted Host with upstream's configuration editor
 * and Settings service: the switch turns the consent off and on, and the run time limit applies to the next run, each
 * without restarting the row.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import Settings from '@deepseek-ai/dsh-settings'
import * as DelegationConsent from '@delorun/plugin-delegation-consent'
import { DELEGATION_CONSENT_ROW } from '@delorun/plugin-delegation-consent/wire'

let home: string
let ctx: Context

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-delegation-settings-')))
  const dir = join(home, 'profiles', 'default')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: DELEGATION_CONSENT_ROW, name: 'cordis:consent', config: { enabled: true } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'default', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx = await boot('default', join(dir, 'cordis.yml'), readProfilePatches('default', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, consent: DelegationConsent })
  })
  await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** @returns the consent's Loader row. */
function row(): Entry {
  const found = [...ctx.loader.entries()].find(entry => entry.options.id === DELEGATION_CONSENT_ROW)
  if (found === undefined) throw new Error('the profile has no external-agent consent row')
  return found
}

describe('saving the external-agent consent from Settings', () => {
  it('turns the consent off and on again without restarting its row', async () => {
    const fiber = row().fiber
    await ctx.settings.update(DELEGATION_CONSENT_ROW, { enabled: false })
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeUndefined() })
    await ctx.settings.update(DELEGATION_CONSENT_ROW, { enabled: true })
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
    expect(row().fiber).toBe(fiber)
  })

  it('keeps the running consent when the run time limit changes', async () => {
    const changes: string[] = []
    ctx.on('internal/service', (name: string) => { changes.push(name) })
    await ctx.settings.update(DELEGATION_CONSENT_ROW, { runTimeoutMinutes: 7 })
    expect(changes.filter(name => name === 'delegationConsent')).toEqual([])
    expect(ctx.get('delegationConsent')).toBeDefined()
  })
})
