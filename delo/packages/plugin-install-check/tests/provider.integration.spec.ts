/**
 * The mounted plugin: with its switch on it provides `pluginAudit`, which answers the plugin manager `clear` with every
 * finding shown, `needs-acceptance` for a known critical advisory, and `accepted` once the person accepts exactly that
 * set; and `deloPluginTrust`, which reads and refreshes the trust status. With the switch off it provides neither.
 * A loopback stand-in answers for the advisory feed and the registry.
 */
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PluginAuditResult } from '@deepseek-ai/dsh-plugin-manager'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, blockingDigest, Config, inject, name, resolveSettings, type PluginTrust } from '../src/index.ts'
import { advisory, OLD, removeProfile, startStandIn, writeProfile, type StandIn } from './fixture.ts'

let standIn: StandIn
let dir: string

beforeEach(async () => {
  standIn = await startStandIn({ advisories: {}, times: { 'good-plugin': { '1.0.0': OLD } } })
  dir = writeProfile([{ name: 'good-plugin', version: '1.0.0', direct: true }])
})

afterEach(async () => {
  await standIn.close()
  removeProfile(dir)
})

/**
 * Mount the plugin over the fixture profile, its endpoints on the stand-in.
 * @param enabled - the switch.
 * @returns the root context.
 */
async function mount(enabled: boolean): Promise<Context> {
  const ctx = new Context()
  ctx.provide('profileContext', { dir, installAnchor: `${dir}/missing-installation/package.json` })
  const config = { ...Config({ enabled }), advisoryFeed: standIn.feed, registry: standIn.registry }
  await ctx.plugin({ name, inject, apply }, config)
  return ctx
}

/**
 * Ask the mounted audit about the fixture plugin.
 * @param ctx - the root context.
 * @param accepted - the digests the person accepted.
 * @returns its answer.
 */
function audit(ctx: Context, accepted: string[] = []): Promise<PluginAuditResult> {
  return ctx.get('pluginAudit')!.audit({ name: 'good-plugin', version: '1.0.0', dir: `${dir}/node_modules/good-plugin`, accepted })
}

describe('the install check plugin', () => {
  it('provides nothing with its switch off', async () => {
    const ctx = await mount(false)
    expect(ctx.get('pluginAudit')).toBeUndefined()
    expect(ctx.get('deloPluginTrust')).toBeUndefined()
  })

  it('answers clear with every finding shown, so the installation goes on', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'moderate', '*')] }
    const result = await audit(await mount(true))
    expect(result.decision).toBe('clear')
    expect(result.findings).toEqual([{ rule: 'delo.advisory', title: 'GHSA-2222-3333-4444 (moderate) affects good-plugin@1.0.0: A flaw in the package (GHSA-2222-3333-4444)', severity: 'warning', path: 'pnpm-lock.yaml', line: 13, excerpt: 'good-plugin 1.0.0' }])
  })

  it('needs the person\'s acceptance for a known critical advisory, and accepts exactly that set', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const ctx = await mount(true)
    const refused = await audit(ctx)
    expect(refused.decision).toBe('needs-acceptance')
    expect(refused.findings.map(finding => finding.severity)).toEqual(['critical'])
    expect(await audit(ctx, ['sha256:another-set'])).toMatchObject({ decision: 'needs-acceptance' })
    const accepted = await audit(ctx, [refused.digest])
    expect(accepted).toMatchObject({ decision: 'accepted', digest: refused.digest })
    expect(refused.digest).toBe(blockingDigest('good-plugin', [{ rule: 'advisory', advisory: 'GHSA-2222-3333-4444', package: 'good-plugin', version: '1.0.0', title: '', path: '', line: 0, severity: 'critical' }]))
  })

  it('answers clear with a finding when the check itself fails, never refusing for its own failure', async () => {
    const pluginDir = join(dir, 'node_modules', 'good-plugin')
    chmodSync(pluginDir, 0o000)
    try {
      const result = await audit(await mount(true))
      expect(result.decision).toBe('clear')
      expect(result.findings).toEqual([{ rule: 'delo.check-failed', title: expect.stringMatching(/^The install check could not run: EACCES/u) as string, severity: 'warning', path: '', line: 0, excerpt: 'good-plugin' }])
    } finally {
      chmodSync(pluginDir, 0o755)
    }
  })

  it('reads and refreshes the trust status through deloPluginTrust', async () => {
    const ctx = await mount(true)
    const trust = ctx.get('deloPluginTrust') as PluginTrust
    expect(await trust.status()).toBeUndefined()
    await audit(ctx)
    const status = await trust.check(true)
    expect(status.plugins.map(plugin => [plugin.name, plugin.state])).toEqual([['good-plugin', 'unchanged']])
    expect(await trust.status()).toEqual(status)
  })
})

describe('the configuration', () => {
  it('refuses an http endpoint and a trusted source that is neither a scope nor a git owner', () => {
    expect(() => Config({ registry: 'http://registry.example.test/' })).toThrow()
    expect(() => Config({ advisoryFeed: 'http://feed.example.test/' })).toThrow()
    expect(() => Config({ trustedSources: ['mine'] })).toThrow()
    expect(Config({ trustedSources: ['@mine', 'github.com/me'] }).trustedSources).toEqual(['@mine', 'github.com/me'])
  })

  it('resolves the registry with its trailing slash', () => {
    expect(resolveSettings(Config({ registry: 'https://registry.example.test' })).registry).toBe('https://registry.example.test/')
  })
})
