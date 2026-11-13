/**
 * The mounted plugin: with its switch on it provides `pluginAudit`, which answers the plugin manager `clear` with every
 * finding shown, `needs-acceptance` for a known critical advisory, and `accepted` once the person accepts exactly that
 * set; and `deloPluginTrust`, which reads and refreshes the trust status. With the switch off it provides neither.
 * A loopback stand-in answers for the advisory feed and the registry.
 */
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PluginAuditResult, PluginOperationId } from '@deepseek-ai/dsh-plugin-manager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, blockingDigest, checkFailedResult, Config, inject, name, resolvedThroughMirror, resolveSettings, type PluginTrust } from '../src/index.ts'
import { readInstallRecord, recordPath } from '../src/record.ts'
import { advisory, INTEGRITY, OLD, removeProfile, startStandIn, writeProfile, writeProfileFiles, type StandIn } from './fixture.ts'

/** The error the next `checkPackage` throws, when set. */
const failure = vi.hoisted(() => ({ next: undefined as Error | undefined }))

vi.mock('../src/check.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/check.ts')>()
  return {
    ...actual,
    checkPackage: async (...args: Parameters<typeof actual.checkPackage>) => {
      const error = failure.next
      failure.next = undefined
      if (error !== undefined) throw error
      return actual.checkPackage(...args)
    },
  }
})

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
function audit(ctx: Context, accepted: string[] = [], pending?: 'install' | 'scripts'): Promise<PluginAuditResult> {
  return ctx.get('pluginAudit')!.audit({ name: 'good-plugin', version: '1.0.0', dir: `${dir}/node_modules/good-plugin`, accepted, ...pending === undefined ? {} : { pending } })
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

  it('needs acceptance when the check fails while the package is still to be installed, and accepts exactly that failure', async () => {
    const ctx = await mount(true)
    failure.next = new Error('the advisory parser broke')
    const refused = await audit(ctx, [], 'install')
    expect(refused).toMatchObject({ decision: 'needs-acceptance', findings: [{ rule: 'delo.check-failed', severity: 'critical', title: 'The install check could not run, so this package is not checked: the advisory parser broke', excerpt: 'good-plugin' }] })
    failure.next = new Error('another cause')
    expect(await audit(ctx, [refused.digest], 'install')).toMatchObject({ decision: 'needs-acceptance' })
    failure.next = new Error('the advisory parser broke')
    expect(await audit(ctx, [refused.digest], 'install')).toMatchObject({ decision: 'accepted', digest: refused.digest })
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
  })

  it('needs acceptance while the package is still to be built when the lockfile does not read', async () => {
    const ctx = await mount(true)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'5.4\'\n')
    expect(await audit(ctx, [], 'scripts')).toMatchObject({ decision: 'needs-acceptance', findings: [{ rule: 'delo.check-failed', severity: 'critical' }] })
    expect(await audit(ctx)).toMatchObject({ decision: 'clear', findings: [{ rule: 'delo.missing-integrity', title: expect.stringMatching(/^Nothing was checked/u) as string }] })
  })

  it('binds the digest of a failed check to the package, its lockfile reference and the cause', () => {
    const target = { name: 'good-plugin', dir, accepted: [], pending: 'install' as const }
    const digest = checkFailedResult(target, 'cause', '1.0.0 sha512-a').digest
    expect(checkFailedResult(target, 'cause', '1.0.1 sha512-b').digest).not.toBe(digest)
    expect(checkFailedResult({ ...target, name: 'other-plugin' }, 'cause', '1.0.0 sha512-a').digest).not.toBe(digest)
    expect(checkFailedResult(target, 'another cause', '1.0.0 sha512-a').digest).not.toBe(digest)
  })

  it('answers clear with a visible finding when the check fails for an installed package, never refusing it', async () => {
    const pluginDir = join(dir, 'node_modules', 'good-plugin')
    chmodSync(pluginDir, 0o000)
    try {
      const result = await audit(await mount(true))
      expect(result.decision).toBe('clear')
      expect(result.findings).toEqual([{ rule: 'delo.check-failed', title: expect.stringMatching(/^The install check could not run, so this package is not checked: EACCES/u) as string, severity: 'warning', path: '', line: 0, excerpt: 'good-plugin' }])
    } finally {
      chmodSync(pluginDir, 0o755)
    }
  })

  it('checks when the installation is only resolved, and records the files once it is installed and built', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'moderate', '*')] }
    const ctx = await mount(true)
    rmSync(join(dir, 'node_modules'), { recursive: true })
    const resolved = await audit(ctx, [], 'install')
    expect(resolved.findings.map(finding => finding.rule)).toEqual(['delo.advisory'])
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
    writeProfileFiles(dir, [{ name: 'good-plugin', version: '1.0.0', direct: true, files: { 'index.js': 'export default 1\n', 'built.js': 'export default "built"\n' } }])
    const requests = standIn.advisoryRequests.length
    expect(await audit(ctx)).toEqual(resolved)
    expect(standIn.advisoryRequests).toHaveLength(requests)
    expect(Object.keys((await readInstallRecord(dir, 'good-plugin'))?.packages[0]?.files ?? {})).toEqual(['built.js', 'index.js', 'package.json'])
  })

  it('checks another resolution afresh after a failed installation: its own findings and the comparison with its record', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'moderate', '1.0.0')] }
    const ctx = await mount(true)
    expect((await audit(ctx, [], 'install')).findings.map(finding => finding.excerpt)).toEqual(['good-plugin 1.0.0'])
    // The installation failed; another resolution is installed and recorded through a second Host, then edited.
    standIn.answers.times['good-plugin'] = { '1.0.1': OLD }
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-5555-6666-7777', 'moderate', '1.0.1')] }
    writeProfileFiles(dir, [{ name: 'good-plugin', version: '1.0.1', direct: true }])
    await audit(await mount(true))
    writeFileSync(join(dir, 'node_modules', 'good-plugin', 'index.js'), 'export default "edited"\n')
    const enabled = await audit(ctx)
    expect(enabled.findings.map(finding => finding.rule)).toEqual(['delo.advisory', 'delo.changed-files'])
    expect(enabled.findings[0]).toMatchObject({ excerpt: 'good-plugin 1.0.1', title: expect.stringContaining('GHSA-5555-6666-7777') as string })
  })

  it('checks the same resolution afresh once the operation that resolved it ended without installing it', async () => {
    const ctx = await mount(true)
    rmSync(join(dir, 'node_modules'), { recursive: true })
    await audit(ctx, [], 'install')
    await ctx.parallel('plugin-manager/operation', {
      id: 'operation-1' as PluginOperationId, time: new Date(0).toISOString(), reason: 'install', target: 'good-plugin', stage: 'install',
      phase: 'settled', application: 'failed', changed: false, errorCode: 'operation-error',
    })
    writeProfileFiles(dir, [{ name: 'good-plugin', version: '1.0.0', direct: true }])
    const requests = standIn.advisoryRequests.length
    await audit(ctx)
    expect(standIn.advisoryRequests).toHaveLength(requests + 1)
  })

  it('warns about a plain-http registry named for one installation, as for a configured one', async () => {
    const ctx = await mount(true)
    const result = await ctx.get('pluginAudit')!.audit({ name: 'good-plugin', dir: `${dir}/node_modules/good-plugin`, accepted: [], pending: 'install', registries: [null, 'http://registry.example.test/'] })
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: 'delo.insecure-source', title: expect.stringContaining('http://registry.example.test/') as string }))
  })

  it('refuses an installation a mirror resolved whose integrity the primary registry contradicts', async () => {
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': 'sha512-other' } }
    const ctx = await mount(true)
    const target = { name: 'good-plugin', dir: `${dir}/node_modules/good-plugin`, accepted: [], pending: 'install' as const, registries: [null, 'https://registry.npmmirror.com/'] }
    const refused = await ctx.get('pluginAudit')!.audit(target)
    expect(refused).toMatchObject({ decision: 'refused', findings: [{ rule: 'delo.integrity-mismatch', severity: 'critical' }] })
    expect(await ctx.get('pluginAudit')!.audit({ ...target, accepted: [refused.digest] })).toMatchObject({ decision: 'refused' })
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': INTEGRITY } }
    expect(await ctx.get('pluginAudit')!.audit(target)).toMatchObject({ decision: 'clear', findings: [] })
  })

  it('needs acceptance for an installation a mirror resolved while the primary registry cannot be reached', async () => {
    standIn.answers.times = {}
    const ctx = await mount(true)
    const target = { name: 'good-plugin', dir: `${dir}/node_modules/good-plugin`, accepted: [], pending: 'install' as const, registries: [null, 'https://registry.npmmirror.com/'] }
    const unconfirmed = await ctx.get('pluginAudit')!.audit(target)
    expect(unconfirmed).toMatchObject({ decision: 'needs-acceptance' })
    expect(unconfirmed.findings.map(finding => finding.rule)).toContain('delo.integrity-unconfirmed')
    expect(await ctx.get('pluginAudit')!.audit({ ...target, accepted: [unconfirmed.digest] })).toMatchObject({ decision: 'accepted' })
    // The primary registry resolved this one: an unreachable document stays a warning.
    expect(await ctx.get('pluginAudit')!.audit({ ...target, registries: [null] })).toMatchObject({ decision: 'clear' })
  })

  it('reads a mirror resolution from the registries asked and the manager\'s fallbacks', () => {
    expect(resolvedThroughMirror(undefined, [])).toBe(false)
    expect(resolvedThroughMirror([null], ['https://registry.npmmirror.com/'])).toBe(false)
    expect(resolvedThroughMirror(['https://registry.npmjs.org/'], ['https://registry.npmmirror.com/'])).toBe(false)
    expect(resolvedThroughMirror([null, 'https://registry.npmmirror.com/'], [])).toBe(true)
    expect(resolvedThroughMirror(['https://registry.npmmirror.com'], ['https://registry.npmmirror.com/'])).toBe(true)
  })

  it('refuses a critical advisory while the installation is only resolved, and accepts the same set when it is installed', async () => {
    standIn.answers.advisories = { 'good-plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const ctx = await mount(true)
    const refused = await audit(ctx, [], 'install')
    expect(refused.decision).toBe('needs-acceptance')
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
    expect(await audit(ctx, [refused.digest], 'install')).toMatchObject({ decision: 'accepted' })
    expect(await audit(ctx, [refused.digest])).toMatchObject({ decision: 'accepted', digest: refused.digest })
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(true)
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
