/** The names a person knows each limit window by. */
import { describe, expect, it } from 'vitest'
import { windowTitle } from '../src/accounts/wire.ts'

describe('windowTitle', () => {
  it('calls both agents\' weekly window the weekly limit', () => {
    expect(windowTitle('seven_day')).toBe('Weekly limit')
    expect(windowTitle('window_10080m')).toBe('Weekly limit')
  })

  it('names other Codex windows by their length', () => {
    expect(windowTitle('window_43200m')).toBe('30-day limit')
    expect(windowTitle('window_300m')).toBe('5-hour limit')
    expect(windowTitle('window_90m')).toBe('90-minute limit')
  })
})
