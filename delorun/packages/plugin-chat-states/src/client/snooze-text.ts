/**
 * The snooze menu and a snoozed chat's time left, worded in the studio's
 * language: preset names from the dictionary, durations, weekdays and clock
 * times from the browser's `Intl` formats for that language.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_SNOOZE_PRESETS, resolveSnoozePresets, snoozeRemaining, type SnoozeLabel, type SnoozePreset, type SnoozePresetSetting, type Weekday } from '../snooze.ts'

type Translate = PropsLocale<'delorunChatStates'>['t']

/** One row of the snooze menu, worded. */
export interface SnoozeOption {
  /** The preset's id. */
  readonly id: string
  /** What the row says, such as In 1 hour or Tomorrow. */
  readonly label: string
  /** When the snooze would end, such as 18:00 or Tue 09:00. */
  readonly when: string
  /** When the snooze would end, in epoch milliseconds. */
  readonly until: number
}

/** A Sunday, from which each weekday's name is formatted. */
const SUNDAY = new Date(2026, 10, 1)
const WEEKDAYS: readonly Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function weekdayName(day: Weekday, locale: string): string {
  const date = new Date(SUNDAY)
  date.setDate(SUNDAY.getDate() + WEEKDAYS.indexOf(day))
  return date.toLocaleDateString(locale, { weekday: 'long' })
}

/** The largest unit a whole number of minutes divides into, as `Intl.RelativeTimeFormat` takes it. */
function duration(minutes: number): [number, 'minute' | 'hour' | 'day'] {
  if (minutes % (24 * 60) === 0) return [minutes / (24 * 60), 'day']
  if (minutes % 60 === 0) return [minutes / 60, 'hour']
  return [minutes, 'minute']
}

/**
 * Word a preset's label.
 * @param label - what the label says.
 * @param t - the dictionary.
 * @param locale - the studio's language.
 * @returns the label.
 */
export function snoozeLabelText(label: SnoozeLabel, t: Translate, locale: string): string {
  switch (label.kind) {
    case 'in': {
      const text = new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(...duration(label.minutes))
      return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
    }
    case 'today': return t(`snooze.today.${label.part}`)
    case 'tomorrow': return t('snooze.tomorrow')
    case 'next-week': return t('snooze.nextWeek')
    case 'weekday': {
      const name = weekdayName(label.day, locale)
      return label.next ? t('snooze.nextWeekday', { day: name }) : name
    }
  }
}

/**
 * Word when a snooze ends: the clock time, with the weekday when it is another day the label does not name.
 * @param until - when the snooze ends.
 * @param now - the clock.
 * @param locale - the studio's language.
 * @param namesDay - whether to name the weekday.
 * @returns the time.
 */
export function snoozeWhenText(until: number, now: Date, locale: string, namesDay: boolean): string {
  const wake = new Date(until)
  const time = wake.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  return namesDay && wake.toDateString() !== now.toDateString() ? `${wake.toLocaleDateString(locale, { weekday: 'short' })} ${time}` : time
}

/**
 * The snooze menu's rows now, worded.
 * @param now - the clock.
 * @param t - the dictionary.
 * @param locale - the studio's language.
 * @param presets - the person's presets; T3 Code's by default.
 * @returns the presets the rows show, to pick from, and the rows.
 */
export function snoozeOptions(
  now: Date, t: Translate, locale: string, presets: readonly SnoozePresetSetting[] = DEFAULT_SNOOZE_PRESETS,
): { readonly shown: SnoozePreset[]; readonly options: SnoozeOption[] } {
  const shown = resolveSnoozePresets(now, presets)
  return {
    shown,
    options: shown.map(preset => ({
      id: preset.id,
      label: snoozeLabelText(preset.label, t, locale),
      when: snoozeWhenText(preset.until, now, locale, preset.namesDay),
      until: preset.until,
    })),
  }
}

/**
 * Word the time left on a snooze, for a snoozed chat's row.
 * @param until - when the snooze ends.
 * @param now - the clock, in epoch milliseconds.
 * @param t - the dictionary.
 * @returns the time left, such as 3h.
 */
export function snoozeLeftText(until: number, now: number, t: Translate): string {
  const left = snoozeRemaining(until, now)
  return left.unit === 'now' ? t('snooze.left.now') : t(`snooze.left.${left.unit}`, { n: left.n })
}
