/**
 * Whether the screen has no hover or a coarse primary pointer, where a row's Snooze and Settle buttons give way to its
 * "..." menu: the buttons are too small for a finger and a row cannot show them on hover.
 * @module @delo/plugin-sidebar/client/pointer
 */
import { useSyncExternalStore } from 'react'

/** The media query the row's stylesheet answers to for hoverless and coarse screens. */
export const TOUCH_QUERY = '(hover: none), (pointer: coarse)'

/**
 * Whether the screen is hoverless or coarse now.
 * @returns false where the browser has no media queries.
 */
function read(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches
}

/**
 * Follow the query's changes, such as a keyboard-and-touch device switching its primary pointer.
 * @param listener - called on each change.
 * @returns the unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(TOUCH_QUERY)
  query.addEventListener('change', listener)
  return () => { query.removeEventListener('change', listener) }
}

/**
 * Whether the screen is hoverless or has a coarse primary pointer, following changes.
 * @returns true on such a screen.
 */
export function useTouchScreen(): boolean {
  return useSyncExternalStore(subscribe, read)
}
