/**
 * The Multiview layout model: a tree of splits whose leaves hold one or more panes, independent of the library that draws
 * and drags it. A pane is one chat; its id is that chat's Session id. The tree is plain JSON, so it is the value the
 * client preference stores and the value every operation in `ops.ts` takes and returns.
 * @module @delorun/plugin-multiview/layout/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One pane. A pane shows one chat, so its id is that chat's Session id, the main chat's included. */
export type PaneId = SessionId

/**
 * How a split lays out its children: `horizontal` puts them side by side (dividers are vertical lines) and `vertical`
 * stacks them (dividers are horizontal lines). These are the library's names.
 */
export type SplitOrientation = 'horizontal' | 'vertical'

/**
 * A leaf: the panes that share one rectangle. One pane fills it; several show a tab strip (the pane header of the active one
 * takes the strip's place when there is only one).
 */
export interface LayoutLeaf {
  readonly kind: 'leaf'
  /** The panes in tab order; at least one, no pane twice in the whole layout. */
  readonly panes: readonly PaneId[]
  /** The pane shown; one of {@link LayoutLeaf.panes}. */
  readonly active: PaneId
  /** Share of the parent split, in percent. The root's is 100. */
  readonly size: number
}

/** A split: two or more children laid out along one axis. */
export interface LayoutSplit {
  readonly kind: 'split'
  readonly orientation: SplitOrientation
  /** At least two children; neighbouring splits of one orientation are merged by {@link normalizeLayout}. */
  readonly children: readonly LayoutNode[]
  /** Share of the parent split, in percent. The root's is 100. */
  readonly size: number
}

/** A node of the layout tree. */
export type LayoutNode = LayoutLeaf | LayoutSplit

/**
 * The whole arrangement. It always holds at least one pane (the main chat), because the root is a node, never empty.
 * `version` lets a later model replace this one; a saved model of another version is discarded, not migrated.
 */
export interface LayoutModel {
  readonly version: 1
  readonly root: LayoutNode
}

/** A leaf of a shape (a layout with slot numbers in place of chat ids, so it applies to any chat's agents; slot 0 is the main slot): the slots that share one rectangle, in tab order. */
export interface ShapeLeaf {
  readonly kind: 'leaf'
  readonly slots: readonly number[]
  /** The slot shown; one of {@link ShapeLeaf.slots}. */
  readonly active: number
  /** Share of the parent split, in percent. */
  readonly size: number
}

/** A split of a shape. */
export interface ShapeSplit {
  readonly kind: 'split'
  readonly orientation: SplitOrientation
  readonly children: readonly ShapeNode[]
  /** Share of the parent split, in percent. */
  readonly size: number
}

/** A node of a shape. */
export type ShapeNode = ShapeLeaf | ShapeSplit

/** A saved arrangement independent of chats. */
export interface LayoutShape {
  readonly version: 1
  readonly root: ShapeNode
}

/** A side of a pane, or `center` to join its tab strip. */
export type DropRegion = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** A side of the whole layout. */
export type LayoutEdge = 'left' | 'right' | 'top' | 'bottom'

/** Where a pane goes: beside (or into) another pane, or along an edge of the whole layout. */
export type PaneTarget =
  | { readonly kind: 'pane'; readonly pane: PaneId; readonly region: DropRegion }
  | { readonly kind: 'edge'; readonly edge: LayoutEdge }

/** The rectangle the layout fills, in CSS pixels. */
export interface LayoutArea {
  readonly width: number
  readonly height: number
}

/**
 * Build a leaf.
 * @param panes - the panes in tab order.
 * @param size - share of the parent split, in percent.
 * @param active - the pane shown; defaults to the first.
 * @returns the leaf.
 */
export function leafOf(panes: readonly PaneId[], size = 100, active: PaneId | undefined = panes[0]): LayoutLeaf {
  return { kind: 'leaf', panes, active: active !== undefined && panes.includes(active) ? active : panes[0]!, size }
}

/**
 * Build a split with equal shares for its children.
 * @param orientation - the axis the children are laid out along.
 * @param children - the children; their sizes are replaced by equal shares.
 * @param size - share of the parent split, in percent.
 * @returns the split.
 */
export function splitOf(orientation: SplitOrientation, children: readonly LayoutNode[], size = 100): LayoutSplit {
  const share = 100 / children.length
  return { kind: 'split', orientation, children: children.map(child => ({ ...child, size: share })), size }
}

/**
 * Wrap a node as a layout.
 * @param root - the root node.
 * @returns the layout, normalised.
 */
export function layoutOf(root: LayoutNode): LayoutModel {
  return { version: 1, root: normalizeNode(root, 100) }
}

/**
 * Bring a layout to its canonical form: a split's children get positive sizes summing to 100 (a missing or non-positive size
 * becomes an equal share), a split with one child is replaced by it, a split directly inside a split of the same orientation is
 * merged into it, and a leaf's active pane is one of its panes. Every operation returns a normalised layout.
 * @param model - any layout.
 * @returns the equivalent canonical layout.
 */
export function normalizeLayout(model: LayoutModel): LayoutModel {
  return { version: 1, root: normalizeNode(model.root, 100) }
}

function normalizeNode(node: LayoutNode, size: number): LayoutNode {
  if (node.kind === 'leaf') return leafOf(node.panes, size, node.active)
  const children: LayoutNode[] = []
  for (const child of node.children) {
    const normal = normalizeNode(child, child.size)
    if (normal.kind === 'split' && normal.orientation === node.orientation) {
      for (const grand of normal.children) children.push({ ...grand, size: grand.size * normal.size / 100 })
    } else {
      children.push(normal)
    }
  }
  if (children.length === 1) return { ...children[0]!, size }
  const positive = children.filter(child => child.size > 0 && Number.isFinite(child.size))
  const fallback = positive.length === 0 ? 100 / children.length : positive.reduce((sum, child) => sum + child.size, 0) / positive.length
  const raw = children.map(child => (child.size > 0 && Number.isFinite(child.size) ? child.size : fallback))
  const total = raw.reduce((sum, value) => sum + value, 0)
  return {
    kind: 'split',
    orientation: node.orientation,
    size,
    children: children.map((child, index) => ({ ...child, size: raw[index]! * 100 / total })),
  }
}

/**
 * List the panes in reading order: left to right, top to bottom, tabs in tab order.
 * @param model - the layout.
 * @returns every pane once.
 */
export function panesOf(model: LayoutModel): readonly PaneId[] {
  const out: PaneId[] = []
  const walk = (node: LayoutNode): void => {
    if (node.kind === 'leaf') out.push(...node.panes)
    else node.children.forEach(walk)
  }
  walk(model.root)
  return out
}

/**
 * Count the panes.
 * @param model - the layout.
 * @returns the number of panes, tabs included.
 */
export function paneCount(model: LayoutModel): number {
  return panesOf(model).length
}

/**
 * Report whether a pane is in the layout.
 * @param model - the layout.
 * @param pane - the pane to look for.
 * @returns true when the layout holds the pane.
 */
export function hasPane(model: LayoutModel, pane: PaneId): boolean {
  return panesOf(model).includes(pane)
}

/**
 * Describe a layout problem a typed model cannot show: a pane twice, a leaf without panes, a split with fewer than two
 * children, or a size that is not a positive number.
 * @param model - the layout to check.
 * @returns a short description of the first problem, or undefined when the layout is well formed.
 */
export function layoutProblem(model: LayoutModel): string | undefined {
  const seen = new Set<string>()
  const check = (node: LayoutNode): string | undefined => {
    if (!(node.size > 0) || !Number.isFinite(node.size)) return 'a size is not a positive number'
    if (node.kind === 'leaf') {
      if (node.panes.length === 0) return 'a leaf has no panes'
      if (!node.panes.includes(node.active)) return 'a leaf shows a pane it does not hold'
      for (const pane of node.panes) {
        if (seen.has(pane)) return 'a pane appears twice'
        seen.add(pane)
      }
      return undefined
    }
    if (node.children.length < 2) return 'a split has fewer than two children'
    for (const child of node.children) {
      const problem = check(child)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  return check(model.root)
}
