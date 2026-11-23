/**
 * How long ago a trust check ran, in words: the studio's shared bucketing (`relativeTime` of the UI primitives, so every
 * surface agrees on "now", minutes, hours and days), worded through `Intl.RelativeTimeFormat` in the panel's locale, so
 * "Checked 3 minutes ago" reads in each language. The studio re-renders it every {@link TRUST_TICK_MS}, which keeps it
 * live; the exact time goes in the hover title.
 * @module @delorun/bundle-local/client/trust-time
 */
import { relativeTime as bucket } from '@deepseek-ai/dsh-client-ui-primitives'

/** How often a relative time is worked out again, in milliseconds. */
export const TRUST_TICK_MS = 15_000

/** A relative time: under a minute is `just-now`; otherwise the formatted words. */
export type TrustRelativeTime = { readonly kind: 'just-now' } | { readonly kind: 'ago', readonly text: string }

/** The `Intl.RelativeTimeFormat` unit of each bucket after `now`. */
const UNITS = { minutes: 'minute', hours: 'hour', days: 'day', months: 'month', years: 'year' } as const

/**
 * How long ago a moment was.
 * @param locale - the panel's locale, such as `en` or `zh-CN`.
 * @param at - the moment, RFC 3339.
 * @param now - the current time, in milliseconds since the epoch.
 * @returns the relative time, or `undefined` when `at` does not parse. A moment in the future, such as from a clock a
 *   little ahead, reads as just now.
 */
export function relativeTime(locale: string, at: string, now: number): TrustRelativeTime | undefined {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return undefined
  const { unit, n } = bucket(time, now)
  if (unit === 'now') return { kind: 'just-now' }
  return { kind: 'ago', text: new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' }).format(-n, UNITS[unit]) }
}
