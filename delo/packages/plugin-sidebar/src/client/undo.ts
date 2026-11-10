/**
 * The sidebar's undo line: the last change the person can take back, shared
 * by the chat list that makes it and the foot's undo notice that offers it,
 * as T3 Code's sidebar footer does.
 * @module @delo/plugin-sidebar/client/undo
 */

/** What a change was, named in the notice. */
export type UndoKind = 'settle' | 'unsettle' | 'snooze' | 'pin' | 'unpin' | 'wake'

/** The last change and how to take it back. */
export interface UndoEntry {
  readonly kind: UndoKind
  /** Distinguishes one change from the next of the same kind. */
  readonly key: number
  readonly undo: () => void
}

/** The undo line's state. */
export interface UndoLine {
  getSnapshot(): UndoEntry | null
  subscribe(listener: () => void): () => void
  /**
   * Offer a change to take back, or clear the offer.
   * @param entry - the change, or null.
   */
  set(entry: UndoEntry | null): void
}

/**
 * A new, empty undo line.
 * @returns the line.
 */
export function createUndoLine(): UndoLine {
  let entry: UndoEntry | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => entry,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      entry = next
      for (const listener of listeners) listener()
    },
  }
}
