/**
 * The sentence each reason states, in the words C3's reason table gives it. The report is read by a person before they
 * confirm an update, so the words are asserted here rather than left to a screen.
 */
import { describe, expect, it } from 'vitest'
import type { ReportItem } from '@delo/contract-update-report'
import { UNVERIFIED_NOTE, buildUpdateReport, exemptionNote, reasonMessage, uncheckedMessage } from '../src/index.ts'
import { input, installed, profile, version } from './support.ts'

/**
 * The report a sentence is rendered against.
 * @returns the report over a plugin the update disables and one it cannot read.
 */
const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('calendar', '2.0.0', { dsh: '^0.2.0' })] }) }))

/**
 * A one-plugin report's only item.
 * @param name - the plugin.
 * @param at - its installed version.
 * @param engines - what its manifest declares.
 * @returns the item.
 */
function only(name: string, at: string, engines: Readonly<Record<string, unknown>> | undefined): ReportItem {
  const built = buildUpdateReport(input({ profile: profile({ plugins: [installed(name, at, engines)] }) }))
  const [item] = built.items
  if (item === undefined) throw new Error(`${name} produced no item`)
  return item
}

describe('reasonMessage', () => {
  it('states a DSH mismatch with both target versions', () => {
    expect(reasonMessage(report.items[0]!, report)).toBe('calendar requires DSH ^0.2.0; Delorun 1.0.0 runs DSH 0.3.0.')
  })

  it('states an unreadable declaration with the axis it names', () => {
    expect(reasonMessage(only('weird', '1.0.0', { dsh: 42 }), report)).toBe('weird declares engines.dsh in a form Delorun cannot read.')
  })

  it('states the exemption that covers the target', () => {
    const exempt = buildUpdateReport(input({ profile: profile({ plugins: [installed('pinned', '1.0.0', { dsh: '^0.2.0' })], exemptions: { dsh: { 'pinned@1.0.0': [version('0.3.0')] }, delo: {} } }) }))
    expect(reasonMessage(exempt.items[0]!, exempt)).toBe('pinned requires DSH ^0.2.0; your exemption for this exact version covers 0.3.0.')
  })

  it('states an exemption that does not follow the plugin to the target', () => {
    const stale = buildUpdateReport(input({ profile: profile({ plugins: [installed('pinned', '1.0.0', { dsh: '^0.2.0' })], exemptions: { dsh: { 'pinned@1.0.0': [version('0.2.2')] }, delo: {} } }) }))
    expect(reasonMessage(stale.items[0]!, stale)).toBe('pinned runs today under your exemption for 0.2.2; the exemption does not cover 0.3.0.')
  })

  it('states that nothing is declared', () => {
    expect(reasonMessage(only('legacy', '3.0.0', undefined), report)).toBe('legacy declares no DSH requirement, so its compatibility with DSH 0.3.0 is not stated.')
  })

  it('states a revocation with its reason and message', () => {
    expect(reasonMessage(only('revoked-plugin', '0.4.0', { dsh: '^0.3.0' }), report)).toBe('revoked-plugin is revoked: malicious, exfiltrates tokens from the workspace.')
  })

  it('states an unreadable manifest', () => {
    const built = buildUpdateReport(input({ profile: profile({ plugins: [{ name: 'broken', version: version('1.0.0') }] }) }))
    expect(reasonMessage(built.items[0]!, built)).toBe("Delorun could not read broken's package.json; it cannot predict what the update does to it.")
  })

  it('states a retired bundle, a normalised list and a skipped bundle', () => {
    const retired = buildUpdateReport(input({ profile: profile({ bundles: ['dsh-old'] }), target: { ...input().target, bundles: { retired: ['dsh-old'], skipped: [], layers: [] } } }))
    expect(reasonMessage(retired.items[0]!, retired)).toBe('dsh-old is retired in DSH 0.3.0 and leaves the bundle list.')
    const normalised = buildUpdateReport(input({ profile: profile({ bundles: ['dsh-old'] }), target: { ...input().target, bundles: { retired: [], skipped: [], layers: [], template: ['dsh-base'] } } }))
    expect(reasonMessage(normalised.items[0]!, normalised)).toBe('The bundle list matches an installation-owned list that DSH 0.3.0 replaces with its template.')
    const skipped = buildUpdateReport(input({ profile: profile({ bundles: ['dsh-broken'] }), target: { ...input().target, bundles: { retired: [], skipped: [{ package: 'dsh-broken', reason: 'missing dependency', verification: 'verified' }], layers: [] } } }))
    expect(reasonMessage(skipped.items[0]!, skipped)).toBe('dsh-broken cannot load on the target: missing dependency.')
  })

  it('states a disabled row and a blocked Include', () => {
    const rows = buildUpdateReport(input({
      profile: profile({ plugins: [installed('calendar', '2.0.0', { dsh: '^0.2.0' })], layers: [{ layer: 'dsh-base', rows: [{ id: 'core', name: 'dsh-core', plugins: ['calendar'] }, { name: 'include', include: { file: 'x.yml', rows: [{ name: 'row', plugins: ['calendar'] }] } }] }] }),
      target: { ...input().target, bundles: { retired: [], skipped: [], layers: [] }, revocations: [] },
    }))
    const messages = rows.items.filter(item => item.kind === 'row').map(item => reasonMessage(item, rows))
    expect(messages).toEqual(['Row core in dsh-base loads calendar, which the update disables.', 'Include x.yml reaches calendar, which the update disables, so the whole Include is disabled.'])
  })

  it('reaches the plugin an Include loads through another Include', () => {
    const nested = buildUpdateReport(input({
      profile: profile({
        plugins: [installed('calendar', '2.0.0', { dsh: '^0.2.0' })],
        layers: [{ layer: 'dsh-base', rows: [{ name: 'outer', include: { file: 'outer.yml', rows: [{ name: 'inner', include: { file: 'inner.yml', rows: [{ name: 'leaf', plugins: ['calendar'] }] } }] } }] }],
      }),
      target: { ...input().target, bundles: { retired: [], skipped: [], layers: [] }, revocations: [] },
    }))
    expect(nested.items.filter(item => item.kind === 'row').map(item => reasonMessage(item, nested))).toEqual(['Include outer.yml reaches calendar, which the update disables, so the whole Include is disabled.'])
  })

  it('states a Delo-axis exemption and one that does not follow the plugin, with Delo\'s versions', () => {
    const plugins = [installed('pinned', '1.0.0', { dsh: '^0.3.0', delo: '^0.9.0' })]
    const exempt = buildUpdateReport(input({ profile: profile({ plugins, exemptions: { dsh: {}, delo: { 'pinned@1.0.0': [version('1.0.0')] } } }) }))
    const stale = buildUpdateReport(input({ profile: profile({ plugins, exemptions: { dsh: {}, delo: { 'pinned@1.0.0': [exempt.from.delo] } } }) }))
    expect(reasonMessage(exempt.items[0]!, exempt)).toBe('pinned requires Delorun ^0.9.0; your exemption for this exact version covers 1.0.0.')
    expect(reasonMessage(stale.items[0]!, stale)).toBe(`pinned runs today under your exemption for ${exempt.from.delo}; the exemption does not cover 1.0.0.`)
  })

  it('leaves a fact out of the sentence when the item\'s detail does not carry it', () => {
    const plugin = (reason: ReportItem['reason']): ReportItem => ({ kind: 'plugin', subject: { name: 'bare', version: version('1.0.0') }, reason, effect: 'disabled', verification: 'verified', detail: {}, actions: [] })
    expect(['dsh-requirement-unmet', 'delo-requirement-unmet', 'requirement-unreadable', 'requirement-exempted', 'exemption-not-carried', 'plugin-revoked'].map(reason => reasonMessage(plugin(reason as ReportItem['reason']), report))).toEqual([
      'bare requires DSH ; Delorun 1.0.0 runs DSH 0.3.0.',
      'bare requires Delorun ; the update installs Delorun 1.0.0.',
      'bare declares engines. in a form Delorun cannot read.',
      'bare requires DSH ; your exemption for this exact version covers 0.3.0.',
      `bare runs today under your exemption for ${report.from.dsh}; the exemption does not cover 0.3.0.`,
      'bare is revoked: , .',
    ])
    expect(reasonMessage({ kind: 'bundle', subject: { package: 'dsh-x' }, reason: 'bundle-skipped', effect: 'disabled', verification: 'verified', detail: {}, actions: [] }, report)).toBe('dsh-x cannot load on the target: .')
    expect(reasonMessage({ kind: 'row', subject: { name: 'row-a', layer: 'home patch' }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: {}, actions: [] }, report)).toBe('Row row-a in home patch loads , which the update disables.')
  })

  it('names only the subject of an item whose reason belongs to another kind', () => {
    expect(reasonMessage({ kind: 'plugin', subject: { name: 'odd', version: version('1.0.0') }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: {}, actions: [] }, report)).toBe('odd')
    expect(reasonMessage({ kind: 'bundle', subject: { package: 'dsh-odd' }, reason: 'row-disabled', effect: 'disabled', verification: 'verified', detail: {}, actions: [] }, report)).toBe('dsh-odd')
  })

  it('carries the sentence a report shows beside an unverified item', () => {
    expect(UNVERIFIED_NOTE).toBe('Delorun cannot predict this item.')
  })

  it('states that the release publishes no revocation list when the report did not read one', () => {
    expect(uncheckedMessage('revocations')).toBe('revocations. This release publishes no revocation list; the health check after the switch holds what one would show.')
  })
})

describe('exemptionNote', () => {
  it('tells how to try a plugin the DSH range excludes, and that the health check rolls a failed try back', () => {
    expect(exemptionNote(report.items[0]!, report)).toBe('To try it anyway before you update, run: delorun plugin allow-version calendar@2.0.0 --dsh-version 0.3.0 --accept-risk. If the plugin then fails to load, the health check after the switch rolls the update back.')
  })

  it('stays silent for a plugin the Delorun range excludes, which has no exemption, and for a bundle', () => {
    expect(exemptionNote(only('bridge', '1.0.0', { delo: '^0.10.0' }), report)).toBeUndefined()
    expect(exemptionNote({ kind: 'bundle', subject: { package: 'dsh-x' }, reason: 'bundle-skipped', effect: 'disabled', verification: 'verified', detail: {}, actions: [] }, report)).toBeUndefined()
  })
})
