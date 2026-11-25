import { describe, expect, it } from 'vitest'
import { compareRegions, type RegionSignature } from '../../src/compat-bench/clashes.ts'
import { COST_THRESHOLDS, costFindings, type CostSample } from '../../src/compat-bench/cost.ts'

const base: RegionSignature = {
  sidebar: ['Chats', 'Workspaces', 'Plugins'],
  theme: { '--bg': '#fff', '--fg': '#111', '--accent': '#09f' },
  settings: [{ group: 'General', items: ['Appearance', 'Language'] }, { group: 'Other', items: ['About'] }],
}

describe('the region comparison', () => {
  it('finds nothing when the plugin only adds its own entries', () => {
    const withPlugin: RegionSignature = { ...base, sidebar: [...base.sidebar, 'Pet'], settings: [{ group: 'General', items: ['Appearance', 'Language'] }, { group: 'Plugins', items: ['Pet'] }, { group: 'Other', items: ['About'] }] }
    expect(compareRegions(base, withPlugin)).toEqual([])
  })

  it('reports removed, reordered and restyled parts of Delorun\'s own regions', () => {
    const clashes = compareRegions(base, { sidebar: ['Workspaces', 'Chats'], theme: { ...base.theme, '--accent': '#f00' }, settings: [{ group: 'General', items: ['Language', 'Appearance'] }] })
    expect(clashes.map(clash => `${clash.region}: ${clash.detail}`)).toEqual([
      'sidebar: entries gone with the plugin: Plugins',
      'theme: theme tokens with another value: --accent',
      'settings: the entries of "General" changed order',
      'settings: the group "Other" is gone',
    ])
  })

  it('reports reordering when nothing was removed', () => {
    expect(compareRegions(base, { ...base, sidebar: ['Plugins', 'Chats', 'Workspaces'] })).toEqual([{ region: 'sidebar', detail: 'the entries changed order' }])
  })

  it('reports the plugin\'s Settings section under Other', () => {
    const withPlugin: RegionSignature = { ...base, settings: [{ group: 'General', items: ['Appearance', 'Language'] }, { group: 'Other', items: ['About', 'Pet'] }] }
    expect(compareRegions(base, withPlugin)).toEqual([{ region: 'settings', detail: 'the plugin\'s Settings section is under "Other": Pet' }])
  })
})

const sample = (startMs: number, rssMiB: number, consoleErrors = 0): CostSample => ({ startMs, rssBytes: rssMiB * 1048576, consoleErrors })

describe('the cost rule', () => {
  const without = [sample(8000, 600), sample(9500, 610), sample(8700, 590)]

  it('reports nothing for a difference inside the machine\'s noise', () => {
    const findings = costFindings([sample(9000, 620), sample(12000, 640), sample(10000, 630)], without)
    expect(findings.every(finding => !finding.reported)).toBe(true)
  })

  it('does not report a big difference that does not repeat', () => {
    const findings = costFindings([sample(30000, 900), sample(9000, 620), sample(10000, 630)], without)
    expect(findings.find(finding => finding.metric === 'start')?.reported).toBe(false)
    expect(findings.find(finding => finding.metric === 'memory')?.reported).toBe(false)
  })

  it('reports a large difference that repeats in every run', () => {
    const findings = costFindings([sample(20000, 900, 3), sample(22000, 950, 2), sample(21000, 910, 4)], without)
    expect(findings.map(finding => finding.reported)).toEqual([true, true, true])
    expect(findings[0]?.detail).toContain('20000 ms at best')
  })

  it('needs both the ratio and the floor, and three runs each way', () => {
    const small = [sample(100, 100), sample(110, 100), sample(120, 100)]
    const tiny = [sample(300, 150), sample(310, 150), sample(320, 150)]
    expect(costFindings(tiny, small).some(finding => finding.reported)).toBe(false)
    expect(COST_THRESHOLDS.startFloorMs).toBeGreaterThan(0)
    expect(() => costFindings([sample(1, 1)], without)).toThrow('3 runs each way')
  })
})
