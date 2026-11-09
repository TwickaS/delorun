/**
 * The two version axes: what a declared range decides against the target, when an exemption admits the target, and when
 * the exemption that lets a plugin run today does not follow it to the next release (contract C17's two axes and its
 * exemption files).
 */
import { describe, expect, it } from 'vitest'
import { evaluateRequirement, exempted, exemptionKey, satisfiesRange } from '../src/index.ts'
import { version } from './support.ts'

/** The versions the default spec checks against: DSH 0.2.2 to 0.3.0, Delo 0.9.0 to 1.0.0. */
const AXES = { dsh: { from: version('0.2.2'), to: version('0.3.0') }, delo: { from: version('0.9.0'), to: version('1.0.0') } } as const

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

describe('evaluateRequirement', () => {
  it('changes nothing when the target meets the range', () => {
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.3.0' }, AXES.dsh, {}, 'plugin@1.0.0')).toEqual({ kind: 'compatible' })
  })

  it('disables a plugin whose range the target does not meet', () => {
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.2.0' }, AXES.dsh, {}, 'plugin@1.0.0')).toEqual({ kind: 'unmet', requirement: '^0.2.0' })
  })

  it('keeps a plugin the person exempted for the exact target version', () => {
    const record = { 'plugin@1.0.0': [version('0.3.0')] }
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.2.0' }, AXES.dsh, record, 'plugin@1.0.0')).toEqual({ kind: 'exempted', requirement: '^0.2.0', version: version('0.3.0') })
  })

  it('disables a plugin whose exemption covers the version it runs today and not the target', () => {
    const record = { 'plugin@1.0.0': [version('0.2.2')] }
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.2.0' }, AXES.dsh, record, 'plugin@1.0.0')).toEqual({ kind: 'not-carried', requirement: '^0.2.0', from: version('0.2.2'), to: version('0.3.0') })
  })

  it('prefers the exemption that covers the target over the one that covers the version running now', () => {
    const record = { 'plugin@1.0.0': [version('0.2.2'), version('0.3.0')] }
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.2.0' }, AXES.dsh, record, 'plugin@1.0.0').kind).toBe('exempted')
  })

  it('does not treat an exemption for another installed version as covering this one', () => {
    const record = { 'plugin@9.9.9': [version('0.3.0')] }
    expect(evaluateRequirement('dsh', { kind: 'range', range: '^0.2.0' }, AXES.dsh, record, 'plugin@1.0.0').kind).toBe('unmet')
  })

  it('reports a declaration it cannot read as unreadable whatever the target is', () => {
    expect(evaluateRequirement('dsh', { kind: 'unreadable' }, AXES.dsh, { 'plugin@1.0.0': [version('0.3.0')] }, 'plugin@1.0.0')).toEqual({ kind: 'unreadable' })
  })

  it('states that nothing is declared only on the DSH axis', () => {
    expect(evaluateRequirement('dsh', { kind: 'none' }, AXES.dsh, {}, 'plugin@1.0.0')).toEqual({ kind: 'undeclared' })
    expect(evaluateRequirement('delo', { kind: 'none' }, AXES.delo, {}, 'plugin@1.0.0')).toEqual({ kind: 'none' })
  })

  it('checks the Delo axis against the Delo the update installs', () => {
    expect(evaluateRequirement('delo', { kind: 'range', range: '^0.10.0' }, AXES.delo, {}, 'plugin@1.0.0')).toEqual({ kind: 'unmet', requirement: '^0.10.0' })
    expect(evaluateRequirement('delo', { kind: 'range', range: '^1.0.0' }, AXES.delo, {}, 'plugin@1.0.0')).toEqual({ kind: 'compatible' })
  })
})
