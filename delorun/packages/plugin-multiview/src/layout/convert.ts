/**
 * Conversion between the layout model and the library's workspace model. The library model is private to the adapter: the
 * layout model is what is stored and what the other lanes see, so the engine can be replaced without a storage change.
 * @module @delorun/plugin-multiview/layout/convert
 */

import type { WorkspaceModelInput, WorkspaceModel, WorkspaceNode, WorkspaceNodeInput } from 'react-resizable-panels'
import { layoutOf, leafOf, type LayoutModel, type LayoutNode, type PaneId } from './model.ts'

/** Application data on each library tab: nothing, because a tab's id is its pane. */
export type PaneTabData = null

function toNode(node: LayoutNode): WorkspaceNodeInput<PaneTabData> {
  if (node.kind === 'split') {
    return { type: 'split', orientation: node.orientation, size: node.size, children: node.children.map(toNode) }
  }
  return {
    type: 'tabset',
    id: `leaf:${node.panes[0]}`,
    size: node.size,
    selectedId: node.active,
    // A tab is never closed by the library: Close is the pane header's action, so the model's rules (the main chat stays) apply.
    tabs: node.panes.map(pane => ({ id: pane, title: pane, data: null, disableClose: true })),
  }
}

/**
 * Convert a layout to the library's model.
 * @param model - the layout.
 * @returns the library's model, one tabset per leaf and one tab per pane.
 */
export function toWorkspaceModel(model: LayoutModel): WorkspaceModelInput<PaneTabData> {
  return { version: 1, root: toNode(model.root) }
}

function fromNode(node: WorkspaceNode<PaneTabData>): LayoutNode | undefined {
  if (node.type === 'split') {
    const children = node.children.map(fromNode).filter((child): child is LayoutNode => child !== undefined)
    if (children.length === 0) return undefined
    return { kind: 'split', orientation: node.orientation, size: sizeOf(node.size), children }
  }
  const panes = node.tabs.map(tab => tab.id as PaneId)
  if (panes.length === 0) return undefined
  return leafOf(panes, sizeOf(node.size), node.selectedId as PaneId | undefined)
}

// The library stores sizes as percentages (a number) or with a unit (a string, only until the first resize). A size without a
// percentage is left to the normaliser, which gives the child an equal share.
function sizeOf(size: number | string | undefined): number {
  return typeof size === 'number' ? size : 0
}

/**
 * Convert the library's model back to a layout. Floating tabsets, collapsed and maximised state are not part of Multiview and are ignored.
 * @param model - the library's model.
 * @returns the layout in canonical form, or undefined when the model holds no pane.
 */
export function fromWorkspaceModel(model: WorkspaceModel<PaneTabData>): LayoutModel | undefined {
  const root = fromNode(model.root)
  return root === undefined ? undefined : layoutOf(root)
}
