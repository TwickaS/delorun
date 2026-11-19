/** How a limit window stands, and the share the Plans pill carries. */
import { describe, expect, it } from 'vitest'
import { highestShare, lastSeenAt, pillStanding, planName, titleKey, windowView, windowViews } from '../src/client/agent-limits.ts'
import { account, HOUR, MINUTE, NOW, window } from './agent-limits.fixture.ts'

describe('a window\'s standing', () => {
  it('is amber from 80% and reached at 100% or when the program says so', () => {
    expect(windowView(window({ kind: 'five_hour', usedPercent: 79.4 }), NOW).standing).toBe('ok')
    expect(windowView(window({ kind: 'five_hour', usedPercent: 80 }), NOW).standing).toBe('near')
    expect(windowView(window({ kind: 'five_hour', usedPercent: 100 }), NOW).standing).toBe('reached')
    expect(windowView(window({ kind: 'five_hour', status: 'reached', usedPercent: undefined }), NOW)).toMatchObject({ standing: 'reached', percent: 100 })
    expect(windowView(window({ kind: 'five_hour', status: 'near', usedPercent: undefined }), NOW)).toMatchObject({ standing: 'near', percent: undefined })
  })

  it('is unknown with no status and no figure, and clamps a share to 0 to 100', () => {
    expect(windowView(window({ kind: 'x', status: 'unknown', usedPercent: undefined }), NOW).standing).toBe('unknown')
    expect(windowView(window({ kind: 'x', usedPercent: 140 }), NOW).percent).toBe(100)
    expect(windowView(window({ kind: 'x', usedPercent: -3 }), NOW).percent).toBe(0)
  })

  it('is reset, with no share, once the reset time has passed, whatever was stored', () => {
    expect(windowView(window({ kind: 'five_hour', status: 'reached', usedPercent: 100, resetsAt: NOW - MINUTE }), NOW)).toMatchObject({ standing: 'reset', percent: undefined })
    expect(windowView(window({ kind: 'five_hour', resetsAt: NOW }), NOW).standing).toBe('reset')
  })
})

describe('the pill\'s share', () => {
  it('is the highest current share among added agents, ignoring reset windows and agents not added', () => {
    const claude = account({ windows: [window({ kind: 'five_hour', usedPercent: 82 }), window({ kind: 'seven_day', usedPercent: 95, resetsAt: NOW - HOUR })] })
    const codex = account({ provider: 'codex', installed: false, windows: [window({ kind: 'window_300m', usedPercent: 99 })] })
    expect(highestShare([claude, codex], NOW)).toBe(82)
    expect(highestShare([codex], NOW)).toBeUndefined()
    expect(highestShare([account({ windows: [] })], NOW)).toBeUndefined()
  })

  it('takes the standing of the worst window', () => {
    const calm = account()
    const reached = account({ windows: [window({ kind: 'five_hour', status: 'reached', usedPercent: 100 })] })
    expect(pillStanding(32, [calm], NOW)).toBe('ok')
    expect(pillStanding(82, [calm], NOW)).toBe('near')
    expect(pillStanding(100, [calm, reached], NOW)).toBe('reached')
    expect(pillStanding(undefined, [account({ windows: [] })], NOW)).toBe('unknown')
  })
})

describe('the small helpers', () => {
  it('finds when figures were last seen, from the check and the windows', () => {
    expect(lastSeenAt(account({ checkedAt: NOW - 5 * MINUTE }))).toBe(NOW - MINUTE)
    expect(lastSeenAt(account({ checkedAt: undefined, windows: [] }))).toBeUndefined()
    expect(windowViews(account(), NOW).map(view => view.kind)).toEqual(['five_hour', 'seven_day'])
  })

  it('capitalises a plan and titles the windows the copy translates', () => {
    expect(planName('max')).toBe('Max')
    expect(titleKey('five_hour')).toEqual({ key: 'limits.window.five_hour' })
    expect(titleKey('seven_day')).toEqual({ key: 'limits.window.seven_day' })
    expect(titleKey('window_43200m')).toEqual({ key: 'limits.window.days', count: '30' })
    expect(titleKey('window_10080m')).toEqual({ key: 'limits.window.seven_day' })
    expect(titleKey('window_300m')).toEqual({ key: 'limits.window.hours', count: '5' })
    expect(titleKey('window_45m')).toBeUndefined()
    expect(titleKey('overage')).toBeUndefined()
  })
})
