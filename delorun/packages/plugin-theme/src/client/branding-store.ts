/**
 * The branding the studio shows now: the theme form's record, validated by {@link resolveBranding}, published to the
 * hero, the sidebar header, the document title and the favicon.
 * @module @delorun/plugin-theme/client/branding-store
 */
import { resolveBranding, type Branding, type StoredBranding } from '@delorun/brand/branding'
import { useSyncExternalStore } from 'react'

/** The branding and a counter that changes with each publication, so an icon address changes when the upload does. */
export interface BrandingView extends Branding {
  readonly revision: number
}

let view: BrandingView = { ...resolveBranding(undefined), revision: 0 }
const listeners = new Set<() => void>()

/**
 * Publish the stored record. The page's copy of a record has no upload bytes, so an `upload` icon is kept as it is.
 * @param stored - the theme form's branding.
 */
export function publishBranding(stored: StoredBranding): void {
  view = { ...resolveBranding(stored, { uploadElided: true }), revision: view.revision + 1 }
  for (const listener of listeners) listener()
}

/**
 * Follow the published branding.
 * @param listener - called after each publication.
 * @returns the unsubscriber.
 */
export function subscribeBranding(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** @returns the branding published last. */
export function currentBranding(): BrandingView {
  return view
}

/** @returns the published branding, re-rendering the caller when it changes. */
export function useBranding(): BrandingView {
  return useSyncExternalStore(subscribeBranding, currentBranding)
}
