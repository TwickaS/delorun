/**
 * The denial tests contract C3 names for the report (`delorun/docs/contracts/c03-update-report.md#denial-tests`): a plugin
 * whose metadata Delorun cannot read is shown as unverified and `--yes` does not confirm it, an `engines.delorun` mismatch
 * names both target versions, a target whose signature failed produces no report at all, and updating the desktop Host
 * leaves the CLI home's version and state alone while both appear in the report.
 */
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { UpdateReportError, buildUpdateReport, confirmationNeeds, confirmsWithoutAsking, disabledPluginNames, readInstalledPlugin, reasonMessage, requirementText } from '../src/index.ts'
import { FROM, TO, exemptions, input, installed, profile, reasonOf, status, target, unreadable, version } from './support.ts'

/** A profile of one plugin whose `package.json` does not parse. */
const UNREADABLE = profile({ plugins: [unreadable('broken', '1.0.0')] })

describe('c03-unverified-metadata-shown', () => {
  it('shows a plugin whose package.json does not parse as manifest-unreadable and unverified', () => {
    const report = buildUpdateReport(input({ profile: UNREADABLE }))
    expect(report.items).toEqual([{ kind: 'plugin', subject: { name: 'broken', version: version('1.0.0') }, reason: 'manifest-unreadable', effect: 'kept', verification: 'unverified', detail: {}, actions: ['keep-disabled', 'skip-update'] }])
    expect(report.counts.unverified).toBe(1)
  })

  it('does not confirm the report with `--yes`', () => {
    const report = buildUpdateReport(input({ profile: UNREADABLE }))
    expect(confirmsWithoutAsking(report)).toBe(false)
    expect(reasonMessage(report.items[0]!, report)).toBe("Delorun could not read broken's package.json; it cannot predict what the update does to it.")
  })

  it('does not confirm a report whose only unverified item is a plugin that declares no requirement', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('legacy', '3.0.0')] }) }))
    expect(report.items.every(item => item.effect === 'kept')).toBe(true)
    expect(reasonOf(report, 'legacy')).toBe('requirement-undeclared')
    expect(confirmsWithoutAsking(report)).toBe(false)
  })
})

describe('c03-delorun-requirement-excludes-target', () => {
  it('names both target versions for a plugin whose engines.delorun excludes the target', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('bridge', '0.5.0', { dsh: '^0.3.0', delorun: '^0.10.0' })] }) }))
    expect(report.items).toMatchObject([{ kind: 'plugin', reason: 'delorun-requirement-unmet', effect: 'disabled', verification: 'verified', detail: { axis: 'delorun', requirement: '^0.10.0' }, actions: ['update-plugin', 'allow-version', 'keep-disabled'] }])
    expect(reasonMessage(report.items[0]!, report)).toBe('bridge requires Delorun ^0.10.0; the update installs Delorun 1.0.0.')
    expect(report.to.delorun).toBe(TO.delorun)
  })

  it('names both target versions for a DSH mismatch too', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('calendar', '2.0.0', { dsh: '^0.2.0' })] }) }))
    expect(reasonMessage(report.items[0]!, report)).toBe('calendar requires DSH ^0.2.0; Delorun 1.0.0 runs DSH 0.3.0.')
    expect(reasonOf(report, 'calendar')).toBe('dsh-requirement-unmet')
  })
})

describe('pin-delorun-axis-decides-alone', () => {
  it('keeps a plugin whose engines.delorun the target meets although its engines.dsh does not', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('bridge', '0.5.0', { dsh: '^0.2.0', delorun: '^1.0.0' })] }) }))
    expect(report.items).toEqual([])
    expect(disabledPluginNames(report)).toEqual([])
  })

  it('disables a plugin whose engines.delorun the target does not meet although its engines.dsh does, naming the Delorun axis only', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('bridge', '0.5.0', { dsh: '^0.3.0', delorun: '^0.10.0' })] }) }))
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ reason: 'delorun-requirement-unmet', effect: 'disabled', detail: { axis: 'delorun', requirement: '^0.10.0' } })
  })

  it('does not let a DSH exemption keep a plugin whose engines.delorun the target does not meet', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('bridge', '0.5.0', { dsh: '^0.2.0', delorun: '^0.10.0' })], exemptions: exemptions({ 'bridge@0.5.0': [TO.dsh] }) }) }))
    expect(report.items).toMatchObject([{ reason: 'delorun-requirement-unmet', effect: 'disabled' }])
  })

  it('decides a plugin without engines.delorun on its DSH range as before', () => {
    const report = buildUpdateReport(input({ profile: profile({ plugins: [installed('calendar', '2.0.0', { dsh: '^0.2.0' })] }) }))
    expect(reasonOf(report, 'calendar')).toBe('dsh-requirement-unmet')
  })
})

describe('c03-peer-requirement-excludes-target', () => {
  it('disables a plugin that states its DSH range only through peers, with the requirement upstream\'s preflight reports', () => {
    const manifest = { name: 'peers-only', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0', '@deepseek-ai/dsh-tools': 'workspace:*' } }
    const report = buildUpdateReport(input({ profile: profile({ plugins: [readInstalledPlugin('peers-only', version('1.0.0'), JSON.stringify(manifest))] }) }))
    const preflight = evaluatePluginCompatibility(manifest, {}, TO.dsh, undefined)
    expect(preflight?.requirements).toEqual({ '@deepseek-ai/dsh-agent': '^0.2.0' })
    expect(report.items).toMatchObject([{ kind: 'plugin', reason: 'dsh-requirement-unmet', effect: 'disabled', verification: 'verified', detail: { axis: 'dsh', requirement: requirementText(preflight!.requirements) } }])
    expect(reasonMessage(report.items[0]!, report)).toBe('peers-only requires DSH ^0.2.0 (peer @deepseek-ai/dsh-agent); Delorun 1.0.0 runs DSH 0.3.0.')
    expect(disabledPluginNames(report)).toEqual(['peers-only'])
    expect(confirmsWithoutAsking(report)).toBe(false)
  })
})

describe('c03-no-report-for-unverified-target', () => {
  it('produces no report for a target whose manifest signature failed', () => {
    const failed = target({ release: { ...target().release, signature: 'failed' } })
    expect(() => buildUpdateReport(input({ target: failed }))).toThrow(UpdateReportError)
    try {
      buildUpdateReport(input({ target: failed }))
      expect.unreachable('a target that failed its signature check has no report')
    } catch (error) {
      expect(error).toBeInstanceOf(UpdateReportError)
      expect((error as UpdateReportError).code).toBe('REPORT_TARGET_UNVERIFIED')
      expect((error as UpdateReportError).detail).toBe("the target's signature check did not pass; no report is made for it")
    }
  })

  it('names a refusal by its code alone when it carries no detail', () => {
    expect(new UpdateReportError('REPORT_DISPOSED').message).toBe('REPORT_DISPOSED')
  })

  it('produces no report for a stale timestamp or a failed log check either', () => {
    for (const check of ['freshness', 'log'] as const) {
      const failed = target({ release: { ...target().release, [check]: 'failed' } })
      expect(() => buildUpdateReport(input({ target: failed }))).toThrow(`the target's ${check} check did not pass`)
    }
  })

  it('reports a log check that did not complete as unchecked, and --yes does not confirm it', () => {
    const report = buildUpdateReport(input({ target: target({ release: { ...target().release, log: 'unchecked' } }) }))
    expect(report.release.log).toBe('unchecked')
    // Without items, only the log state decides whether --yes confirms.
    expect(confirmsWithoutAsking({ ...report, items: [] })).toBe(false)
    expect(confirmsWithoutAsking({ ...report, items: [], release: { ...report.release, log: 'passed' } })).toBe(true)
  })

  it('reports a freshness the channel could not confirm as unchecked, and --yes does not confirm it', () => {
    const report = buildUpdateReport(input({ target: target({ release: { ...target().release, freshness: 'unchecked' } }) }))
    expect(report.release.freshness).toBe('unchecked')
    // Pins the gate: a reader that checks `=== 'passed'` and this one both treat the value as not passed.
    expect(confirmsWithoutAsking({ ...report, items: [] })).toBe(false)
    expect(confirmationNeeds({ ...report, items: [] })).toEqual({ items: [], log: false, freshness: true })
    expect(confirmsWithoutAsking({ ...report, items: [], release: { ...report.release, freshness: 'passed' } })).toBe(true)
  })

  it('builds the report once every check passed', () => {
    expect(buildUpdateReport(input()).release.signature).toBe('passed')
  })
})

describe('c03-desktop-update-leaves-cli', () => {
  /** Both records, each with its own versions and state. */
  const statuses = {
    'cli-home': status('cli-home', '0.9.0', '0.2.2', 'current'),
    'desktop-host': status('desktop-host', '0.9.0', '0.2.2', 'available', '1.0.0'),
  }

  it('shows both installations when the desktop Host updates, with the CLI home unchanged', () => {
    const report = buildUpdateReport(input({ installation: 'desktop-host', statuses }))
    expect(report.installation).toBe('desktop-host')
    expect(report.installations).toEqual([statuses['cli-home'], statuses['desktop-host']])
    expect(report.installations[0]).toMatchObject({ id: 'cli-home', delorun: FROM.delorun, dsh: FROM.dsh, state: 'current' })
    expect(report.installations[0]?.target).toBeUndefined()
  })

  it('leaves the records it was handed as they were', () => {
    const before = JSON.stringify(statuses)
    buildUpdateReport(input({ installation: 'desktop-host', statuses }))
    expect(JSON.stringify(statuses)).toBe(before)
  })

  it('shows the CLI home as unknown, and never as the desktop Host, when its record is absent', () => {
    const report = buildUpdateReport(input({ installation: 'desktop-host', statuses: { 'desktop-host': statuses['desktop-host'] } }))
    expect(report.installations[0]).toEqual({ id: 'cli-home', state: 'unknown' })
  })
})
