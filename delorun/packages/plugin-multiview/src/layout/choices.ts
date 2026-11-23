/**
 * The choices the layout picker offers, with their labels and when each one has something to show.
 * @module @delorun/plugin-multiview/layout/choices
 */

import { LAYOUT_CHOICE_IDS, type LayoutChoiceId } from './presets.ts'
import type { LayoutLimits } from './limits.ts'
import type { LayoutsLocaleKey } from './locales.ts'
import type { LayoutArea } from './model.ts'

/** One entry of the layout picker. */
export interface LayoutChoice {
  readonly id: LayoutChoiceId
  /** The label's key in {@link LAYOUTS_NS}. */
  readonly labelKey: LayoutsLocaleKey
  /** A one-line description's key, for the tooltip. */
  readonly hintKey: LayoutsLocaleKey
  /**
   * Whether the choice arranges `n` panes differently from showing them all in one row: every choice can be picked as the
   * default, but one that does not apply yet is shown dimmed.
   * @param n - the panes, the main chat included.
   * @param area - the rectangle the layout fills, if measured.
   * @param limits - the least pane size.
   * @returns true when the choice applies.
   */
  available(n: number, area?: LayoutArea, limits?: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight'>): boolean
}

const fewest: Record<LayoutChoiceId, number> = {
  'auto': 1,
  'main-stack': 2,
  'side-by-side': 2,
  'rows': 2,
  'grid': 3,
  'main-top': 2,
  'spiral': 3,
  'centred': 3,
  'mosaic': 2,
  'tabs': 2,
  'yours': 1,
}

/** Every choice of the picker, in picker order. */
export const LAYOUT_CHOICES: readonly LayoutChoice[] = LAYOUT_CHOICE_IDS.map((id): LayoutChoice => ({
  id,
  labelKey: `choice.${id}`,
  hintKey: `choice.${id}.hint`,
  available: (n, area, limits) => {
    if (n < fewest[id]) return false
    // Centred main needs room for three columns of the least width.
    if (id === 'centred' && area !== undefined && limits !== undefined) return area.width >= 3 * limits.minPaneWidth
    return true
  },
}))

/**
 * Look up a choice.
 * @param id - the choice.
 * @returns its entry.
 */
export function layoutChoice(id: LayoutChoiceId): LayoutChoice {
  return LAYOUT_CHOICES.find(choice => choice.id === id)!
}
