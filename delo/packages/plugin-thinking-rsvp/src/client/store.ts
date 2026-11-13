/** The reader's preferences, kept per browser rather than per Session. */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { Pace } from './controller.ts'
import type { ReadingSourceChoice } from './types.ts'

/** The slowest and fastest set rates, in words a minute. */
export const MIN_WPM = 100
export const MAX_WPM = 1000

/** The longest delay, in seconds. */
export const MAX_DELAY_SECONDS = 30

/** What the reader chose. The declared actions change these fields. */
export interface ReaderSettings {
  /** Which parts the band plays. */
  source: ReadingSourceChoice
  /** Where the pace comes from. */
  pace: Pace
  /** Words a minute at the set rate. */
  wpm: number
  /** How long a word has been written before the band shows it, at the set rate or the model's. */
  delaySeconds: number
}

const SOURCES: readonly ReadingSourceChoice[] = ['reasoning', 'reply', 'both']
const PACES: readonly Pace[] = ['live', 'rate', 'model']
const DEFAULTS: ReaderSettings = { source: 'both', pace: 'model', wpm: 300, delaySeconds: 0 }

// A whole number inside the range, or the fallback for anything that is not a finite number.
function within(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/**
 * The preferences as the pane uses them. The store reads them back from the
 * browser's storage unchecked, so a field kept by another build or edited by
 * hand falls back to its default, and a number is brought inside its range.
 * @param stored - the store's state.
 * @returns valid preferences.
 */
export function readerSettings(stored: { readonly [K in keyof ReaderSettings]?: unknown }): ReaderSettings {
  return {
    source: SOURCES.find(source => source === stored.source) ?? DEFAULTS.source,
    pace: PACES.find(pace => pace === stored.pace) ?? DEFAULTS.pace,
    wpm: within(stored.wpm, MIN_WPM, MAX_WPM, DEFAULTS.wpm),
    delaySeconds: within(stored.delaySeconds, 0, MAX_DELAY_SECONDS, DEFAULTS.delaySeconds),
  }
}

/**
 * Declare the preference store; the plugin makes one handle and passes it to the tab's registration.
 * @returns the store handle.
 */
export function createReaderStore() {
  return defineStore({
    init: (): ReaderSettings => ({ ...DEFAULTS }),
    persist: 'delo.thinking-rsvp.reader.v2',
    actions: {
      setSource(draft, source: ReadingSourceChoice) {
        draft.source = source
      },
      setPace(draft, pace: Pace) {
        draft.pace = pace
      },
      setWpm(draft, wpm: number) {
        draft.wpm = within(wpm, MIN_WPM, MAX_WPM, DEFAULTS.wpm)
      },
      setDelaySeconds(draft, seconds: number) {
        draft.delaySeconds = within(seconds, 0, MAX_DELAY_SECONDS, DEFAULTS.delaySeconds)
      },
    },
  })
}
