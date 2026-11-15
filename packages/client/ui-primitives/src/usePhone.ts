/** Phone and touch detection for controls that only make sense on a computer. */

import { useSyncExternalStore } from 'react'

/** Media query matching a touch screen or a phone-width window. */
export const PHONE_QUERY = '(pointer: coarse), (max-width: 767px)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE_QUERY)
  list.addEventListener('change', onChange)
  return () => { list.removeEventListener('change', onChange) }
}

function snapshot(): boolean {
  return window.matchMedia(PHONE_QUERY).matches
}

/**
 * Track whether the window is a phone: a coarse primary pointer or a width of at most 767px.
 * A view without matchMedia (jsdom in the unit lane) is not a phone.
 * @returns whether {@link PHONE_QUERY} currently matches.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(
    typeof window.matchMedia === 'function' ? subscribe : () => () => {},
    typeof window.matchMedia === 'function' ? snapshot : () => false,
    () => false,
  )
}
