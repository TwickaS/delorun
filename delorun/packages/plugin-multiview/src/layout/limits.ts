/**
 * How many panes the layout holds and how small one may get.
 * @module @delorun/plugin-multiview/layout/limits
 */

import type { LayoutArea } from './model.ts'

/** The limits the person can change in Config. */
export interface LayoutLimits {
  /** Panes at most, the main chat included. */
  readonly maxPanes: number
  /** The least width of a pane, in CSS pixels. */
  readonly minPaneWidth: number
  /** The least height of a pane, in CSS pixels. */
  readonly minPaneHeight: number
  /** The space between panes and around the layout's edge, in CSS pixels; none when absent. */
  readonly paneGap?: number | undefined
}

/** The Config default for {@link LayoutLimits.maxPanes}: the main chat and five agents. */
export const DEFAULT_MAX_PANES = 6

/** The Config default for {@link LayoutLimits.minPaneWidth}. */
export const DEFAULT_MIN_PANE_WIDTH = 340

/** The Config default for {@link LayoutLimits.minPaneHeight}. */
export const DEFAULT_MIN_PANE_HEIGHT = 240

/** The Config default for {@link LayoutLimits.paneGap}: panes edge to edge. */
export const DEFAULT_PANE_GAP = 0

/** The limits a Config with no overrides gives. */
export const DEFAULT_LAYOUT_LIMITS: LayoutLimits = {
  maxPanes: DEFAULT_MAX_PANES,
  minPaneWidth: DEFAULT_MIN_PANE_WIDTH,
  minPaneHeight: DEFAULT_MIN_PANE_HEIGHT,
  paneGap: DEFAULT_PANE_GAP,
}

/** Why a pane cannot be added. */
export type CapacityRefusal = 'max-panes' | 'no-room'

/**
 * How many panes fit: the pane limit, or fewer when the area cannot hold that many panes of the least size. One pane always fits.
 * @param limits - the limits.
 * @param area - the rectangle the layout fills; when absent only the pane limit applies.
 * @returns the most panes the layout may hold.
 */
export function paneCapacity(limits: LayoutLimits, area?: LayoutArea): number {
  const limit = Math.max(1, Math.floor(limits.maxPanes))
  if (area === undefined) return limit
  // n panes of the least size in a row take n widths and n + 1 gaps (the edges included).
  const gap = limits.paneGap ?? 0
  const columns = Math.max(1, Math.floor((area.width - gap) / (limits.minPaneWidth + gap)))
  const rows = Math.max(1, Math.floor((area.height - gap) / (limits.minPaneHeight + gap)))
  return Math.min(limit, columns * rows)
}

/**
 * Decide whether one more pane may be added.
 * @param count - the panes now in the layout.
 * @param limits - the limits.
 * @param area - the rectangle the layout fills; when absent only the pane limit applies.
 * @returns undefined when a pane fits, otherwise why it does not: the limit comes first.
 */
export function capacityRefusal(count: number, limits: LayoutLimits, area?: LayoutArea): CapacityRefusal | undefined {
  if (count >= Math.max(1, Math.floor(limits.maxPanes))) return 'max-panes'
  if (count >= paneCapacity(limits, area)) return 'no-room'
  return undefined
}
