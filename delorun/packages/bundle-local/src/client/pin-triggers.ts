/**
 * The browser events that keep a PIN-unlocked page alive or lock it (C14, "PIN mode"): input is activity, a hidden page
 * locks when the home asks, a page restored from the back-forward cache is locked, and a closing page sends its lock.
 * Polls are not input, so no timer in the page reaches the store's `activity`.
 *
 * @module @delorun/bundle-local/client/pin-triggers
 */
import type { PinSource } from './pin-lock.ts'

/** The input events that count as activity. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const

/**
 * Listen for the page events of the lock.
 * @param source - the store.
 * @param win - the window; the page's own unless a spec passes another.
 * @returns the disposer that removes every listener.
 */
export function attachPinTriggers(source: PinSource, win: Window = window): () => void {
  const onActivity = (): void => { source.activity() }
  const onVisibility = (): void => { if (win.document.visibilityState === 'hidden') source.hidden() }
  const onPageShow = (event: PageTransitionEvent): void => { if (event.persisted) source.restored() }
  const onPageHide = (): void => { source.closing() }
  for (const name of ACTIVITY_EVENTS) win.addEventListener(name, onActivity, { passive: true, capture: true })
  win.document.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pageshow', onPageShow)
  win.addEventListener('pagehide', onPageHide)
  return () => {
    for (const name of ACTIVITY_EVENTS) win.removeEventListener(name, onActivity, { capture: true })
    win.document.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('pageshow', onPageShow)
    win.removeEventListener('pagehide', onPageHide)
  }
}
