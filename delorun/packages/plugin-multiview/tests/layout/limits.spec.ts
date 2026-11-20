import { describe, expect, it } from 'vitest'
import { capacityRefusal, DEFAULT_LAYOUT_LIMITS, paneCapacity } from '../../src/layout/index.ts'

describe('pane limits', () => {
  it('defaults to six panes of at least 340 by 240', () => {
    expect(DEFAULT_LAYOUT_LIMITS).toEqual({ maxPanes: 6, minPaneWidth: 340, minPaneHeight: 240 })
  })

  it('caps capacity at the pane limit on a large screen', () => {
    expect(paneCapacity(DEFAULT_LAYOUT_LIMITS, { width: 3000, height: 2000 })).toBe(6)
    expect(paneCapacity({ ...DEFAULT_LAYOUT_LIMITS, maxPanes: 4 })).toBe(4)
  })

  it('shrinks capacity to what fits at the least pane size, and always allows one pane', () => {
    expect(paneCapacity(DEFAULT_LAYOUT_LIMITS, { width: 1440, height: 800 })).toBe(6)
    expect(paneCapacity(DEFAULT_LAYOUT_LIMITS, { width: 700, height: 500 })).toBe(2 * 2)
    expect(paneCapacity(DEFAULT_LAYOUT_LIMITS, { width: 100, height: 100 })).toBe(1)
  })

  it('says why a pane is refused, the limit first', () => {
    expect(capacityRefusal(5, DEFAULT_LAYOUT_LIMITS)).toBeUndefined()
    expect(capacityRefusal(6, DEFAULT_LAYOUT_LIMITS)).toBe('max-panes')
    expect(capacityRefusal(4, DEFAULT_LAYOUT_LIMITS, { width: 700, height: 500 })).toBe('no-room')
    expect(capacityRefusal(6, DEFAULT_LAYOUT_LIMITS, { width: 700, height: 500 })).toBe('max-panes')
  })
})
