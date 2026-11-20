import { describe, expect, it } from 'vitest'
import { parseLocalSmokeArgs } from '../../scripts/local-smoke.ts'

describe('the local smoke command line', () => {
  const base = ['--previous-closure', '/p', '--previous-version', '0.1.0-preview.2.1', '--closure', '/c', '--version', '0.1.0-preview.2.2']

  it('takes the two closures and versions, with the scratch ports by default', () => {
    expect(parseLocalSmokeArgs(base)).toMatchObject({ previousClosure: '/p', previousVersion: '0.1.0-preview.2.1', closure: '/c', version: '0.1.0-preview.2.2', channelPort: 18981, studioPort: 18982, keep: false })
  })

  it('refuses a missing closure or version and a port that is not a number', () => {
    expect(() => parseLocalSmokeArgs(['--version', '0.1.0'])).toThrow(/--previous-closure/u)
    expect(() => parseLocalSmokeArgs([...base, '--studio-port', 'x'])).toThrow(/--studio-port/u)
  })
})
