/**
 * The page's look as a store over the root element's attributes. The attributes are the only state: nothing is written to
 * a cookie or to storage, so a reload starts again from the default.
 *
 * @module @delorun/site-design/look-store
 */
import { useSyncExternalStore } from 'react'
import { applyLook, currentLook, DEFAULT_LOOK, type Look } from './looks.ts'

const EVENT = 'delorun-look'

let cached: { readonly key: string; readonly look: Look } = { key: '', look: DEFAULT_LOOK }

/**
 * The look the page shows now.
 * @returns the look; the default when the page has not applied one.
 */
export function getLook(): Look {
  const root = document.documentElement
  const key = `${root.dataset['look'] ?? ''}|${root.dataset['accent'] ?? ''}|${root.dataset['density'] ?? ''}|${root.dataset['contrast'] ?? ''}|${root.classList.contains('dark')}`
  if (cached.key !== key) cached = { key, look: currentLook(root) }
  return cached.look
}

/**
 * Applies a look to the page and tells the subscribers.
 * @param next - the look.
 */
export function setLook(next: Look): void {
  applyLook(document.documentElement, next)
  window.dispatchEvent(new Event(EVENT))
}

/**
 * Returns the page to how it started: the default look, with light or dark following the device again.
 */
export function resetLook(): void {
  const root = document.documentElement
  for (const name of ['look', 'accent', 'density', 'contrast']) delete root.dataset[name]
  root.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/**
 * The page's look, kept current.
 * @returns the look; the default during server rendering and the first client render, so the two match.
 */
export function useLook(): Look {
  return useSyncExternalStore(subscribe, getLook, () => DEFAULT_LOOK)
}
