import { describe, expect, it } from 'vitest'
import { checkHomeVersion, SUPPORTED_HOME_RANGE } from '../src/version-skew.ts'

describe('checkHomeVersion', () => {
  it.each(['0.1.0-preview.4', '0.1.0-preview.12', '0.1.0', '0.1.9'])('accepts %s', (version) => {
    expect(checkHomeVersion(version)).toEqual({ kind: 'supported' })
  })

  it.each(['0.1.0-preview.3', '0.0.9'])('says %s is older, naming both versions, so the app offers to update the home', (version) => {
    expect(checkHomeVersion(version)).toEqual({ kind: 'older', version, range: SUPPORTED_HOME_RANGE })
  })

  it.each(['0.2.0', '0.2.0-preview.1', '1.0.0'])('says %s is newer, naming both versions, so the app offers its own update', (version) => {
    expect(checkHomeVersion(version)).toEqual({ kind: 'newer', version, range: SUPPORTED_HOME_RANGE })
  })

  it('does not guess at a version it cannot read', () => {
    expect(checkHomeVersion('dev')).toEqual({ kind: 'unreadable', range: SUPPORTED_HOME_RANGE })
    expect(checkHomeVersion('')).toEqual({ kind: 'unreadable', range: SUPPORTED_HOME_RANGE })
  })
})
