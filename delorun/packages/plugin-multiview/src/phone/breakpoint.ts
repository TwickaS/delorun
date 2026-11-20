/**
 * When Multiview shows the phone pager instead of the split layout: a window narrower than the sidebar's drawer breakpoint
 * (768 px, `SIDEBAR_DRAWER_BREAKPOINT` in `ui-layout`). The test is the window's width only: a tablet with a touch screen keeps the splits.
 * @module @delorun/plugin-multiview/phone/breakpoint
 */

import { useSyncExternalStore } from 'react'

/** The first window width, in CSS pixels, that gets the split layout. */
export const PHONE_PAGER_BREAKPOINT = 768

/** Media query that matches while the pager is shown. */
export const PHONE_PAGER_QUERY = `(max-width: ${PHONE_PAGER_BREAKPOINT - 1}px)`

const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE_PAGER_QUERY)
  list.addEventListener('change', onChange)
  return () => { list.removeEventListener('change', onChange) }
}

function snapshot(): boolean {
  return window.matchMedia(PHONE_PAGER_QUERY).matches
}

/**
 * Track whether the window is narrow enough for the pager. A window without `matchMedia` (jsdom in the unit lane) gets the splits.
 * @returns whether {@link PHONE_PAGER_QUERY} currently matches.
 */
export function usePhonePager(): boolean {
  return useSyncExternalStore(
    hasMatchMedia() ? subscribe : () => () => {},
    hasMatchMedia() ? snapshot : () => false,
    () => false,
  )
}
