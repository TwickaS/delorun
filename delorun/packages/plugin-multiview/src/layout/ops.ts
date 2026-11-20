/**
 * Pure operations on a layout. Each takes a layout and returns a new one, or the reason it refused; none touches the DOM, so
 * the same operations serve the drag-and-drop engine, the Layout menu, the "Move to…" menu and the pin button.
 * @module @delorun/plugin-multiview/layout/ops
 */

import { capacityRefusal, type CapacityRefusal, type LayoutLimits } from './limits.ts'
import {
  hasPane,
  layoutOf,
  leafOf,
  normalizeLayout,
  paneCount,
  panesOf,
  type LayoutArea,
  type LayoutEdge,
  type LayoutModel,
  type LayoutNode,
  type PaneId,
  type PaneTarget,
  type SplitOrientation,
} from './model.ts'
import { buildPreset, DEFAULT_PRESET, MAIN_SHARE, type LayoutPreset } from './presets.ts'

/** What an operation needs to know besides the layout. */
export interface LayoutContext {
  /** The main chat's pane: it cannot be closed and presets put it first. */
  readonly main: PaneId
  /** The pane limit and the least pane size. */
  readonly limits: LayoutLimits
  /** The rectangle the layout fills; when absent only the pane limit applies. */
  readonly area?: LayoutArea
}

/** Why an operation refused. */
export type LayoutRefusal = CapacityRefusal | 'unknown-pane' | 'duplicate-pane' | 'main-pane' | 'same-pane'

/** The outcome of an operation: the new layout, or the reason nothing changed. */
export type LayoutResult =
  | { readonly ok: true; readonly model: LayoutModel }
  | { readonly ok: false; readonly reason: LayoutRefusal }

const done = (root: LayoutNode): LayoutResult => ({ ok: true, model: layoutOf(root) })
const refuse = (reason: LayoutRefusal): LayoutResult => ({ ok: false, reason })

function removeFrom(node: LayoutNode, pane: PaneId): LayoutNode | undefined {
  if (node.kind === 'leaf') {
    const index = node.panes.indexOf(pane)
    if (index < 0) return node
    const panes = node.panes.filter(candidate => candidate !== pane)
    if (panes.length === 0) return undefined
    return leafOf(panes, node.size, node.active === pane ? panes[Math.min(index, panes.length - 1)] : node.active)
  }
  const children = node.children.map(child => removeFrom(child, pane)).filter((child): child is LayoutNode => child !== undefined)
  return children.length === 0 ? undefined : { ...node, children }
}

const axisOf = (region: 'left' | 'right' | 'top' | 'bottom'): SplitOrientation => (region === 'left' || region === 'right' ? 'horizontal' : 'vertical')
const isBefore = (region: 'left' | 'right' | 'top' | 'bottom'): boolean => region === 'left' || region === 'top'

function insertAt(root: LayoutNode, pane: PaneId, target: PaneTarget): LayoutNode | undefined {
  if (target.kind === 'edge') return insertAtEdge(root, pane, target.edge)
  const place = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'split') return { ...node, children: node.children.map(place) }
    if (!node.panes.includes(target.pane)) return node
    if (target.region === 'center') return leafOf([...node.panes, pane], node.size, pane)
    const added = leafOf([pane])
    const pair = isBefore(target.region) ? [added, { ...node, size: 50 }] : [{ ...node, size: 50 }, added]
    return { kind: 'split', orientation: axisOf(target.region), children: pair.map(child => ({ ...child, size: 50 })), size: node.size }
  }
  return hasPaneIn(root, target.pane) ? place(root) : undefined
}

function hasPaneIn(node: LayoutNode, pane: PaneId): boolean {
  return node.kind === 'leaf' ? node.panes.includes(pane) : node.children.some(child => hasPaneIn(child, pane))
}

function insertAtEdge(root: LayoutNode, pane: PaneId, edge: LayoutEdge): LayoutNode {
  const orientation = axisOf(edge)
  const share = root.kind === 'split' && root.orientation === orientation ? 100 / (root.children.length + 1) : 50
  const added = { ...leafOf([pane]), size: share }
  const rest = { ...root, size: 100 - share }
  return { kind: 'split', orientation, children: isBefore(edge) ? [added, rest] : [rest, added], size: 100 }
}

/**
 * Place a new pane where a pin goes: beside the only pane; under the last pane of a two-part layout (so the main chat and one agent
 * become the main chat and a stack); inside the last column or row when it runs across the layout; otherwise as one more part of the root.
 */
function insertDefault(root: LayoutNode, pane: PaneId): LayoutNode {
  const added = leafOf([pane])
  if (root.kind === 'leaf') {
    return { kind: 'split', orientation: 'horizontal', size: 100, children: [{ ...root, size: MAIN_SHARE }, { ...added, size: 100 - MAIN_SHARE }] }
  }
  const last = root.children[root.children.length - 1]!
  const across: SplitOrientation = root.orientation === 'horizontal' ? 'vertical' : 'horizontal'
  if (last.kind === 'leaf' && root.children.length === 2) {
    const wrapped: LayoutNode = { kind: 'split', orientation: across, size: last.size, children: [{ ...last, size: 50 }, { ...added, size: 50 }] }
    return { ...root, children: [root.children[0]!, wrapped] }
  }
  if (last.kind === 'split' && last.orientation === across) {
    return { ...root, children: [...root.children.slice(0, -1), appended(last, added)] }
  }
  return appended(root, added)
}

function appended(split: LayoutNode & { kind: 'split' }, added: LayoutNode): LayoutNode {
  const share = 100 / (split.children.length + 1)
  const scale = (100 - share) / 100
  return { ...split, children: [...split.children.map(child => ({ ...child, size: child.size * scale })), { ...added, size: share }] }
}

/**
 * Add a pane. With a target the pane goes beside or into that pane, or along an edge; without one it goes where a pin goes: in the
 * last column or row, or beside the only pane.
 * @param model - the layout.
 * @param context - the main pane, the limits and the area.
 * @param pane - the pane to add.
 * @param target - where to put it.
 * @returns the new layout, or why it was refused: `duplicate-pane`, `unknown-pane` (the target pane is not in the layout), or the capacity reasons.
 */
export function addPane(model: LayoutModel, context: LayoutContext, pane: PaneId, target?: PaneTarget): LayoutResult {
  if (hasPane(model, pane)) return refuse('duplicate-pane')
  const full = capacityRefusal(paneCount(model), context.limits, context.area)
  if (full !== undefined) return refuse(full)
  if (target === undefined) return done(insertDefault(model.root, pane))
  const root = insertAt(model.root, pane, target)
  return root === undefined ? refuse('unknown-pane') : done(root)
}

/**
 * Move a pane beside or into another pane, or to an edge of the layout. Moving into the middle of a pane joins its tab strip; the
 * main chat moves like any other pane. The pane count does not change, so the limits do not apply.
 * @param model - the layout.
 * @param pane - the pane to move.
 * @param target - where it goes.
 * @returns the new layout, or why it was refused: `unknown-pane`, or `same-pane` when the target is the pane itself or it is the only pane.
 */
export function movePane(model: LayoutModel, pane: PaneId, target: PaneTarget): LayoutResult {
  if (!hasPane(model, pane) || (target.kind === 'pane' && !hasPane(model, target.pane))) return refuse('unknown-pane')
  if (paneCount(model) < 2 || (target.kind === 'pane' && target.pane === pane)) return refuse('same-pane')
  const rest = removeFrom(model.root, pane)
  if (rest === undefined) return refuse('same-pane')
  const root = insertAt(normalizeLayout({ version: 1, root: rest }).root, pane, target)
  return root === undefined ? refuse('unknown-pane') : done(root)
}

/**
 * Exchange the places of two panes. Sizes stay with the places.
 * @param model - the layout.
 * @param first - one pane.
 * @param second - the other pane.
 * @returns the new layout, or `unknown-pane` / `same-pane`.
 */
export function swapPanes(model: LayoutModel, first: PaneId, second: PaneId): LayoutResult {
  if (!hasPane(model, first) || !hasPane(model, second)) return refuse('unknown-pane')
  if (first === second) return refuse('same-pane')
  const swap = (pane: PaneId): PaneId => (pane === first ? second : pane === second ? first : pane)
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? { ...node, panes: node.panes.map(swap), active: swap(node.active) }
      : { ...node, children: node.children.map(walk) }
  return done(walk(model.root))
}

/**
 * Close a pane. The layout closes around it: the space goes to its neighbours. The main chat cannot be closed here; leaving
 * Multiview is the header button's job.
 * @param model - the layout.
 * @param context - the main pane.
 * @param pane - the pane to close.
 * @returns the new layout, or `unknown-pane` / `main-pane`.
 */
export function closePane(model: LayoutModel, context: Pick<LayoutContext, 'main'>, pane: PaneId): LayoutResult {
  if (!hasPane(model, pane)) return refuse('unknown-pane')
  if (pane === context.main) return refuse('main-pane')
  const root = removeFrom(model.root, pane)
  return root === undefined ? refuse('main-pane') : done(root)
}

/**
 * Show one tab of a leaf.
 * @param model - the layout.
 * @param pane - the pane to bring forward.
 * @returns the new layout, or `unknown-pane`.
 */
export function selectPane(model: LayoutModel, pane: PaneId): LayoutResult {
  if (!hasPane(model, pane)) return refuse('unknown-pane')
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? (node.panes.includes(pane) ? { ...node, active: pane } : node)
      : { ...node, children: node.children.map(walk) }
  return done(walk(model.root))
}

/**
 * Rearrange the panes in a preset. Nothing opens or closes; tabs become separate panes.
 * @param model - the layout.
 * @param context - the main pane.
 * @param preset - the arrangement.
 * @returns the new layout, the main chat first and the others in their reading order.
 */
export function applyPreset(model: LayoutModel, context: Pick<LayoutContext, 'main'>, preset: LayoutPreset): LayoutModel {
  return buildPreset(preset, context.main, panesOf(model).filter(pane => pane !== context.main))
}

/**
 * Go back to the default arrangement with the same panes.
 * @param model - the layout.
 * @param context - the main pane.
 * @returns the default layout.
 */
export function resetLayout(model: LayoutModel, context: Pick<LayoutContext, 'main'>): LayoutModel {
  return applyPreset(model, context, DEFAULT_PRESET)
}

/**
 * Make a layout agree with the panes that exist: drop panes that are gone and put panes the layout lacks where a pin goes.
 * The main chat is always present. The pane limit does not apply, so a saved layout restores whole and the surface decides what fits.
 * @param model - a saved or earlier layout, or undefined for none.
 * @param main - the main chat's pane.
 * @param panes - the panes that should be shown, besides the main chat, in pin order.
 * @returns a layout of exactly the main chat and those panes.
 */
export function reconcileLayout(model: LayoutModel | undefined, main: PaneId, panes: readonly PaneId[]): LayoutModel {
  const wanted = new Set<PaneId>([main, ...panes])
  let root: LayoutNode | undefined = model?.root
  for (const pane of model === undefined ? [] : panesOf(model)) {
    if (!wanted.has(pane) && root !== undefined) root = removeFrom(root, pane)
  }
  if (root === undefined) return buildPreset(DEFAULT_PRESET, main, [...new Set(panes)].filter(pane => pane !== main))
  let result = layoutOf(root)
  if (!hasPane(result, main)) result = layoutOf(insertAt(result.root, main, { kind: 'edge', edge: 'left' })!)
  for (const pane of wanted) if (!hasPane(result, pane)) result = layoutOf(insertDefault(result.root, pane))
  return result
}
