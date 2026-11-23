/**
 * Keyboard moves between panes: the pane to the left, right, above or below the focused one, and growing or shrinking the main
 * slot's share in an arrangement the person made.
 * @module @delorun/plugin-multiview/layout/focus
 */

import { placeLeaves, type Rect } from './fit.ts'
import { layoutOf, type LayoutArea, type LayoutModel, type LayoutNode, type PaneId } from './model.ts'
import { MAIN_SHARE_RANGE } from './presets.ts'

/** A direction to move focus in. */
export type FocusDirection = 'left' | 'right' | 'up' | 'down'

const centre = (rect: Rect): { x: number; y: number } => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

/**
 * Find the pane next to a pane in a direction: of the leaves wholly on that side, the one that overlaps most along the other axis,
 * then the nearest. A leaf with tabs answers with its shown pane.
 * @param model - the layout as drawn.
 * @param area - the rectangle the layout fills; any positive area gives the same answer for a layout without fixed sizes.
 * @param from - the focused pane.
 * @param direction - where to look.
 * @returns the neighbouring pane, or undefined at the layout's edge or when `from` is not in the layout.
 */
export function neighbourPane(model: LayoutModel, area: LayoutArea, from: PaneId, direction: FocusDirection): PaneId | undefined {
  const placed = placeLeaves(model, area)
  const origin = placed.find(entry => entry.leaf.panes.includes(from))
  if (origin === undefined) return undefined
  const a = origin.rect
  const horizontal = direction === 'left' || direction === 'right'
  const EPS = 0.5
  const candidates = placed.filter(entry => {
    if (entry === origin) return false
    const b = entry.rect
    switch (direction) {
      case 'left': return b.x + b.width <= a.x + EPS
      case 'right': return b.x >= a.x + a.width - EPS
      case 'up': return b.y + b.height <= a.y + EPS
      case 'down': return b.y >= a.y + a.height - EPS
      default: return false
    }
  })
  if (candidates.length === 0) return undefined
  const overlap = (b: Rect): number =>
    horizontal ? Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) : Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const gap = (b: Rect): number => {
    switch (direction) {
      case 'left': return a.x - (b.x + b.width)
      case 'right': return b.x - (a.x + a.width)
      case 'up': return a.y - (b.y + b.height)
      default: return b.y - (a.y + a.height)
    }
  }
  const origin2 = centre(a)
  const best = [...candidates].sort((left, right) => {
    const byGap = gap(left.rect) - gap(right.rect)
    if (Math.abs(byGap) > EPS) return byGap
    const byOverlap = overlap(right.rect) - overlap(left.rect)
    if (Math.abs(byOverlap) > EPS) return byOverlap
    const distance = (rect: Rect): number => Math.hypot(centre(rect).x - origin2.x, centre(rect).y - origin2.y)
    return distance(left.rect) - distance(right.rect)
  })[0]!
  return best.leaf.active
}

/**
 * Grow or shrink the leaf that holds a pane within its split by `delta` percentage points, taking the space from or giving it to
 * its siblings in proportion. The leaf keeps to {@link MAIN_SHARE_RANGE}.
 * @param model - the layout.
 * @param pane - the pane whose leaf changes size.
 * @param delta - percentage points, positive to grow.
 * @returns the new layout, or the same layout when the pane's leaf is the root or is already at the bound.
 */
export function resizePaneShare(model: LayoutModel, pane: PaneId, delta: number): LayoutModel {
  let changed = false
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node
    const index = node.children.findIndex(child => child.kind === 'leaf' && child.panes.includes(pane))
    if (index < 0) return { ...node, children: node.children.map(walk) }
    const own = node.children[index]!
    const next = Math.min(MAIN_SHARE_RANGE.max, Math.max(MAIN_SHARE_RANGE.min, own.size + delta))
    if (Math.abs(next - own.size) < 1e-9) return node
    const rest = 100 - own.size
    const scale = rest <= 0 ? 0 : (100 - next) / rest
    changed = true
    return { ...node, children: node.children.map((child, at) => ({ ...child, size: at === index ? next : child.size * scale })) }
  }
  const root = walk(model.root)
  return changed ? layoutOf(root) : model
}
