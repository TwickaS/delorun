/**
 * Dragging a chat row in the cards view, with pointer events alone: a press that moves six pixels starts a drag, the
 * row under the pointer decides where a drop lands (T3 Code's drop rules, in `sections.ts`), the list scrolls while the
 * pointer rests near its edge, and the release drops. Touch presses scroll the list instead and never drag; every drop
 * is also reachable from the row's buttons and menu.
 * @module @delo/plugin-sidebar/client/drag
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import {
  sidebarDropTarget, sidebarDropVerb, type SidebarDropTarget, type SidebarDropVerb, type SidebarListItem, type SidebarSection,
} from './sections.ts'

/** How far the pointer moves before a press becomes a drag, T3 Code's distance; a shorter press is a click. */
export const DRAG_DISTANCE = 6

/** How close to the list's top or bottom edge the pointer must rest for the list to scroll, in pixels. */
export const SCROLL_EDGE = 40

/** How far the list scrolls on each 16 ms step at the edge itself. */
export const SCROLL_STEP = 14

/** The chat being dragged and what dropping it where the pointer is would do. */
export interface DragView {
  readonly id: SessionId
  readonly section: SidebarSection
  /** The drag id of the entry under the pointer, or null over nothing. */
  readonly overId: string | null
  /** Where the chat would land, or null where it cannot. */
  readonly target: SidebarDropTarget | null
  /** What dropping does, or null where it does nothing. */
  readonly verb: SidebarDropVerb | null
}

/** What the drag hook reads and does. */
export interface ListDragOptions {
  /** Whether rows can be dragged now. */
  readonly enabled: boolean
  /** The list in its drawn order. */
  readonly items: readonly SidebarListItem[]
  /** The list's scroll box, which scrolls while the pointer rests near its edge. */
  readonly scroller: RefObject<HTMLElement | null>
  /**
   * Apply a drop.
   * @param dragged - the chat and the section it was dragged from.
   * @param target - where it landed.
   */
  readonly onDrop: (dragged: { readonly id: SessionId; readonly section: SidebarSection }, target: SidebarDropTarget) => void
}

/** What the drag hook returns. */
export interface ListDrag {
  /** The drag in progress, or null. */
  readonly view: DragView | null
  /**
   * The press handler for one row.
   * @param id - the row's chat.
   * @param section - the section the row sits in.
   * @returns the handler to put on the row.
   */
  readonly press: (id: SessionId, section: SidebarSection) => (event: PointerEvent<HTMLElement>) => void
  /**
   * Whether a drop just ended, so the click that follows the release over a row must not open it.
   * @returns true until the next task.
   */
  readonly justDropped: () => boolean
}

/** Buttons, links and fields inside a row keep their own presses. */
const OWN_PRESS = 'button, a, input, [role="menuitem"]'

/**
 * Track a drag over the list. At most one drag runs; unmounting or turning `enabled` off ends it without a drop.
 * @param options - whether rows drag, the list in its drawn order, its scroll box and the drop.
 * @returns the drag in progress, the press handler for a row and the click guard.
 */
export function useListDrag(options: ListDragOptions): ListDrag {
  const [view, setView] = useState<DragView | null>(null)
  const latest = useRef(options)
  latest.current = options
  const stop = useRef<(() => void) | null>(null)
  const dropped = useRef(false)

  useEffect(() => () => { stop.current?.() }, [])
  useEffect(() => { if (!options.enabled) stop.current?.() }, [options.enabled])

  const press = useCallback((id: SessionId, section: SidebarSection) => (event: PointerEvent<HTMLElement>): void => {
    if (!latest.current.enabled || event.button !== 0 || event.pointerType === 'touch') return
    if (event.target instanceof Element && event.target.closest(OWN_PRESS) !== null) return
    stop.current?.()
    const origin = { x: event.clientX, y: event.clientY }
    let pointerY = origin.y
    let active: DragView | null = null
    let timer: ReturnType<typeof setInterval> | undefined

    const scroll = (): void => {
      const box = latest.current.scroller.current
      if (box === null) return
      const rect = box.getBoundingClientRect()
      if (pointerY < rect.top + SCROLL_EDGE) box.scrollTop -= SCROLL_STEP * Math.min(1, (rect.top + SCROLL_EDGE - pointerY) / SCROLL_EDGE)
      else if (pointerY > rect.bottom - SCROLL_EDGE) box.scrollTop += SCROLL_STEP * Math.min(1, (pointerY - rect.bottom + SCROLL_EDGE) / SCROLL_EDGE)
    }
    const move = (moved: globalThis.PointerEvent): void => {
      pointerY = moved.clientY
      if (active === null && Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < DRAG_DISTANCE) return
      const overId = document.elementFromPoint(moved.clientX, moved.clientY)?.closest<HTMLElement>('[data-drag-id]')?.dataset.dragId ?? null
      const target = overId === null ? null : sidebarDropTarget(latest.current.items, id, overId)
      active = { id, section, overId, target, verb: sidebarDropVerb(section, target?.section ?? null) }
      setView(active)
      timer ??= setInterval(scroll, 16)
    }
    const finish = (drop: boolean): void => {
      stop.current?.()
      const done = active
      if (done === null) return
      dropped.current = true
      setTimeout(() => { dropped.current = false }, 0)
      if (drop && done.target !== null) latest.current.onDrop({ id, section }, done.target)
    }
    const release = (): void => { finish(true) }
    const cancel = (): void => { finish(false) }
    const escape = (key: globalThis.KeyboardEvent): void => { if (key.key === 'Escape') finish(false) }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape)
      clearInterval(timer)
      stop.current = null
      setView(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape)
    stop.current = end
  }, [])

  return { view, press, justDropped: () => dropped.current }
}
