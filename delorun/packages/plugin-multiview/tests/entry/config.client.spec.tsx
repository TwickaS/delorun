import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_MULTIVIEW_SETTINGS, KEPT_CHATS_RANGE, MAX_PANES_RANGE, MIN_PANE_SIZE_RANGE } from '../../src/config.ts'
import { DEFAULT_MAX_PANES, DEFAULT_MIN_PANE_HEIGHT, DEFAULT_MIN_PANE_WIDTH } from '../../src/layout/index.ts'
import { limitsOf } from '../../src/entry/state.ts'

/** The values of a validated configuration: each field is volatile, so it is read through `get()`. */
function plain(input: Record<string, unknown>) {
  const config = Config(input)
  return {
    autoOpen: config.autoOpen.get(), maxPanes: config.maxPanes.get(), minPaneWidth: config.minPaneWidth.get(),
    minPaneHeight: config.minPaneHeight.get(), compactComposer: config.compactComposer.get(), reopenOnReturn: config.reopenOnReturn.get(),
    keepChats: config.keepChats.get(), defaultLayout: config.defaultLayout.get(), mainSide: config.mainSide.get(), stackStyle: config.stackStyle.get(),
    mainShare: config.mainShare.get(), autoColumns: config.autoColumns.get(), mosaicMotion: config.mosaicMotion.get(),
    rememberScope: config.rememberScope.get(), saveOn: config.saveOn.get(), yours: config.yours.get(), workspaceLayouts: config.workspaceLayouts.get(),
  }
}

describe('Config', () => {
  it('defaults: auto-open on (MV9), six panes (MV10), compact composer (MV8), reopen on return (MV11)', () => {
    expect(plain({})).toEqual({
      autoOpen: true, maxPanes: 6, minPaneWidth: 340, minPaneHeight: 240, compactComposer: true, reopenOnReturn: true, keepChats: 50,
      defaultLayout: 'auto', mainSide: 'left', stackStyle: 'rows', mainShare: 56, autoColumns: 3, mosaicMotion: 'on',
      rememberScope: 'studio', saveOn: 'move-or-resize', yours: undefined, workspaceLayouts: {},
    })
    expect(DEFAULT_MULTIVIEW_SETTINGS).toEqual(plain({}))
    expect([DEFAULT_MAX_PANES, DEFAULT_MIN_PANE_WIDTH, DEFAULT_MIN_PANE_HEIGHT]).toEqual([6, 340, 240])
  })

  it.each(['autoOpen', 'compactComposer', 'reopenOnReturn'] as const)('%s takes a boolean and nothing else', (field) => {
    expect(plain({ [field]: false })[field]).toBe(false)
    expect(() => plain({ [field]: 'no' })).toThrow()
    expect(() => plain({ [field]: 1 })).toThrow()
  })

  it('maxPanes takes a whole number from 2 to 12', () => {
    expect(plain({ maxPanes: MAX_PANES_RANGE.min }).maxPanes).toBe(2)
    expect(plain({ maxPanes: MAX_PANES_RANGE.max }).maxPanes).toBe(12)
    for (const bad of [1, 0, -3, 13, 2.5, '6', NaN, Infinity]) expect(() => plain({ maxPanes: bad })).toThrow()
  })

  it('keepChats takes a whole number from 1 to 500', () => {
    expect(plain({ keepChats: KEPT_CHATS_RANGE.min }).keepChats).toBe(1)
    expect(plain({ keepChats: KEPT_CHATS_RANGE.max }).keepChats).toBe(500)
    for (const bad of [0, -1, 501, 2.5, '50', NaN]) expect(() => plain({ keepChats: bad })).toThrow()
  })

  it('the least pane size takes whole numbers inside its range', () => {
    expect(plain({ minPaneWidth: MIN_PANE_SIZE_RANGE.width.min, minPaneHeight: MIN_PANE_SIZE_RANGE.height.max })).toMatchObject({ minPaneWidth: 240, minPaneHeight: 1200 })
    for (const bad of [239, 1201, 340.5]) expect(() => plain({ minPaneWidth: bad })).toThrow()
    for (const bad of [159, 1201, 240.5]) expect(() => plain({ minPaneHeight: bad })).toThrow()
  })

  it('gives the layout its limits from the settings', () => {
    expect(limitsOf({ ...DEFAULT_MULTIVIEW_SETTINGS, maxPanes: 4, minPaneWidth: 400, minPaneHeight: 300 })).toEqual({ maxPanes: 4, minPaneWidth: 400, minPaneHeight: 300 })
  })
})
