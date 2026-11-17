import { describe, expect, it } from 'vitest'
import { closestMatch, environmentLocale, groupsOfFour, readableTime, withReadableTimes } from '../src/output.ts'

describe('output helpers', () => {
  it('writes a time as day, month, year and minutes in the computer\'s zone', () => {
    expect(readableTime('2026-11-17T01:07:39.000Z', { locale: 'en-GB', timeZone: 'UTC' })).toBe('17 Nov 2026, 01:07')
    expect(readableTime('2026-11-17T13:07:00Z', { locale: 'en-GB', timeZone: 'Europe/London' })).toBe('17 Nov 2026, 13:07')
    expect(readableTime('not a time')).toBe('not a time')
  })

  it('replaces only the ISO timestamps in a line', () => {
    expect(withReadableTimes('written 2026-11-17T01:07:39.000Z by 2026', { locale: 'en-GB', timeZone: 'UTC' })).toBe('written 17 Nov 2026, 01:07 by 2026')
  })

  it('reads the locale from the environment, and falls back to British English', () => {
    expect(environmentLocale({ LANG: 'de_DE.UTF-8' })).toBe('de-DE')
    expect(environmentLocale({ LC_ALL: 'fr_FR', LANG: 'de_DE' })).toBe('fr-FR')
    expect(environmentLocale({ LANG: 'C' })).toBe('en-GB')
    expect(environmentLocale({ LANG: 'C.UTF-8' })).toBe('en-GB')
    expect(environmentLocale({})).toBe('en-GB')
  })

  it('groups text in fours', () => {
    expect(groupsOfFour('U0zlD_VITFOPUr9n')).toBe('U0zl D_VI TFOP Ur9n')
    expect(groupsOfFour('abcde')).toBe('abcd e')
    expect(groupsOfFour('')).toBe('')
  })

  it('finds the nearest command, or none', () => {
    const names = ['start', 'stop', 'status', 'doctor', 'devices']
    expect(closestMatch('doctr', names)).toBe('doctor')
    expect(closestMatch('stat', names)).toBe('status')
    expect(closestMatch('strt', names)).toBe('start')
    expect(closestMatch('STOP', names)).toBe('stop')
    expect(closestMatch('frobnicate', names)).toBeUndefined()
    expect(closestMatch('x', names)).toBeUndefined()
  })
})
