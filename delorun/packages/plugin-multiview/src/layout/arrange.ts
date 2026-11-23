/**
 * What a chat's Multiview shows: the arrangement a chat follows (a preset, its own copy of "Yours", or a layout saved before
 * presets were remembered), drawn for its panes, its area and its least pane size.
 * @module @delorun/plugin-multiview/layout/arrange
 */

import { fitToMinimums } from './fit.ts'
import type { LayoutLimits } from './limits.ts'
import { layoutOf, type LayoutModel, type LayoutNode, type PaneId } from './model.ts'
import { reconcileLayout } from './ops.ts'
import { buildPreset, isLayoutPreset, LAYOUT_CHOICE_IDS, type LayoutChoiceId, type PresetOptions } from './presets.ts'
import { applyShape, type LayoutShape } from './shape.ts'

/** What a chat follows: a choice, or `custom` for a layout saved before choices were remembered. */
export type ChatArrangement = LayoutChoiceId | 'custom'

/**
 * Report whether a value names a choice.
 * @param value - any value.
 * @returns true for one of {@link LAYOUT_CHOICE_IDS}.
 */
export function isLayoutChoice(value: unknown): value is LayoutChoiceId {
  return value === 'yours' || (isLayoutPreset(value) && value !== 'main-column')
}

/** The inputs of {@link arrangeLayout}. */
export interface ArrangeInput {
  /** What the chat follows. */
  readonly arrangement: ChatArrangement
  /** The panes in slot order: the main slot first. Every pane shown is here. */
  readonly slots: readonly PaneId[]
  /** The chat's last arrangement, for `custom` and to keep the shown tab of each leaf. */
  readonly stored?: LayoutModel | undefined
  /** The chat's copy of "Yours", for `yours`; without one `yours` shows Auto. */
  readonly shape?: LayoutShape | undefined
  /** The person's options, the area and the activity. */
  readonly options: PresetOptions
  /** The least pane size. */
  readonly limits: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight'>
}

/**
 * Draw a chat's arrangement: build it for the panes, keep the tab each leaf showed before, then turn panes that would be under
 * the least size into tabs.
 * @param input - the arrangement, the panes, the stored layout, the shape, the options and the limits.
 * @returns the layout to show. It holds exactly the panes of `input.slots`.
 */
export function arrangeLayout(input: ArrangeInput): LayoutModel {
  const [main, ...others] = input.slots
  if (main === undefined) throw new Error('arrangeLayout needs at least the main slot')
  const built = buildArrangement(input.arrangement, main, others, input)
  return fitToMinimums(keepShownTabs(built, input.stored), input.limits, input.options.area)
}

function buildArrangement(arrangement: ChatArrangement, main: PaneId, others: readonly PaneId[], input: ArrangeInput): LayoutModel {
  switch (arrangement) {
    case 'custom':
      return reconcileLayout(input.stored, main, others)
    case 'yours':
      return input.shape === undefined ? buildPreset('auto', main, others, input.options) : applyShape(input.shape, main, others)
    default:
      return buildPreset(arrangement, main, others, input.options)
  }
}

/**
 * Keep the tab each leaf showed: where a leaf of `next` holds the pane a leaf of `previous` showed, that pane stays shown.
 * @param next - the new layout.
 * @param previous - the layout before, if any.
 * @returns `next` with the shown tabs carried over.
 */
export function keepShownTabs(next: LayoutModel, previous: LayoutModel | undefined): LayoutModel {
  if (previous === undefined) return next
  const shown = new Set<PaneId>()
  const collect = (node: LayoutNode): void => {
    if (node.kind === 'leaf') {
      if (node.panes.length > 1) shown.add(node.active)
    } else {
      node.children.forEach(collect)
    }
  }
  collect(previous.root)
  if (shown.size === 0) return next
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(walk) }
    const keep = node.panes.find(pane => shown.has(pane))
    return keep === undefined ? node : { ...node, active: keep }
  }
  return layoutOf(walk(next.root))
}

/**
 * The next or previous choice for the layout keys, skipping `yours` when there is no saved arrangement.
 * @param current - the choice now shown; `custom` counts as before the first.
 * @param step - 1 for next, -1 for previous.
 * @param hasYours - whether "Yours" is saved.
 * @returns the choice to show.
 */
export function cycleChoice(current: ChatArrangement, step: 1 | -1, hasYours: boolean): LayoutChoiceId {
  const ring = LAYOUT_CHOICE_IDS.filter(id => id !== 'yours' || hasYours)
  const at = current === 'custom' ? -1 : ring.indexOf(current)
  if (at < 0) return step === 1 ? ring[0]! : ring[ring.length - 1]!
  return ring[(at + step + ring.length) % ring.length]!
}

/**
 * The panes in slot order: the saved order kept for panes that remain, the main chat first when no order is saved, and new pins
 * appended in pin order.
 * @param saved - the chat's saved slot order, if any.
 * @param main - the main chat.
 * @param pins - the pins in pin order.
 * @returns every pane once: the main chat and the pins.
 */
export function slotOrder(saved: readonly PaneId[] | undefined, main: PaneId, pins: readonly PaneId[]): readonly PaneId[] {
  const wanted = new Set<PaneId>([main, ...pins])
  const order = (saved ?? []).filter(pane => wanted.has(pane))
  const seen = new Set(order)
  for (const pane of [main, ...pins]) {
    if (!seen.has(pane)) {
      order.push(pane)
      seen.add(pane)
    }
  }
  return order
}
