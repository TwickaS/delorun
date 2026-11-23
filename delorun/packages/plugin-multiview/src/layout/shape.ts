/**
 * A layout as a shape: the same tree with slot numbers in place of chat ids, so a person's own arrangement ("Yours") applies to
 * any chat's agents. Slot 0 is the main slot and slot `i` the `i`-th other pane in slot order (pin order unless swapped).
 * @module @delorun/plugin-multiview/layout/shape
 */

import { layoutOf, layoutProblem, panesOf, type LayoutModel, type LayoutNode, type LayoutShape, type PaneId, type ShapeNode } from './model.ts'
import { reconcileLayout } from './ops.ts'

export type { LayoutShape, ShapeLeaf, ShapeNode, ShapeSplit } from './model.ts'

/**
 * Turn a layout into a shape.
 * @param model - the layout.
 * @param slots - the panes in slot order, the main slot first; a pane of the layout missing from it takes the next free slot.
 * @returns the shape.
 */
export function shapeOf(model: LayoutModel, slots: readonly PaneId[]): LayoutShape {
  const order = [...slots]
  for (const pane of panesOf(model)) if (!order.includes(pane)) order.push(pane)
  const slotOf = (pane: PaneId): number => order.indexOf(pane)
  const walk = (node: LayoutNode): ShapeNode =>
    node.kind === 'leaf'
      ? { kind: 'leaf', slots: node.panes.map(slotOf), active: slotOf(node.active), size: node.size }
      : { kind: 'split', orientation: node.orientation, children: node.children.map(walk), size: node.size }
  return { version: 1, root: walk(model.root) }
}

/**
 * Apply a shape to panes. Slots without a pane close up around their neighbours; panes beyond the shape's slots go where a pin
 * goes. Nothing opens or closes: the layout holds exactly `main` and `others`.
 * @param shape - the shape.
 * @param main - the pane for slot 0.
 * @param others - the panes for slots 1, 2, … in order.
 * @returns the layout.
 */
export function applyShape(shape: LayoutShape, main: PaneId, others: readonly PaneId[]): LayoutModel {
  const panes = [main, ...others]
  const walk = (node: ShapeNode): LayoutNode | undefined => {
    if (node.kind === 'leaf') {
      const present = node.slots.filter(slot => slot >= 0 && slot < panes.length).map(slot => panes[slot]!)
      if (present.length === 0) return undefined
      const active = panes[node.active]
      return { kind: 'leaf', panes: present, active: active !== undefined && present.includes(active) ? active : present[0]!, size: node.size }
    }
    const children = node.children.map(walk).filter((child): child is LayoutNode => child !== undefined)
    if (children.length === 0) return undefined
    return { kind: 'split', orientation: node.orientation, children, size: node.size }
  }
  const root = walk(shape.root)
  return reconcileLayout(root === undefined ? undefined : layoutOf(root), main, others)
}

/**
 * Describe a problem with a shape read from storage: a slot twice, a negative slot, an active slot its leaf lacks, or what
 * {@link layoutProblem} finds in the equivalent layout.
 * @param shape - the shape.
 * @returns the first problem, or undefined when it is well formed.
 */
export function shapeProblem(shape: LayoutShape): string | undefined {
  const seen = new Set<number>()
  const check = (node: ShapeNode): string | undefined => {
    if (node.kind === 'leaf') {
      for (const slot of node.slots) {
        if (!Number.isInteger(slot) || slot < 0) return 'a slot is not a whole number'
        if (seen.has(slot)) return 'a slot appears twice'
        seen.add(slot)
      }
      return undefined
    }
    for (const child of node.children) {
      const problem = check(child)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  const problem = check(shape.root)
  if (problem !== undefined) return problem
  const asLayout = (node: ShapeNode): LayoutNode =>
    node.kind === 'leaf'
      ? { kind: 'leaf', panes: node.slots.map(slot => String(slot) as PaneId), active: String(node.active) as PaneId, size: node.size }
      : { kind: 'split', orientation: node.orientation, children: node.children.map(asLayout), size: node.size }
  return layoutProblem({ version: 1, root: asLayout(shape.root) })
}
