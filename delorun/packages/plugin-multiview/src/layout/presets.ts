/**
 * The layout presets. A preset only rearranges the panes it is given: nothing opens or closes.
 * @module @delorun/plugin-multiview/layout/presets
 */

import { layoutOf, leafOf, splitOf, type LayoutModel, type LayoutNode, type PaneId } from './model.ts'

/** The arrangements the Layout menu offers. */
export type LayoutPreset = 'main-column' | 'side-by-side' | 'grid' | 'main-top'

/** Every preset, in menu order. */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = ['main-column', 'side-by-side', 'grid', 'main-top']

/** The preset a new layout and "Reset layout" use: the main chat on the left, the agents stacked on the right. */
export const DEFAULT_PRESET: LayoutPreset = 'main-column'

/** The main chat's share of the split in the `main-column` and `main-top` presets, in percent. */
export const MAIN_SHARE = 56

const single = (pane: PaneId): LayoutNode => leafOf([pane])

/**
 * Arrange panes in a preset.
 * @param preset - the arrangement.
 * @param main - the main chat's pane, which every preset puts first (top left).
 * @param others - the other panes in the order they appear.
 * @returns the layout. `main-column` is the main chat 56 / 44 beside a stack of the others; `side-by-side` one equal row;
 * `grid` rows of ceil(sqrt(n)) columns, the last row filling its width; `main-top` the main chat above a row of the others.
 */
export function buildPreset(preset: LayoutPreset, main: PaneId, others: readonly PaneId[]): LayoutModel {
  if (others.length === 0) return layoutOf(single(main))
  const all = [main, ...others]
  switch (preset) {
    case 'main-column':
      return layoutOf(columns(main, splitOf('vertical', others.map(single), 100 - MAIN_SHARE)))
    case 'main-top':
      return layoutOf({
        ...splitOf('vertical', [single(main), splitOf('horizontal', others.map(single))]),
        children: [
          { ...single(main), size: MAIN_SHARE },
          { ...splitOf('horizontal', others.map(single)), size: 100 - MAIN_SHARE },
        ],
      })
    case 'side-by-side':
      return layoutOf(splitOf('horizontal', all.map(single)))
    case 'grid': {
      const perRow = Math.ceil(Math.sqrt(all.length))
      const rows: LayoutNode[] = []
      for (let index = 0; index < all.length; index += perRow) rows.push(splitOf('horizontal', all.slice(index, index + perRow).map(single)))
      return layoutOf(splitOf('vertical', rows))
    }
    default:
      return assertNeverPreset(preset)
  }
}

function columns(main: PaneId, stack: LayoutNode): LayoutNode {
  const root = splitOf('horizontal', [single(main), stack])
  return { ...root, children: [{ ...single(main), size: MAIN_SHARE }, { ...stack, size: 100 - MAIN_SHARE }] }
}

function assertNeverPreset(value: never): never {
  throw new Error(`Unknown layout preset: ${String(value)}`)
}
