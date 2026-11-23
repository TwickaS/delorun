/**
 * The report's own shape: its schema and versions, both installations shown, its items sorted by kind and then
 * subject, its counts, and the bundle and row items the target's own tables and the profile's layers make.
 */
import { describe, expect, it } from 'vitest'
import { INSTALLATIONS, UPDATE_REPORT_SCHEMA } from '@delorun/contract-update-report'
import type { ReportItem } from '@delorun/contract-update-report'
import { buildUpdateReport, bundleItems, bundleRowItems, countItems, disabledPluginNames, predictBundleList, rowItems, sortItems, versionOf } from '../src/index.ts'
import { BUNDLE_FACTS, FROM, GENERATED, PROFILE, STATUSES, TO, input, installed, profile, release, target, version } from './support.ts'

/**
 * The plugin items' subjects, in report order.
 * @param report - the report.
 * @returns the plugin names.
 */
function pluginNames(report: ReturnType<typeof buildUpdateReport>): string[] {
  return report.items.flatMap(item => item.kind === 'plugin' ? [item.subject.name] : [])
}

describe('buildUpdateReport', () => {
  it('names the format, the installation, both releases and the checks the target passed', () => {
    const report = buildUpdateReport(input())
    expect(report.schema).toBe('delorun.update-report/3')
    expect(report.schema).toBe(UPDATE_REPORT_SCHEMA)
    expect(report.installation).toBe('cli-home')
    expect(report.from).toEqual(FROM)
    expect(report.to).toEqual(TO)
    expect(report.release).toEqual({ manifest: expect.any(String), signature: 'passed', freshness: 'passed', log: 'passed' })
    expect(report.generated).toBe(GENERATED)
  })

  it('shows both installations in display order, with an absent record as unknown', () => {
    expect(buildUpdateReport(input()).installations).toEqual([STATUSES['cli-home'], STATUSES['desktop-host']])
    const one = buildUpdateReport(input({ statuses: { 'cli-home': STATUSES['cli-home'] } }))
    expect(one.installations).toEqual([STATUSES['cli-home'], { id: 'desktop-host', state: 'unknown' }])
    expect(INSTALLATIONS).toEqual(['cli-home', 'desktop-host'])
  })

  it('sorts items by kind and then by subject', () => {
    const report = buildUpdateReport(input())
    const subjects = report.items.map(item => `${item.kind}:${item.kind === 'plugin' ? item.subject.name : item.kind === 'bundle' ? item.subject.package : item.kind === 'row' ? item.subject.name : item.kind === 'data' ? item.subject.directories.join(',') : item.subject.file}`)
    expect(subjects).toEqual([...subjects].sort((left, right) => {
      const rank = (text: string): number => text.startsWith('plugin:') ? 0 : text.startsWith('bundle:') ? 1 : 2
      const byKind = rank(left) - rank(right)
      return byKind !== 0 ? byKind : left.slice(left.indexOf(':') + 1).localeCompare(right.slice(right.indexOf(':') + 1), 'en')
    }))
    expect(pluginNames(report)).toEqual(['bridge', 'broken', 'calendar', 'exempt-plugin', 'legacy', 'legacy-x', 'old-exempt', 'revoked-plugin', 'weird'])
  })

  it('counts every effect and the unverified items beside them', () => {
    expect(buildUpdateReport(input()).counts).toEqual({ disabled: 9, removed: 1, changed: 0, unverified: 3, data: 0, harness: 0 })
    expect(countItems([])).toEqual({ disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: 0 })
  })

  it('names the plugins the update disables, which the health check holds the target to', () => {
    expect(disabledPluginNames(buildUpdateReport(input()))).toEqual(['bridge', 'calendar', 'legacy-x', 'old-exempt', 'revoked-plugin', 'weird'])
  })

  it('names a plugin the target revokes without also offering an exemption for it', () => {
    const report = buildUpdateReport(input())
    const revoked = report.items.find(item => item.kind === 'plugin' && item.subject.name === 'revoked-plugin')
    expect(revoked).toMatchObject({ reason: 'plugin-revoked', effect: 'disabled', verification: 'verified', detail: { revocation: { reason: 'malicious', message: 'exfiltrates tokens from the workspace' } }, actions: ['update-plugin', 'keep-disabled'] })
    expect(pluginNames(report).filter(name => name === 'revoked-plugin')).toHaveLength(1)
  })

  it('keeps an unreadable manifest and never counts it as safe', () => {
    const broken = buildUpdateReport(input()).items.find(item => item.kind === 'plugin' && item.subject.name === 'broken')
    expect(broken).toMatchObject({ reason: 'manifest-unreadable', effect: 'kept', verification: 'unverified', detail: {} })
  })

  it('leaves a compatible plugin out of the items and out of the counts', () => {
    const report = buildUpdateReport(input())
    expect(pluginNames(report)).not.toContain('dsh-tools')
    // `notes` declares only engines.delorun, which the target meets and which decides alone (A567), so its compatibility is stated.
    expect(pluginNames(report)).not.toContain('notes')
  })

  it('is empty when nothing changes', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('dsh-tools', '1.4.0', { dsh: '^0.3.0' })] }), target: target() }))
    expect(report.items).toEqual([])
    expect(report.counts).toEqual({ disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0, harness: 0 })
  })

  it('does not change the facts it was handed', () => {
    const overrides = input()
    const before = JSON.stringify(overrides)
    buildUpdateReport(overrides)
    expect(JSON.stringify(overrides)).toBe(before)
  })
})

describe('the bundle list', () => {
  it('removes a retired bundle and names it', () => {
    expect(predictBundleList(PROFILE.bundles, BUNDLE_FACTS)).toEqual(['dsh-base', 'dsh-tools-bundle'])
    expect(bundleItems(PROFILE.bundles, BUNDLE_FACTS)).toMatchObject([
      { reason: 'bundle-retired', effect: 'removed', subject: { package: 'dsh-retired-thing' } },
      { reason: 'bundle-skipped', effect: 'disabled', subject: { package: 'dsh-tools-bundle' }, detail: { failure: 'engines.dsh does not match' } },
    ])
  })

  it('replaces an installation-owned list with the target template, naming what leaves and what arrives', () => {
    const facts = { retired: [], skipped: [], layers: [], runningLayers: [], template: ['dsh-base', 'dsh-template-new'] }
    expect(predictBundleList(PROFILE.bundles, facts)).toEqual(['dsh-base', 'dsh-template-new'])
    expect(bundleItems(PROFILE.bundles, facts)).toMatchObject([
      { reason: 'bundle-template-normalised', effect: 'changed', subject: { package: 'dsh-retired-thing' } },
      { reason: 'bundle-template-normalised', effect: 'changed', subject: { package: 'dsh-tools-bundle' } },
      { reason: 'bundle-template-normalised', effect: 'changed', subject: { package: 'dsh-template-new' } },
    ])
  })

  it('marks a skip that rests on metadata Delorun could not read as unverified', () => {
    const facts = { retired: [], skipped: [{ package: 'dsh-tools-bundle', reason: 'Delorun could not read its package.json', verification: 'unverified' as const }], layers: [], runningLayers: [] }
    expect(bundleItems(['dsh-tools-bundle'], facts)).toEqual([
      { kind: 'bundle', subject: { package: 'dsh-tools-bundle' }, reason: 'bundle-skipped', effect: 'disabled', verification: 'unverified', detail: { failure: 'Delorun could not read its package.json' }, actions: ['keep-disabled', 'skip-update'] },
    ])
  })

  it('names a bundle the template adds as skipped when the target cannot load it', () => {
    const facts = { retired: [], skipped: [{ package: 'dsh-template-new', reason: 'its package.json declares no dsh.bundle', verification: 'verified' as const }], layers: [], runningLayers: [], template: ['dsh-base', 'dsh-template-new'] }
    expect(bundleItems(['dsh-base'], facts)).toMatchObject([
      { reason: 'bundle-skipped', effect: 'disabled', verification: 'verified', subject: { package: 'dsh-template-new' }, detail: { failure: 'its package.json declares no dsh.bundle' } },
    ])
  })

  it('names nothing for a bundle the target skips and the profile does not list', () => {
    expect(bundleItems(['dsh-base'], { retired: [], skipped: [{ package: 'dsh-absent', reason: 'missing dependency', verification: 'verified' }], layers: [], runningLayers: [] })).toEqual([])
  })
})

describe('rows a bundle patch disables', () => {
  const layer = (name: string, disabledRows: readonly string[]): { layer: string, rows: [], disabledRows: readonly string[] } => ({ layer: name, rows: [], disabledRows })
  const bundles = (layers: ReturnType<typeof layer>[], runningLayers: ReturnType<typeof layer>[]) => ({ retired: [], skipped: [], layers, runningLayers })

  it('names a row the target\'s bundle patch disables and the running release\'s did not', () => {
    const report = buildUpdateReport(input({ target: target({ bundles: bundles([layer('@delorun/bundle-local', ['deepseek-account', 'llm-deepseek-account'])], [layer('@delorun/bundle-local', ['deepseek-account'])]) }) }))
    expect(report.items.filter(item => item.detail.bundlePatch === true)).toEqual([
      { kind: 'row', subject: { id: 'llm-deepseek-account', name: 'llm-deepseek-account', layer: '@delorun/bundle-local' }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: { bundlePatch: true, plugin: { name: 'llm-deepseek-account', version: TO.delorun } }, actions: [] },
    ])
    expect(report.counts.disabled).toBeGreaterThanOrEqual(1)
  })

  it('names nothing for a row both releases disable or one the target stops disabling', () => {
    const report = buildUpdateReport(input({ target: target({ bundles: bundles([layer('b', ['kept'])], [layer('b', ['kept', 'dropped'])]) }) }))
    expect(report.items.filter(item => item.detail.bundlePatch === true)).toEqual([])
  })

  it('carries the row\'s plugin name where releases before rc.4 read it, so their sentence has a plugin', () => {
    const rows = [{ id: 'row-x', name: 'plugin-x-row', plugins: ['dsh-x'] }]
    const [item] = bundleRowItems([{ layer: 'a', rows, disabledRows: ['row-x'] }], [], version('1.0.0'))
    expect(item?.detail.plugin).toEqual({ name: 'dsh-x', version: version('1.0.0') })
  })

  it('names a row once when two layers disable it', () => {
    expect(bundleRowItems([layer('a', ['x']), layer('b', ['x'])], [], version('1.0.0'))).toHaveLength(1)
  })
})

describe('the profile rows', () => {
  it('disables a row that loads a plugin the update disables, and names the plugin', () => {
    const report = buildUpdateReport(input())
    expect(report.items).toContainEqual({ kind: 'row', subject: { id: 'core', name: 'dsh-core', layer: 'dsh-base' }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: { plugin: { name: 'calendar', version: version('2.0.0') } }, actions: [] })
  })

  it('leaves a row that loads a plugin the update keeps', () => {
    const report = buildUpdateReport(input())
    expect(report.items.some(item => item.kind === 'row' && item.subject.name === 'cordis-plugin-notes')).toBe(false)
  })

  it('disables a whole Include that reaches a plugin the update disables', () => {
    const report = buildUpdateReport(input())
    expect(report.items).toContainEqual({ kind: 'row', subject: { name: 'legacy.yml', layer: 'profile patch' }, reason: 'row-include-blocked', effect: 'disabled', verification: 'verified', detail: { plugin: { name: 'legacy-x', version: version('1.0.0') } }, actions: [] })
  })

  it('carries a plugin unreadable metadata marked as unverified into the row it loads', () => {
    const unreadable = buildUpdateReport(input({ profile: profile({ plugins: [installed('bad', '1.0.0', { dsh: 1 })], layers: [{ layer: 'home patch', rows: [{ name: 'cordis-plugin-bad', plugins: ['bad'] }] }] }), target: target() }))
    expect(unreadable.items).toContainEqual({ kind: 'row', subject: { name: 'cordis-plugin-bad', layer: 'home patch' }, reason: 'row-disabled', effect: 'disabled', verification: 'unverified', detail: { plugin: { name: 'bad', version: version('1.0.0') } }, actions: [] })
  })

  it('disables a row of a bundle layer the target loads, as it does a row of the person\'s layers', () => {
    const bundles = { retired: [], skipped: [], runningLayers: [], layers: [{ layer: 'dsh-own-bundle', rows: [{ id: 'own', name: 'dsh-own', plugins: ['calendar'] }] }] }
    const report = buildUpdateReport(input({
      profile: profile({ plugins: [installed('calendar', '2.0.0', { dsh: '^0.1.0' })], layers: [{ layer: 'profile patch', rows: [{ name: 'calendar', plugins: ['calendar'] }] }] }),
      target: target({ bundles }),
    }))
    expect(report.items.flatMap(item => item.kind === 'row' ? [item.subject.layer] : [])).toEqual(['profile patch', 'dsh-own-bundle'])
    expect(report.items).toContainEqual({ kind: 'row', subject: { id: 'own', name: 'dsh-own', layer: 'dsh-own-bundle' }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: { plugin: { name: 'calendar', version: version('2.0.0') } }, actions: [] })
  })

  it('names no Include whose rows reach no disabled plugin, and no row that loads no plugin package', () => {
    const disabled = new Map([['calendar', { subject: { name: 'calendar', version: version('2.0.0') }, verification: 'verified' as const }]])
    expect(rowItems([{ layer: 'profile patch', rows: [{ name: 'include', include: { file: 'quiet.yml', rows: [{ name: 'row', plugins: ['notes'] }] } }, { name: 'file:///plugin.js' }] }], disabled)).toEqual([])
  })

  it('reports nothing for a row whose plugin the update leaves alone', () => {
    const quiet = buildUpdateReport(input({ profile: profile({ plugins: [installed('fine', '1.0.0', { dsh: '^0.3.0' })], layers: [{ layer: 'dsh-base', rows: [{ name: 'row', plugins: ['fine'] }] }] }), target: target({ versions: release('1.0.0', '0.3.0') }) }))
    expect(quiet.items).toEqual([])
  })
})

describe('sortItems', () => {
  it('orders two items of one subject by their reason', () => {
    const data = (reason: ReportItem['reason']): ReportItem => ({ kind: 'data', subject: { directories: ['sessions', 'storages'] }, reason, effect: 'changed', verification: 'verified', detail: {}, actions: [] })
    expect(sortItems([data('data-format-unknown'), data('data-format-changed')]).map(item => item.reason)).toEqual(['data-format-changed', 'data-format-unknown'])
  })
})

describe('versionOf', () => {
  it('reads each axis\'s version of a release', () => {
    expect([versionOf(TO, 'dsh'), versionOf(TO, 'delorun')]).toEqual([TO.dsh, TO.delorun])
  })
})
