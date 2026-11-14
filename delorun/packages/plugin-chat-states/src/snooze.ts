/**
 * When a snooze ends: the menu's presets, a custom date or duration, and the
 * time left on a snoozed chat. Ported from T3 Code's thread snoozing
 * (`packages/client-runtime/src/state/threadSettled.ts`, MIT, © 2026 T3 Tools
 * Inc.), adapted to epoch milliseconds and to wording the studio localizes.
 * Browser-safe and pure: every function takes the clock it reads.
 * @module @delorun/plugin-chat-states/snooze
 */

/** A day of the week, as a preset names it. */
export type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'

/** One snooze preset: a duration from now, or a time of day on a named day. */
export type SnoozePresetSetting =
  | { readonly kind: 'after'; readonly minutes: number }
  | { readonly kind: 'at'; readonly day: 'today' | 'tomorrow' | Weekday; readonly time: string }

/** The menu's presets: in an hour, in three hours, this evening, tomorrow morning and next week. */
export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePresetSetting[] = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
]

const WEEKDAY_INDEX: Readonly<Record<Weekday, number>> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** What a preset's label says, for the studio to word. */
export type SnoozeLabel =
  | { readonly kind: 'in'; readonly minutes: number }
  | { readonly kind: 'today'; readonly part: 'morning' | 'afternoon' | 'evening' }
  | { readonly kind: 'tomorrow' }
  | { readonly kind: 'next-week' }
  | { readonly kind: 'weekday'; readonly day: Weekday; readonly next: boolean }

/** A preset resolved against the clock. */
export interface SnoozePreset {
  /** Stable across openings of the menu: `after:<minutes>` or `at:<day>:<time>`. */
  readonly id: string
  readonly label: SnoozeLabel
  /** When the snooze ends, in epoch milliseconds. */
  readonly until: number
  /** Whether the menu names the wake's weekday beside its time: a duration or next week ending on another day. */
  readonly namesDay: boolean
}

/**
 * The calendar day `days` after `base`, at the same local time. Fixed millisecond offsets land on the wrong local day
 * across a daylight-saving change.
 */
function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function daysAhead(setting: Extract<SnoozePresetSetting, { kind: 'at' }>, now: Date): number {
  if (setting.day === 'today') return 0
  if (setting.day === 'tomorrow') return 1
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7
}

/** Labels follow the actual day gap, so a Monday preset on a Sunday reads Tomorrow. */
function labelOf(setting: SnoozePresetSetting, ahead: number): SnoozeLabel {
  if (setting.kind === 'after') return { kind: 'in', minutes: setting.minutes }
  if (ahead === 0) {
    const hour = Number(setting.time.slice(0, 2))
    return { kind: 'today', part: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening' }
  }
  if (ahead === 1) return { kind: 'tomorrow' }
  if (setting.day === 'monday') return { kind: 'next-week' }
  return { kind: 'weekday', day: setting.day as Weekday, next: ahead === 7 }
}

/**
 * A preset's id.
 * @param setting - the preset.
 * @returns `after:<minutes>` or `at:<day>:<time>`.
 */
export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === 'after' ? `after:${String(setting.minutes)}` : `at:${setting.day}:${setting.time}`
}

/**
 * Resolve one preset against the clock.
 * @param setting - the preset.
 * @param now - the clock.
 * @returns the preset, or null for a time today that has passed.
 */
export function resolveSnoozePreset(setting: SnoozePresetSetting, now: Date): SnoozePreset | null {
  let wake: Date
  let ahead = 0
  if (setting.kind === 'after') {
    wake = new Date(now.getTime() + setting.minutes * MINUTE_MS)
  } else {
    ahead = daysAhead(setting, now)
    wake = addDays(now, ahead)
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0)
    if (wake.getTime() <= now.getTime()) return null
  }
  const label = labelOf(setting, ahead)
  const labelNamesDay = setting.kind === 'at' && label.kind !== 'next-week'
  return {
    id: snoozePresetId(setting),
    label,
    until: wake.getTime(),
    namesDay: !labelNamesDay && wake.toDateString() !== now.toDateString(),
  }
}

/**
 * The snooze menu: soonest first, one row per wake minute.
 * @param now - the clock.
 * @param presets - the presets; {@link DEFAULT_SNOOZE_PRESETS} by default.
 * @returns the resolved presets.
 */
export function resolveSnoozePresets(now: Date, presets: readonly SnoozePresetSetting[] = DEFAULT_SNOOZE_PRESETS): SnoozePreset[] {
  const minute = (preset: SnoozePreset): number => Math.floor(preset.until / MINUTE_MS)
  const seen = new Set<number>()
  return presets
    .flatMap(setting => resolveSnoozePreset(setting, now) ?? [])
    .sort((a, b) => minute(a) - minute(b))
    .filter((preset) => {
      if (seen.has(minute(preset))) return false
      seen.add(minute(preset))
      return true
    })
}

/**
 * A menu choice as picked: a duration counts from the pick, a set time keeps the wake the menu showed.
 * @param shown - the presets the menu showed.
 * @param id - the picked preset's id.
 * @param now - the clock at the pick.
 * @param presets - the presets the menu was resolved from.
 * @returns the snooze's end, or undefined for a shown time that has passed.
 */
export function pickSnoozePreset(
  shown: readonly SnoozePreset[], id: string, now: Date, presets: readonly SnoozePresetSetting[] = DEFAULT_SNOOZE_PRESETS,
): number | undefined {
  const setting = presets.find(candidate => candidate.kind === 'after' && snoozePresetId(candidate) === id)
  if (setting !== undefined) return resolveSnoozePreset(setting, now)?.until
  const original = shown.find(preset => preset.id === id)
  return original !== undefined && original.until > now.getTime() ? original.until : undefined
}

/** The time left on a snooze, in its largest whole unit, rounded up. */
export type SnoozeRemaining = { readonly unit: 'now' } | { readonly unit: 'minutes' | 'hours' | 'days'; readonly n: number }

/**
 * The time left before a snoozed chat wakes, for its row.
 * @param until - when the snooze ends.
 * @param now - the clock, in epoch milliseconds.
 * @returns the time left.
 */
export function snoozeRemaining(until: number, now: number): SnoozeRemaining {
  const left = until - now
  if (left <= 0) return { unit: 'now' }
  if (left < HOUR_MS) return { unit: 'minutes', n: Math.max(1, Math.ceil(left / MINUTE_MS)) }
  if (left < DAY_MS) return { unit: 'hours', n: Math.ceil(left / HOUR_MS) }
  return { unit: 'days', n: Math.ceil(left / DAY_MS) }
}

/** A custom snooze as the dialog takes it: a local date and time, or an amount of a unit. */
export type CustomSnoozeInput =
  | { readonly mode: 'date'; readonly date: string; readonly time: string }
  | { readonly mode: 'duration'; readonly amount: string; readonly unit: 'minutes' | 'hours' | 'days' }

/**
 * Resolve a custom snooze.
 * @param input - the dialog's fields.
 * @param now - the clock.
 * @returns the snooze's end, or null for a date that does not exist, a time not in the future, or an amount not above 0.
 */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): number | null {
  let wake: Date
  if (input.mode === 'duration') {
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    wake = new Date(now.getTime() + amount * { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS }[input.unit])
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null
    wake = new Date(`${input.date}T${input.time}:00`)
    // A rolled-over date or a local time a daylight-saving change skips is not the one asked for.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime() ? wake.getTime() : null
}

/**
 * A local date as a date field holds it.
 * @param date - the date.
 * @returns `YYYY-MM-DD`.
 */
export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * A local time as a time field holds it.
 * @param date - the date.
 * @returns `HH:MM`.
 */
export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
