// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  localSnoozeDate, localSnoozeTime, pickSnoozePreset, resolveCustomSnooze, resolveSnoozePreset, resolveSnoozePresets, snoozePresetId,
  snoozeRemaining,
} from '../src/snooze.ts'
import { snoozeLabelText, snoozeLeftText, snoozeOptions, snoozeWhenText } from '../src/client/snooze-text.ts'
import { en } from '../src/client/locales.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

// Tuesday 3 November 2026, local time.
const tuesday = (hour: number, minute = 0) => new Date(2026, 10, 3, hour, minute)
const t = makeTranslate(en)

describe('the snooze presets', () => {
  it('offers T3 Code\'s presets in order, each ending at the time it names', () => {
    const presets = resolveSnoozePresets(tuesday(10))
    expect(presets.map(preset => preset.id)).toEqual(['after:60', 'after:180', 'at:today:18:00', 'at:tomorrow:09:00', 'at:monday:09:00'])
    expect(presets.map(preset => preset.until)).toEqual([
      tuesday(11).getTime(), tuesday(13).getTime(), tuesday(18).getTime(),
      new Date(2026, 10, 4, 9).getTime(), new Date(2026, 10, 9, 9).getTime(),
    ])
    expect(presets.map(preset => preset.label)).toEqual([
      { kind: 'in', minutes: 60 }, { kind: 'in', minutes: 180 }, { kind: 'today', part: 'evening' }, { kind: 'tomorrow' }, { kind: 'next-week' },
    ])
  })

  it('lists one row for presets that end in the same minute, soonest first', () => {
    const presets = resolveSnoozePresets(tuesday(10), [
      { kind: 'at', day: 'tomorrow', time: '09:00' }, { kind: 'after', minutes: 60 }, { kind: 'at', day: 'today', time: '11:00' },
    ])
    expect(presets.map(preset => preset.id)).toEqual(['after:60', 'at:tomorrow:09:00'])
  })

  it('leaves out a time already past today, and names a Monday preset Tomorrow on a Sunday', () => {
    expect(resolveSnoozePresets(tuesday(19)).map(preset => preset.id)).not.toContain('at:today:18:00')
    const sunday = new Date(2026, 10, 8, 10)
    expect(resolveSnoozePreset({ kind: 'at', day: 'monday', time: '09:00' }, sunday)?.label).toEqual({ kind: 'tomorrow' })
    expect(resolveSnoozePreset({ kind: 'at', day: 'friday', time: '09:00' }, tuesday(10))?.label).toEqual({ kind: 'weekday', day: 'friday', next: false })
    expect(resolveSnoozePreset({ kind: 'at', day: 'tuesday', time: '09:00' }, tuesday(10))?.label).toEqual({ kind: 'weekday', day: 'tuesday', next: true })
    expect(resolveSnoozePreset({ kind: 'at', day: 'today', time: '11:00' }, tuesday(8))?.label).toEqual({ kind: 'today', part: 'morning' })
    expect(resolveSnoozePreset({ kind: 'at', day: 'today', time: '14:00' }, tuesday(8))?.label).toEqual({ kind: 'today', part: 'afternoon' })
  })

  it('names the weekday beside a duration that ends on another day', () => {
    expect(resolveSnoozePreset({ kind: 'after', minutes: 180 }, tuesday(23))?.namesDay).toBe(true)
    expect(resolveSnoozePreset({ kind: 'after', minutes: 60 }, tuesday(10))?.namesDay).toBe(false)
    expect(snoozePresetId({ kind: 'at', day: 'today', time: '18:00' })).toBe('at:today:18:00')
  })

  it('picks a duration from the moment it is picked, and a fixed time while it is still ahead', () => {
    const shown = resolveSnoozePresets(tuesday(10))
    expect(pickSnoozePreset(shown, 'after:60', tuesday(10, 5))).toBe(tuesday(11, 5).getTime())
    expect(pickSnoozePreset(shown, 'at:today:18:00', tuesday(12))).toBe(tuesday(18).getTime())
    expect(pickSnoozePreset(shown, 'at:today:18:00', tuesday(18, 1))).toBeUndefined()
    expect(pickSnoozePreset(shown, 'unknown', tuesday(12))).toBeUndefined()
  })

  it('counts the time left in the largest unit, rounded up', () => {
    expect(snoozeRemaining(1_000, 2_000)).toEqual({ unit: 'now' })
    expect(snoozeRemaining(30_000, 0)).toEqual({ unit: 'minutes', n: 1 })
    expect(snoozeRemaining(90 * 60_000, 0)).toEqual({ unit: 'hours', n: 2 })
    expect(snoozeRemaining(36 * 3_600_000, 0)).toEqual({ unit: 'days', n: 2 })
  })
})

describe('a custom snooze', () => {
  it('ends at a future local date and time, or after a duration', () => {
    expect(resolveCustomSnooze({ mode: 'date', date: '2026-11-04', time: '08:30' }, tuesday(10))).toBe(new Date(2026, 10, 4, 8, 30).getTime())
    expect(resolveCustomSnooze({ mode: 'duration', amount: '1.5', unit: 'hours' }, tuesday(10))).toBe(tuesday(11, 30).getTime())
    expect(resolveCustomSnooze({ mode: 'duration', amount: '2', unit: 'days' }, tuesday(10))).toBe(tuesday(10).getTime() + 2 * 86_400_000)
    expect(resolveCustomSnooze({ mode: 'duration', amount: '5', unit: 'minutes' }, tuesday(10))).toBe(tuesday(10, 5).getTime())
  })

  it('refuses the past, a rolled-over date, malformed input and a duration of zero', () => {
    expect(resolveCustomSnooze({ mode: 'date', date: '2026-11-02', time: '10:00' }, tuesday(10))).toBeNull()
    expect(resolveCustomSnooze({ mode: 'date', date: '2026-02-30', time: '10:00' }, tuesday(10))).toBeNull()
    expect(resolveCustomSnooze({ mode: 'date', date: 'tomorrow', time: '10:00' }, tuesday(10))).toBeNull()
    expect(resolveCustomSnooze({ mode: 'duration', amount: '0', unit: 'hours' }, tuesday(10))).toBeNull()
    expect(resolveCustomSnooze({ mode: 'duration', amount: 'soon', unit: 'hours' }, tuesday(10))).toBeNull()
  })

  it('formats the dialog\'s starting date and time in local time', () => {
    expect([localSnoozeDate(tuesday(9, 5)), localSnoozeTime(tuesday(9, 5))]).toEqual(['2026-11-03', '09:05'])
  })
})

describe('the snooze wording', () => {
  it('words each label kind', () => {
    expect(snoozeLabelText({ kind: 'in', minutes: 60 }, t, 'en')).toBe('In 1 hour')
    expect(snoozeLabelText({ kind: 'in', minutes: 2880 }, t, 'en')).toBe('In 2 days')
    expect(snoozeLabelText({ kind: 'in', minutes: 45 }, t, 'en')).toBe('In 45 minutes')
    expect(snoozeLabelText({ kind: 'today', part: 'evening' }, t, 'en')).toBe(en['snooze.today.evening'])
    expect(snoozeLabelText({ kind: 'tomorrow' }, t, 'en')).toBe(en['snooze.tomorrow'])
    expect(snoozeLabelText({ kind: 'next-week' }, t, 'en')).toBe(en['snooze.nextWeek'])
    expect(snoozeLabelText({ kind: 'weekday', day: 'friday', next: false }, t, 'en')).toBe('Friday')
    expect(snoozeLabelText({ kind: 'weekday', day: 'tuesday', next: true }, t, 'en')).toBe('Next Tuesday')
  })

  it('words when a snooze ends, naming the weekday only when asked and on another day', () => {
    const now = tuesday(10)
    expect(snoozeWhenText(tuesday(18).getTime(), now, 'en', true)).toBe(tuesday(18).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }))
    expect(snoozeWhenText(new Date(2026, 10, 4, 1).getTime(), now, 'en', true)).toMatch(/^Wed /)
    expect(snoozeWhenText(new Date(2026, 10, 4, 1).getTime(), now, 'en', false)).not.toMatch(/^Wed /)
    expect(snoozeOptions(now, t, 'en').options.map(option => option.label)).toEqual([
      'In 1 hour', 'In 3 hours', en['snooze.today.evening'], en['snooze.tomorrow'], en['snooze.nextWeek'],
    ])
    expect(snoozeOptions(now, t, 'en', [{ kind: 'after', minutes: 30 }, { kind: 'at', day: 'tomorrow', time: '07:00' }]).options.map(option => option.label))
      .toEqual(['In 30 minutes', en['snooze.tomorrow']])
    expect([snoozeLeftText(0, 1, t), snoozeLeftText(3 * 3_600_000, 0, t)]).toEqual([en['snooze.left.now'], '3h'])
  })
})
