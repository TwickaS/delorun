/**
 * Telling a drag of the main chat's divider from the person rearranging panes: in the layouts with a main share, a change that
 * only moves the root split's dividers is a new main share, which every chat remembers; anything else is the person's own
 * arrangement.
 * @module @delorun/plugin-multiview/layout/share
 */

import type { ChatArrangement } from './arrange.ts'
import type { LayoutModel, LayoutNode, PaneId } from './model.ts'
import { autoChoice, CENTRED_SHARE, MAIN_SHARE, type LayoutPreset, type PresetOptions } from './presets.ts'

/** The layouts whose root split holds the main slot beside the rest at a share the person can drag. */
const SHARE_LAYOUTS: ReadonlySet<LayoutPreset> = new Set<LayoutPreset>(['main-stack', 'main-top', 'centred'])

/**
 * The preset a chat's arrangement draws now: Auto's own choice for the pane count and area, or the arrangement itself.
 * @param arrangement - what the chat follows.
 * @param count - the panes, the main chat included.
 * @param options - the area, the limits and Auto's column count.
 * @returns the preset drawn, or undefined for `yours` and `custom`.
 */
export function drawnPreset(arrangement: ChatArrangement, count: number, options: Pick<PresetOptions, 'area' | 'limits' | 'autoColumns'>): LayoutPreset | undefined {
  if (arrangement === 'yours' || arrangement === 'custom') return undefined
  return arrangement === 'auto' ? autoChoice(count, options) : arrangement
}

const structure = (node: LayoutNode): unknown =>
  node.kind === 'leaf' ? { panes: node.panes } : { orientation: node.orientation, children: node.children.map(structure) }

/**
 * Read a new main share from a divider drag.
 * @param before - the layout as drawn.
 * @param after - the layout the person left.
 * @param preset - the preset drawn, from {@link drawnPreset}.
 * @param main - the pane in the main slot.
 * @returns the main share to remember, in percent, when the change only moved the root split's dividers in a layout with a main
 * share; undefined when it is the person's own arrangement.
 */
export function mainShareFromDrag(before: LayoutModel, after: LayoutModel, preset: LayoutPreset | undefined, main: PaneId): number | undefined {
  if (preset === undefined || !SHARE_LAYOUTS.has(preset)) return undefined
  if (JSON.stringify(structure(before.root)) !== JSON.stringify(structure(after.root))) return undefined
  if (before.root.kind !== 'split' || after.root.kind !== 'split') return undefined
  const innerSame = before.root.children.every((child, index) => sameInnerSizes(child, after.root.kind === 'split' ? after.root.children[index]! : child))
  if (!innerSame) return undefined
  const leaf = after.root.children.find(child => child.kind === 'leaf' && child.panes.includes(main))
  if (leaf === undefined) return undefined
  return preset === 'centred' ? leaf.size - CENTRED_SHARE + MAIN_SHARE : leaf.size
}

function sameInnerSizes(left: LayoutNode, right: LayoutNode): boolean {
  if (left.kind === 'leaf' || right.kind === 'leaf') return left.kind === right.kind
  return left.children.length === right.children.length
    && left.children.every((child, index) => Math.abs(child.size - right.children[index]!.size) < 0.5 && sameInnerSizes(child, right.children[index]!))
}
