import { describe, expect, it } from 'vitest'
import { versionErrors } from '../../src/changelog/version.ts'

describe('a release version', () => {
  it('accepts 0.x pre-releases and 0.x finals', () => {
    for (const version of ['0.1.0-alpha.1', '0.2.0-beta.12', '0.2.1-rc.0', '0.3.0']) expect(versionErrors(version, false)).toEqual([])
  })

  it('refuses anything that is not strict semver of those forms', () => {
    for (const version of ['0.1', 'v0.1.0-alpha.1', '0.01.0', '0.1.0-dev.1', '0.1.0-alpha.01', '0.1.0-alpha', '0.1.0/../x']) {
      expect(versionErrors(version, false)).toEqual([expect.stringContaining('is not semver')])
    }
  })

  it('refuses 1.0.0 without the first-public-release flag and admits it with the flag', () => {
    expect(versionErrors('1.0.0', false)).toEqual([expect.stringContaining('pass --first-public-release')])
    expect(versionErrors('1.0.0', true)).toEqual([])
    expect(versionErrors('1.0.0-rc.1', true)).toEqual([expect.stringContaining('only 0.x.y and 1.0.0')])
    expect(versionErrors('2.0.0', true)).toEqual([expect.stringContaining('only 0.x.y and 1.0.0')])
  })
})
