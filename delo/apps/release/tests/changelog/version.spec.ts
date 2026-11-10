import { describe, expect, it } from 'vitest'
import { compareVersions, isPreview, releaseOf, versionErrors } from '../../src/changelog/version.ts'

describe('a release version', () => {
  it('accepts 0.x pre-releases, previews and 0.x finals', () => {
    for (const version of ['0.1.0-alpha.1', '0.2.0-beta.12', '0.2.1-rc.0', '0.3.0', '0.1.0-preview.1', '0.1.0-preview.12']) expect(versionErrors(version, false)).toEqual([])
  })

  it('refuses anything that is not strict semver of those forms', () => {
    for (const version of ['0.1', 'v0.1.0-alpha.1', '0.01.0', '0.1.0-dev.1', '0.1.0-alpha.01', '0.1.0-alpha', '0.1.0/../x', '0.1.0-preview', '0.1.0-preview.01']) {
      expect(versionErrors(version, false)).toEqual([expect.stringContaining('is not semver')])
    }
  })

  it('starts previews at 1', () => {
    expect(versionErrors('0.1.0-preview.0', false)).toEqual([expect.stringContaining('starts previews at 1')])
  })

  it('refuses 1.0.0 without the first-public-release flag and admits it with the flag', () => {
    expect(versionErrors('1.0.0', false)).toEqual([expect.stringContaining('pass --first-public-release')])
    expect(versionErrors('1.0.0', true)).toEqual([])
    expect(versionErrors('1.0.0-rc.1', true)).toEqual([expect.stringContaining('only 0.x.y and 1.0.0')])
    expect(versionErrors('2.0.0', true)).toEqual([expect.stringContaining('only 0.x.y and 1.0.0')])
  })
})

describe('version order', () => {
  it('puts previews before their release, in numeric order', () => {
    const shuffled = ['0.1.0', '0.1.0-preview.10', '0.1.0-preview.2', '0.1.0-preview.1', '0.0.9', '0.2.0-preview.1', '0.1.1']
    expect([...shuffled].sort(compareVersions)).toEqual(['0.0.9', '0.1.0-preview.1', '0.1.0-preview.2', '0.1.0-preview.10', '0.1.0', '0.1.1', '0.2.0-preview.1'])
  })

  it('orders the pre-release tags alphabetically and finds equal versions equal', () => {
    expect(compareVersions('0.1.0-alpha.3', '0.1.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.1.0-rc.1', '0.1.0-preview.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.1.0-rc.1')).toBeGreaterThan(0)
  })

  it('names a preview and the release it leads to, and refuses a version it cannot read', () => {
    expect(isPreview('0.1.0-preview.3')).toBe(true)
    expect(isPreview('0.1.0-rc.1')).toBe(false)
    expect(releaseOf('0.1.0-preview.3')).toBe('0.1.0')
    expect(releaseOf('0.4.2')).toBe('0.4.2')
    expect(() => compareVersions('nope', '0.1.0')).toThrow('not semver')
  })
})
