/**
 * The one-time Multiview hint's preference: whether the person has seen it, kept as a client preference in `localStorage` under a
 * key the connection's host id qualifies. A browser without usable storage shows the hint at most once per page load.
 * @module @delorun/plugin-multiview/entry/hint
 */
import { qualifiedPersistKey } from '@deepseek-ai/dsh-client-store'
import type { MultiviewStorage } from '../store/persist.ts'

/** The storage key's name; the connection's host id qualifies it. */
export const MULTIVIEW_HINT_NAME = 'dsh.multiview-hint.v1'

/** Whether the hint has been shown, and the call that records it. */
export interface HintPreference {
  /**
   * Whether the hint was shown before, in this browser for this studio or earlier in this page.
   * @returns true once it has been shown.
   */
  seen(): boolean
  /** Record that the hint has been shown, so it never shows again. */
  markSeen(): void
}

/**
 * The hint preference over the page's storage.
 * @param storage - the page's `localStorage`, or undefined where the browser blocks it.
 * @returns the preference.
 */
export function localHint(storage: () => MultiviewStorage | undefined): HintPreference {
  let seenHere = false
  const key = (): string => qualifiedPersistKey(MULTIVIEW_HINT_NAME)
  return {
    seen: () => {
      if (seenHere) return true
      try {
        return storage()?.getItem(key()) === '1'
      } catch (_blocked) {
        // A storage that throws on read is treated as empty; seenHere still limits the hint to once per page.
        return false
      }
    },
    markSeen: () => {
      seenHere = true
      try {
        storage()?.setItem(key(), '1')
      } catch (_full) {
        // A full or blocked storage keeps the in-page record only.
      }
    },
  }
}
