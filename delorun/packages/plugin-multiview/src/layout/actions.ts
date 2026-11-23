/**
 * The bound layout actions: the pure operations of `ops.ts` applied to the current layout and committed to the consumer.
 * @module @delorun/plugin-multiview/layout/actions
 */

import { useMemo, useRef } from 'react'
import type { LayoutLimits } from './limits.ts'
import type { LayoutArea, LayoutModel, PaneId } from './model.ts'
import { addPane, applyPreset, closePane, movePane, resetLayout, swapPanes, type LayoutContext, type LayoutResult } from './ops.ts'
import type { LayoutChangeReason, PaneLayoutActions } from './props.ts'

/** What the actions read each time one runs, so they stay valid while the layout and limits change. */
export interface ActionsState {
  readonly model: LayoutModel
  readonly context: LayoutContext
}

/**
 * Bind the operations to a state reader and a commit function.
 * @param read - returns the current layout and context.
 * @param commit - receives each accepted layout with the reason.
 * @returns the actions.
 */
export function createPaneLayoutActions(
  read: () => ActionsState,
  commit: (model: LayoutModel, reason: LayoutChangeReason) => void,
): PaneLayoutActions {
  const accept = (result: LayoutResult, reason: LayoutChangeReason): LayoutResult => {
    if (result.ok) commit(result.model, reason)
    return result
  }
  return {
    applyPreset: preset => {
      const { model, context } = read()
      commit(applyPreset(model, context, preset), 'preset')
    },
    reset: () => {
      const { model, context } = read()
      commit(resetLayout(model, context), 'reset')
    },
    add: (pane, target) => {
      const { model, context } = read()
      return accept(addPane(model, context, pane, target), 'add')
    },
    move: (pane, target) => accept(movePane(read().model, pane, target), 'move'),
    swap: (first, second) => accept(swapPanes(read().model, first, second), 'swap'),
    close: pane => {
      const { model, context } = read()
      return accept(closePane(model, context, pane), 'close')
    },
  }
}

/** The inputs of {@link usePaneLayoutActions}. */
export interface UsePaneLayoutActionsOptions {
  readonly model: LayoutModel
  readonly main: PaneId
  readonly limits: LayoutLimits
  /** The rectangle the layout fills, from the adapter's `onAreaChange`; absent until it is measured. */
  readonly area?: LayoutArea | undefined
  readonly onModelChange: (model: LayoutModel, reason: LayoutChangeReason) => void
}

/**
 * The bound actions for a control rendered outside the layout (the layout picker, the pin button). The returned object is stable
 * for the life of the component and always acts on the latest layout, limits and area.
 * @param options - the current layout, main pane, limits, area and change handler.
 * @returns the actions.
 */
export function usePaneLayoutActions(options: UsePaneLayoutActionsOptions): PaneLayoutActions {
  const latest = useRef(options)
  latest.current = options
  return useMemo(
    () =>
      createPaneLayoutActions(
        () => {
          const { model, main, limits, area } = latest.current
          return { model, context: area === undefined ? { main, limits } : { main, limits, area } }
        },
        (model, reason) => latest.current.onModelChange(model, reason),
      ),
    [],
  )
}
