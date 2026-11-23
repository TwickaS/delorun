import { describe, expect, it } from 'vitest'
import { AUTO_COLUMNS_RANGE, Config, PANE_GAP_RANGE, DEFAULT_MULTIVIEW_SETTINGS, KEPT_CHATS_RANGE, MAX_PANES_RANGE, MIN_PANE_SIZE_RANGE } from '../../src/config.ts'
import { buildPreset, DEFAULT_MAX_PANES, DEFAULT_MIN_PANE_HEIGHT, DEFAULT_MIN_PANE_WIDTH, MAIN_SHARE_RANGE, shapeOf, type PaneId } from '../../src/layout/index.ts'
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
    paneGap: config.paneGap.get(),
  }
}

describe('Config', () => {
  it('defaults: auto-open on (MV9), six panes (MV10), compact composer (MV8), reopen on return (MV11)', () => {
    expect(plain({})).toEqual({
      autoOpen: true, maxPanes: 6, minPaneWidth: 340, minPaneHeight: 240, compactComposer: true, reopenOnReturn: true, keepChats: 50,
      defaultLayout: 'auto', mainSide: 'left', stackStyle: 'rows', mainShare: 56, autoColumns: 3, mosaicMotion: 'on',
      rememberScope: 'studio', saveOn: 'move-or-resize', yours: undefined, workspaceLayouts: {}, paneGap: 0,
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
    expect(limitsOf({ ...DEFAULT_MULTIVIEW_SETTINGS, maxPanes: 4, minPaneWidth: 400, minPaneHeight: 300 })).toEqual({ maxPanes: 4, minPaneWidth: 400, minPaneHeight: 300, paneGap: 0 })
  })

  it('the layout fields take a layout of the picker or yours, a side, a stack style and the motion, and nothing else', () => {
    expect(plain({ defaultLayout: 'spiral', mainSide: 'right', stackStyle: 'grid', mosaicMotion: 'reduced' })).toMatchObject({
      defaultLayout: 'spiral', mainSide: 'right', stackStyle: 'grid', mosaicMotion: 'reduced',
    })
    expect(plain({ defaultLayout: 'yours' }).defaultLayout).toBe('yours')
    for (const bad of [{ defaultLayout: 'main-column' }, { defaultLayout: 'cascade' }, { mainSide: 'top' }, { stackStyle: 'dwindle' }, { mosaicMotion: 'off' }]) {
      expect(() => plain(bad)).toThrow()
    }
  })

  it('the main share and Auto’s columns take whole numbers inside their ranges', () => {
    expect(plain({ mainShare: MAIN_SHARE_RANGE.min }).mainShare).toBe(25)
    expect(plain({ mainShare: MAIN_SHARE_RANGE.max }).mainShare).toBe(75)
    for (const bad of [24, 76, 50.5, '56']) expect(() => plain({ mainShare: bad })).toThrow()
    expect(plain({ autoColumns: AUTO_COLUMNS_RANGE.min }).autoColumns).toBe(1)
    expect(plain({ autoColumns: AUTO_COLUMNS_RANGE.max }).autoColumns).toBe(6)
    for (const bad of [0, 7, 2.5]) expect(() => plain({ autoColumns: bad })).toThrow()
  })

  it('the arrangement fields take a scope and a trigger, a saved shape and per-workspace defaults', () => {
    expect(plain({ rememberScope: 'workspace', saveOn: 'move' })).toMatchObject({ rememberScope: 'workspace', saveOn: 'move' })
    expect(() => plain({ rememberScope: 'browser' })).toThrow()
    expect(() => plain({ saveOn: 'resize' })).toThrow()
    const main = 'main' as PaneId
    const shape = shapeOf(buildPreset('main-stack', main, ['a' as PaneId]), [main, 'a' as PaneId])
    expect(plain({ yours: shape }).yours).toEqual(shape)
    expect(plain({ yours: null }).yours).toBeNull()
    expect(() => plain({ yours: { version: 1, root: { kind: 'tile' } } })).toThrow()
    const workspaceLayouts = { 'ws-1': { defaultLayout: 'yours', yours: shape, mainSide: 'right' } }
    expect(plain({ workspaceLayouts }).workspaceLayouts).toEqual(workspaceLayouts)
    expect(() => plain({ workspaceLayouts: { 'ws-1': { stackStyle: 'cascade' } } })).toThrow()
  })

  it('the space between panes takes a whole number of pixels from 0 to 32, none by default, and reaches the layout limits', () => {
    expect(plain({}).paneGap).toBe(0)
    expect(plain({ paneGap: PANE_GAP_RANGE.min }).paneGap).toBe(0)
    expect(plain({ paneGap: PANE_GAP_RANGE.max }).paneGap).toBe(32)
    for (const bad of [-1, 33, 4.5, '8']) expect(() => plain({ paneGap: bad })).toThrow()
    expect(limitsOf({ ...DEFAULT_MULTIVIEW_SETTINGS, paneGap: 12 }).paneGap).toBe(12)
  })

  it('refuses a saved arrangement that names a slot twice or nests deeper than the browser keeps', () => {
    const leaf = (slot: number) => ({ kind: 'leaf', slots: [slot], active: slot, size: 50 })
    const nested = (splits: number, slot = 0): unknown => splits === 0
      ? { ...leaf(slot), size: 50 }
      : { kind: 'split', orientation: slot % 2 === 0 ? 'horizontal' : 'vertical', size: 50, children: [leaf(slot), nested(splits - 1, slot + 1)] }
    expect(() => plain({ yours: { version: 1, root: nested(11) } })).not.toThrow()
    expect(() => plain({ yours: { version: 1, root: nested(12) } })).toThrow()
    const twice = { kind: 'split', orientation: 'horizontal', size: 100, children: [leaf(1), leaf(1)] }
    expect(() => plain({ yours: { version: 1, root: twice } })).toThrow()
    expect(() => plain({ workspaceLayouts: { 'ws-1': { yours: { version: 1, root: twice } } } })).toThrow()
  })
})
