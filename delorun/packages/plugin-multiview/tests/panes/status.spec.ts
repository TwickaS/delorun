import { describe, expect, it } from 'vitest'
import { advanceClock, formatElapsed, FRESH_CLOCK, initialsOf, limitChips, paneStatus } from '../../src/panes/status.ts'

const clock = (epochMs: number): string => `t${String(epochMs)}`

describe('the pane status', () => {
  it('says needs approval whenever the chat waits, even while it runs', () => {
    expect(paneStatus({ running: true, waiting: true, isMain: false })).toBe('needs-approval')
    expect(paneStatus({ running: false, waiting: true, isMain: true })).toBe('needs-approval')
  })

  it('says working while it runs and done for a finished agent, but ready for the main chat', () => {
    expect(paneStatus({ running: true, waiting: false, isMain: false })).toBe('working')
    expect(paneStatus({ running: false, waiting: false, isMain: false })).toBe('done')
    expect(paneStatus({ running: false, waiting: false, isMain: true })).toBe('idle')
  })
})

describe('the badge time', () => {
  it('writes seconds, minutes and hours', () => {
    expect(formatElapsed(48_000)).toBe('48s')
    expect(formatElapsed(242_000)).toBe('4m 02s')
    expect(formatElapsed(3_900_000)).toBe('1h 05m')
    expect(formatElapsed(-5)).toBe('0s')
  })

  it('starts a run at the first working observation and keeps the duration when it ends', () => {
    const started = advanceClock(FRESH_CLOCK, 'working', 1000)
    expect(started).toEqual({ status: 'working', startedAt: 1000, lastDuration: undefined })
    expect(advanceClock(started, 'working', 2000)).toBe(started)
    const waiting = advanceClock(started, 'needs-approval', 3000)
    expect(waiting.startedAt).toBe(1000)
    expect(advanceClock(waiting, 'done', 5000)).toEqual({ status: 'done', startedAt: undefined, lastDuration: 4000 })
  })

  it('starts a pane opened mid-run at the time the chat says its run began', () => {
    expect(advanceClock(FRESH_CLOCK, 'working', 9000, 4000).startedAt).toBe(4000)
  })
})

describe('the monogram', () => {
  it('takes two initials from two words and two letters from one', () => {
    expect(initialsOf('Port the garden planner')).toBe('PT')
    expect(initialsOf('Explorer')).toBe('EX')
    expect(initialsOf('  ')).toBe('?')
  })
})

describe('the limits line', () => {
  it('has no chips for a chat that is not a live agent', () => {
    expect(limitChips(null, clock)).toEqual([])
    expect(limitChips(undefined, clock)).toEqual([])
  })

  it('lists the version, plan, five-hour use with its reset, and weekly use in reading order', () => {
    const chips = limitChips({ agent: 'claude-code', version: '2.1.263', plan: 'Max', fiveHourPercent: 41.2, fiveHourResetAt: 7, weeklyPercent: 12 }, clock)
    expect(chips.map(chip => chip.key)).toEqual(['limits.version', 'limits.plan', 'limits.fiveHourReset', 'limits.weekly'])
    expect(chips[0]!.values).toEqual({ agent: 'Claude Code', version: '2.1.263' })
    expect(chips[2]!.values).toEqual({ percent: '41', time: 't7' })
  })

  it('shows only what the agent has reported', () => {
    expect(limitChips({ agent: 'codex', fiveHourPercent: 18 }, clock).map(chip => chip.key)).toEqual(['limits.fiveHour'])
    expect(limitChips({ agent: 'other', version: '1' }, clock)).toEqual([])
  })
})
