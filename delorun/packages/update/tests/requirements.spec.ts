/**
 * The two version axes: what a declared range decides against the target, when an exemption admits the target, and when
 * the exemption that lets a plugin run today does not follow it to the next release (contract C17's two axes and its
 * exemption files).
 */
import { describe, expect, it } from 'vitest'
import { evaluatePluginAxes, exempted, exemptionKey, requirementText, satisfiesRange } from '../src/index.ts'
import { version } from './support.ts'

/** The versions the default spec checks against: DSH 0.2.2 to 0.3.0, Delorun 0.9.0 to 1.0.0. */
const AXES = { dsh: { from: version('0.2.2'), to: version('0.3.0') }, delorun: { from: version('0.9.0'), to: version('1.0.0') } } as const

describe('satisfiesRange', () => {
  it('treats an empty, workspace or invalid range as unmet, as upstream does', () => {
    for (const range of ['', '  ', 'workspace:*', 'not a range']) expect(satisfiesRange(version('0.3.0'), range)).toBe(false)
  })

  it('lets prereleases take part, as upstream does', () => {
    // Without `includePrerelease` a prerelease inside the range is admitted only by a comparator that names one.
    expect(satisfiesRange(version('0.2.5-rc.1'), '^0.2.0')).toBe(true)
    expect(satisfiesRange(version('0.3.0'), '^0.3.0')).toBe(true)
    // A prerelease below the range's own floor is still outside it.
    expect(satisfiesRange(version('0.3.0-rc.1'), '^0.3.0')).toBe(false)
    expect(satisfiesRange(version('0.4.0'), '^0.3.0')).toBe(false)
  })
})

describe('exemptions', () => {
  it('keys an exemption by the exact plugin version', () => {
    expect(exemptionKey('plugin', version('1.2.3'))).toBe('plugin@1.2.3')
  })

  it('admits one exact version of the axis, never a range', () => {
    const record = { 'plugin@1.2.3': [version('0.3.0')] }
    expect(exempted(record, 'plugin@1.2.3', version('0.3.0'))).toBe(true)
    expect(exempted(record, 'plugin@1.2.3', version('0.3.1'))).toBe(false)
    expect(exempted(record, 'plugin@1.2.4', version('0.3.0'))).toBe(false)
    expect(exempted({}, 'plugin@1.2.3', version('0.3.0'))).toBe(false)
  })
})

/** No exemption on either axis. */
const NONE = { dsh: {}, delorun: {} } as const

/**
 * Decide both axes of a plugin `plugin@1.0.0` whose manifest declares the given fields.
 * @param fields - the manifest's fields besides its name and version.
 * @param exemptions - both exemption files.
 * @returns each axis's decision.
 */
function decide(fields: Readonly<Record<string, unknown>>, exemptions: Parameters<typeof evaluatePluginAxes>[2] = NONE) {
  return evaluatePluginAxes({ name: 'plugin', version: '1.0.0', ...fields }, AXES, exemptions, 'plugin@1.0.0')
}

describe('evaluatePluginAxes', () => {
  it('changes nothing when the target meets the range', () => {
    expect(decide({ engines: { dsh: '^0.3.0' } }).dsh).toEqual({ kind: 'compatible' })
  })

  it('disables a plugin whose range the target does not meet', () => {
    expect(decide({ engines: { dsh: '^0.2.0' } }).dsh).toEqual({ kind: 'unmet', requirement: '^0.2.0' })
  })

  it('reads the DSH peers when engines.dsh is absent, as the start\'s preflight does', () => {
    const peers = { '@deepseek-ai/dsh-agent': '^0.2.0', '@deepseek-ai/dsh-tools': 'workspace:*', 'react': '^18.0.0' }
    expect(decide({ peerDependencies: peers }).dsh).toEqual({ kind: 'unmet', requirement: '^0.2.0 (peer @deepseek-ai/dsh-agent)' })
    expect(decide({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }).dsh).toEqual({ kind: 'compatible' })
    expect(decide({ engines: { dsh: '^0.3.0' }, peerDependencies: peers }).dsh).toEqual({ kind: 'compatible' })
    expect(decide({ peerDependencies: { react: '^18.0.0' } }).dsh).toEqual({ kind: 'undeclared' })
  })

  it('names each unmet requirement as upstream reports it', () => {
    expect(requirementText({ 'engines.dsh': '^0.2.0' })).toBe('^0.2.0')
    expect(requirementText({ '@deepseek-ai/dsh-agent': '^0.2.0', '@deepseek-ai/dsh': '0.2.2' })).toBe('^0.2.0 (peer @deepseek-ai/dsh-agent), 0.2.2 (peer @deepseek-ai/dsh)')
  })

  it('keeps a plugin the person exempted for the exact target version', () => {
    const record = { dsh: { 'plugin@1.0.0': [version('0.3.0')] }, delorun: {} }
    expect(decide({ engines: { dsh: '^0.2.0' } }, record).dsh).toEqual({ kind: 'exempted', requirement: '^0.2.0', version: version('0.3.0') })
  })

  it('disables a plugin whose exemption covers the version it runs today and not the target', () => {
    const record = { dsh: { 'plugin@1.0.0': [version('0.2.2')] }, delorun: {} }
    expect(decide({ engines: { dsh: '^0.2.0' } }, record).dsh).toEqual({ kind: 'not-carried', requirement: '^0.2.0', from: version('0.2.2'), to: version('0.3.0') })
  })

  it('prefers the exemption that covers the target over the one that covers the version running now', () => {
    const record = { dsh: { 'plugin@1.0.0': [version('0.2.2'), version('0.3.0')] }, delorun: {} }
    expect(decide({ engines: { dsh: '^0.2.0' } }, record).dsh.kind).toBe('exempted')
  })

  it('does not treat an exemption for another installed version as covering this one', () => {
    const record = { dsh: { 'plugin@9.9.9': [version('0.3.0')] }, delorun: {} }
    expect(decide({ engines: { dsh: '^0.2.0' } }, record).dsh.kind).toBe('unmet')
  })

  it('reports a declaration upstream cannot read as unreadable whatever the target is', () => {
    const record = { dsh: { 'plugin@1.0.0': [version('0.3.0')] }, delorun: {} }
    expect(decide({ engines: { dsh: 42 } }, record).dsh).toEqual({ kind: 'unreadable' })
    expect(decide({ peerDependencies: { '@deepseek-ai/dsh-agent': 3 } }).dsh).toEqual({ kind: 'unreadable' })
    expect(decide({ engines: { delorun: ['^1.0.0'] } })).toEqual({ dsh: { kind: 'undeclared' }, delorun: { kind: 'unreadable' } })
    expect(decide({ engines: '^0.3.0' })).toEqual({ dsh: { kind: 'unreadable' }, delorun: { kind: 'unreadable' } })
  })

  it('states that nothing is declared only on the DSH axis', () => {
    expect(decide({})).toEqual({ dsh: { kind: 'undeclared' }, delorun: { kind: 'none' } })
  })

  it('checks the Delorun axis against the Delorun the update installs, with its own exemptions', () => {
    expect(decide({ engines: { delorun: '^0.10.0' } }).delorun).toEqual({ kind: 'unmet', requirement: '^0.10.0' })
    expect(decide({ engines: { delorun: '^1.0.0' } }).delorun).toEqual({ kind: 'compatible' })
    expect(decide({ engines: { delorun: '^0.10.0' } }, { dsh: {}, delorun: { 'plugin@1.0.0': [version('1.0.0')] } }).delorun.kind).toBe('exempted')
  })
})
