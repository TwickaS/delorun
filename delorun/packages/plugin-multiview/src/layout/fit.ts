/**
 * The geometry of a layout in an area, and the pass that keeps every pane at or above the least pane size by turning panes that
 * would be smaller into tabs of their nearest neighbour. Nothing is hidden: a pane that does not fit is still one tab away.
 * @module @delorun/plugin-multiview/layout/fit
 */

import type { LayoutLimits } from './limits.ts'
import { layoutOf, leafOf, type LayoutArea, type LayoutLeaf, type LayoutModel, type LayoutNode, type PaneId } from './model.ts'

/** A rectangle in CSS pixels, from the layout's top-left corner. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A leaf with the rectangle it fills. */
export interface PlacedLeaf {
  readonly leaf: LayoutLeaf
  readonly rect: Rect
}

/**
 * Place every leaf of a layout in an area. With a gap the leaves keep that space between them and from the area's edge, and each
 * split's sizes share what its gaps leave; without one the rectangles tile the area exactly.
 * @param model - the layout.
 * @param area - the rectangle the layout fills.
 * @param gap - the space between leaves and around the edge, in pixels.
 * @returns the leaves in reading order with their rectangles.
 */
export function placeLeaves(model: LayoutModel, area: LayoutArea, gap = 0): readonly PlacedLeaf[] {
  const out: PlacedLeaf[] = []
  const walk = (node: LayoutNode, rect: Rect): void => {
    if (node.kind === 'leaf') {
      out.push({ leaf: node, rect })
      return
    }
    const horizontal = node.orientation === 'horizontal'
    const free = Math.max(0, (horizontal ? rect.width : rect.height) - gap * (node.children.length - 1))
    let offset = 0
    for (const child of node.children) {
      const extent = free * (child.size / 100)
      const childRect: Rect = horizontal
        ? { x: rect.x + offset, y: rect.y, width: extent, height: rect.height }
        : { x: rect.x, y: rect.y + offset, width: rect.width, height: extent }
      offset += extent + gap
      walk(child, childRect)
    }
  }
  walk(model.root, { x: gap, y: gap, width: Math.max(0, area.width - 2 * gap), height: Math.max(0, area.height - 2 * gap) })
  return out
}

/**
 * The rectangle of the leaf that holds a pane.
 * @param model - the layout.
 * @param area - the rectangle the layout fills.
 * @param pane - the pane.
 * @returns its leaf's rectangle, or undefined when the layout does not hold it.
 */
export function rectOf(model: LayoutModel, area: LayoutArea, pane: PaneId): Rect | undefined {
  return placeLeaves(model, area).find(placed => placed.leaf.panes.includes(pane))?.rect
}

// A pixel of tolerance, so a rounding error in the shares never turns a pane that fits into a tab.
const SLACK = 0.5

const tooSmall = (rect: Rect, limits: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight'>): boolean =>
  rect.width + SLACK < limits.minPaneWidth || rect.height + SLACK < limits.minPaneHeight

/** Remove a leaf from its split and add its panes as tabs to its nearest sibling's nearest leaf; that leaf's shown pane stays shown. */
function mergeInto(node: LayoutNode, target: LayoutLeaf): LayoutNode | undefined {
  if (node.kind === 'leaf') return node === target ? undefined : node
  const index = node.children.indexOf(target)
  if (index < 0) {
    const children = node.children.map(child => mergeInto(child, target))
    return { ...node, children: children.filter((child): child is LayoutNode => child !== undefined) }
  }
  const before = index > 0
  const neighbourIndex = before ? index - 1 : index + 1
  const neighbour = node.children[neighbourIndex]!
  const joined = joinTabs(neighbour, target.panes, before)
  // The space the leaf leaves goes to every sibling in proportion, so equal parts stay equal and fit more often.
  const scale = 100 / (100 - target.size)
  const children = node.children.flatMap((child, at) => (at === index ? [] : [{ ...(at === neighbourIndex ? joined : child), size: child.size * scale }]))
  return { ...node, children }
}

/** Add panes as tabs to the leaf of `node` nearest the side they come from: its last leaf when they came after it, its first otherwise. */
function joinTabs(node: LayoutNode, panes: readonly PaneId[], fromAfter: boolean): LayoutNode {
  if (node.kind === 'leaf') return leafOf([...node.panes, ...panes], node.size, node.active)
  const at = fromAfter ? node.children.length - 1 : 0
  return { ...node, children: node.children.map((child, index) => (index === at ? joinTabs(child, panes, fromAfter) : child)) }
}

/** Find the parent split of a leaf, so the merge acts on its siblings. */
function containsLeafAsChild(node: LayoutNode, leaf: LayoutLeaf): boolean {
  return node.kind === 'split' && node.children.includes(leaf)
}

/**
 * Keep every pane at or above the least size: while a leaf is smaller than `minPaneWidth` × `minPaneHeight` in the area, the
 * smallest such leaf joins its nearest sibling as tabs (the sibling before it, else the one after; inside a sibling split, the
 * leaf on the side it touches). The pane count does not change and no pane is hidden. A layout of one leaf is left as it is.
 * @param model - the layout.
 * @param limits - the least pane size and the space between panes.
 * @param area - the rectangle the layout fills; without one the layout is returned unchanged.
 * @returns the layout, every leaf of which fits.
 */
export function fitToMinimums(model: LayoutModel, limits: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight' | 'paneGap'>, area: LayoutArea | undefined): LayoutModel {
  if (area === undefined || area.width <= 0 || area.height <= 0) return model
  let current = model
  // Each round removes one leaf, so the loop ends after at most one round per leaf.
  for (;;) {
    const placed = placeLeaves(current, area, limits.paneGap ?? 0)
    if (placed.length < 2) return current
    const small = placed.filter(entry => tooSmall(entry.rect, limits))
    if (small.length === 0) return current
    // Of the leaves that are too small, the smallest goes first; on a tie the later one, so the newest panes become tabs first.
    const smallest = small.reduce((least, entry) => (entry.rect.width * entry.rect.height <= least.rect.width * least.rect.height + SLACK ? entry : least))
    const root = mergeInto(current.root, smallest.leaf)
    if (root === undefined || !hasSplitParent(current.root, smallest.leaf)) return current
    current = layoutOf(root)
  }
}

function hasSplitParent(node: LayoutNode, leaf: LayoutLeaf): boolean {
  if (containsLeafAsChild(node, leaf)) return true
  return node.kind === 'split' && node.children.some(child => hasSplitParent(child, leaf))
}

/**
 * Report whether every pane of a layout gets at least the least size in an area.
 * @param model - the layout.
 * @param limits - the least pane size and the space between panes.
 * @param area - the rectangle the layout fills.
 * @returns true when no leaf is smaller than the least size, or the layout is a single leaf.
 */
export function fitsMinimums(model: LayoutModel, limits: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight' | 'paneGap'>, area: LayoutArea): boolean {
  const placed = placeLeaves(model, area, limits.paneGap ?? 0)
  return placed.length < 2 || placed.every(entry => !tooSmall(entry.rect, limits))
}
