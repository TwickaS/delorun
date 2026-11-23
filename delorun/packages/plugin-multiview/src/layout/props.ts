/**
 * The adapter's contract with the lanes that render panes and menus: what {@link PaneLayout} takes, what it hands each pane header,
 * and the bound actions every menu calls. The engine behind it (drag-and-drop, dividers, keyboard resizing) is private to the
 * adapter and can change without touching these types.
 * @module @delorun/plugin-multiview/layout/props
 */

import type { ReactNode } from 'react'
import type { LayoutLimits } from './limits.ts'
import type { LayoutArea, LayoutModel, PaneId, PaneTarget } from './model.ts'
import type { LayoutResult, MoveOption } from './ops.ts'
import type { LayoutPreset } from './presets.ts'

/** Why the layout changed, for the consumer's own bookkeeping (what to persist, whether to refocus). */
export type LayoutChangeReason =
  | 'preset'
  | 'reset'
  | 'add'
  | 'move'
  | 'swap'
  | 'close'
  | 'select'
  | 'resize'

/**
 * Bound operations. Each applies the pure operation in `ops.ts` to the current layout, passes an accepted result to `onModelChange`
 * and returns the result so the caller can say why a refusal happened (the pin button shows `max-panes` and `no-room`).
 */
export interface PaneLayoutActions {
  /** Rearrange the panes in a preset; nothing opens or closes. */
  applyPreset(preset: LayoutPreset): void
  /** Go back to the default arrangement with the same panes. */
  reset(): void
  /** Add a pane where a pin goes, or at `target`; refused at the limit. */
  add(pane: PaneId, target?: PaneTarget): LayoutResult
  /** Move a pane beside or into another pane, or to an edge of the layout; the main chat moves like any other. */
  move(pane: PaneId, target: PaneTarget): LayoutResult
  /** Exchange the places of two panes. */
  swap(first: PaneId, second: PaneId): LayoutResult
  /** Close a pane; refused for the main chat. */
  close(pane: PaneId): LayoutResult
}

/** What a pane header and body know about their pane. */
export interface PaneState {
  /** The main chat's pane. */
  readonly isMain: boolean
  /** The pane holds keyboard focus. */
  readonly focused: boolean
  /** The pane is the shown tab of its leaf (its body is mounted and visible). */
  readonly selected: boolean
  /** How many panes share this pane's leaf; more than one means a tab strip. */
  readonly leafSize: number
  /** The number of panes in the whole layout. */
  readonly paneTotal: number
}

/** What {@link PaneLayoutProps.renderHeader} gets to build the pane header from. */
export interface PaneHeaderControls {
  /**
   * The grip: drag the pane by it onto an edge of another pane to split there, or onto the middle to join its tabs. Render it
   * once inside the header; it is an element with a keyboard route and a touch-sized hit area.
   */
  readonly grip: ReactNode
  /** The bound actions, for the header's Swap, Move to… and Close buttons. */
  readonly actions: PaneLayoutActions
  /** The other panes this pane can swap places with, in reading order. */
  readonly swapCandidates: readonly PaneId[]
  /** Where this pane can go, for a "Move to…" menu: the keyboard route to what dragging the grip does. */
  readonly moveOptions: readonly MoveOption[]
  /** Whether Close is offered: false for the main chat. */
  readonly canClose: boolean
}

/** The adapter's words, so every string reaches the person through a locale dictionary. */
export interface PaneLayoutLabels {
  /** Names a divider for assistive technology, for example "Resize panes". */
  readonly separator: string
  /** Names the layout region, for example "Multiview". */
  readonly region: string
  /** Names the tab strip of a leaf with several panes. */
  readonly tabList: string
  /** Names the grip a pane is dragged by, for example "Move pane". */
  readonly grip: string
}

/** What the adapter takes. The layout is controlled: the consumer owns `model` and the adapter reports changes. */
export interface PaneLayoutProps {
  /** The layout to show. Replacing it with a different value re-lays out the panes; the same value is a no-op. */
  readonly model: LayoutModel
  /** The main chat's pane. */
  readonly main: PaneId
  /** The pane limit and the least pane size. */
  readonly limits: LayoutLimits
  /**
   * Called with every accepted change: a drop, a divider drag or arrow key, a tab selection, or an action.
   * @param model - the new layout.
   * @param reason - what changed it.
   */
  readonly onModelChange: (model: LayoutModel, reason: LayoutChangeReason) => void
  /**
   * Render a pane's body. Called once per pane; a pane keeps its DOM when it moves, so a chat inside does not remount.
   * @param pane - the pane.
   * @param state - what the pane knows about itself.
   */
  readonly renderPane: (pane: PaneId, state: PaneState) => ReactNode
  /**
   * Render a pane's header, the strip above its body.
   * @param pane - the pane.
   * @param state - what the pane knows about itself.
   * @param controls - the grip and the actions to build the header from.
   */
  readonly renderHeader: (pane: PaneId, state: PaneState, controls: PaneHeaderControls) => ReactNode
  /**
   * Render a pane's tab label, used when several panes share a leaf.
   * @param pane - the pane.
   */
  readonly renderTab: (pane: PaneId) => ReactNode
  /** The pane that holds keyboard focus, if any; it is passed to its body and header as {@link PaneState.focused}. */
  readonly focusedPane?: PaneId | undefined
  /**
   * Called when a pane takes focus by pointer or keyboard.
   * @param pane - the pane.
   */
  readonly onFocusPane?: ((pane: PaneId) => void) | undefined
  /**
   * Called when the rectangle the layout fills changes, so the pin button can say "screen full".
   * @param area - the new size.
   */
  readonly onAreaChange?: ((area: LayoutArea) => void) | undefined
  /** The adapter's words. */
  readonly labels: PaneLayoutLabels
  /** A class for the layout's root element. */
  readonly className?: string | undefined
  /**
   * Whether a layout replaced through `model` glides to its new places (transforms only, under 300 ms, interruptible). It never
   * animates with reduced motion, and a change the person made by dragging is already in place, so it does not move again.
   */
  readonly animate?: boolean | undefined
}
