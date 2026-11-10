/**
 * Setup for the moved-clock check (`delo/vitest.moved-clock.config.ts`): `Date` reads the real time moved forward by
 * `DELO_MOVED_CLOCK_DAYS` days (0 when unset) and keeps advancing with it; timers stay real. The clock moves when this
 * file loads, before the spec file, so a date a spec takes at load and a date its code takes in a test agree, and it
 * is moved again before each test, after a spec that restored real timers. A spec that installs its own fake timers
 * replaces it for its tests.
 */
import { beforeEach, vi } from 'vitest'

const DAY_MS = 86_400_000
const days = Number(process.env['DELO_MOVED_CLOCK_DAYS'] ?? '0')
if (!Number.isSafeInteger(days)) throw new Error(`DELO_MOVED_CLOCK_DAYS must be a whole number of days, got ${String(process.env['DELO_MOVED_CLOCK_DAYS'])}`)

/** Install the moved clock; `performance` is not faked, so it reads the real time. */
function moveClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: performance.timeOrigin + performance.now() + days * DAY_MS, shouldAdvanceTime: true })
}

moveClock()
beforeEach(moveClock)
