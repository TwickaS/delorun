/**
 * Setup for the moved-clock check (`delo/vitest.moved-clock.config.ts`): before each test, `Date` reads the real time
 * moved forward by `DELO_MOVED_CLOCK_DAYS` days (0 when unset) and keeps advancing with it; timers stay real. A spec
 * that installs its own fake timers replaces this for its tests.
 */
import { afterEach, beforeEach, vi } from 'vitest'

const DAY_MS = 86_400_000
const days = Number(process.env['DELO_MOVED_CLOCK_DAYS'] ?? '0')
if (!Number.isSafeInteger(days)) throw new Error(`DELO_MOVED_CLOCK_DAYS must be a whole number of days, got ${String(process.env['DELO_MOVED_CLOCK_DAYS'])}`)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + days * DAY_MS, shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})
