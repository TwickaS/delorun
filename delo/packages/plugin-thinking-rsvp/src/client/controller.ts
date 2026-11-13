/**
 * The reader's playback: which word the band shows, and when it moves on.
 * Clock-driven and free of the DOM, so the pane calls {@link ReadingController.advance}
 * once a frame and a test calls it with its own times.
 */

import type { ReadingWord } from './types.ts'

/**
 * Where the pace comes from: the newest word as it arrives, the reader's own
 * words a minute, or the rate the model writes words at.
 */
export type Pace = 'live' | 'rate' | 'model'

/** The reader's pace preferences. */
export interface PaceSettings {
  readonly pace: Pace
  /** Words a minute at the `rate` pace, and before the model's rate is known. */
  readonly wpm: number
  /** At the `rate` and `model` paces, how long a word has been written before the band shows it. */
  readonly delayMs: number
}

/** What the band is doing. */
export type ReaderState = 'empty' | 'playing' | 'paused' | 'waiting' | 'finished'

/** The band's word and state after the last call. */
export interface ReaderSnapshot {
  /** Index of the word the band shows, or -1 before any word. */
  readonly cursor: number
  readonly state: ReaderState
  /** Words a minute in force: the set rate, or the model's. */
  readonly wpm: number
}

/** The model's rate is measured over this many of the newest words. */
const MODEL_WINDOW = 30

/** The slowest and fastest rates the band plays at. */
const MIN_WPM = 60
const MAX_WPM = 1500

/**
 * The rate the model wrote the newest words at.
 * @param words - the words in order, with when each became complete.
 * @returns words a minute, or undefined until enough words show a rate.
 */
export function modelRate(words: readonly ReadingWord[]): number | undefined {
  // The newest words the page saw written; a settled word carries no time.
  let first = words.length
  while (first > 0 && words.length - first < MODEL_WINDOW && (words[first - 1]?.readyAt ?? 0) > 0) first--
  const count = words.length - first
  if (count < 5) return undefined
  const span = (words.at(-1)?.readyAt ?? 0) - (words[first]?.readyAt ?? 0)
  if (span <= 0) return undefined
  return Math.min(MAX_WPM, Math.max(MIN_WPM, ((count - 1) / span) * 60_000))
}

/** One reader's playback over the words its pane chose. */
export class ReadingController {
  #settings: PaceSettings
  #words: readonly ReadingWord[] = []
  #complete = true
  #cursor = -1
  #playing: boolean
  /** When the band's word was shown, for its interval. */
  #shownAt = 0
  #snapshot: ReaderSnapshot

  /**
   * @param settings - the starting pace.
   * @param playing - whether playback starts playing; the pane passes false when the system asks for reduced motion.
   */
  constructor(settings: PaceSettings, playing: boolean) {
    this.#settings = settings
    this.#playing = playing
    this.#snapshot = { cursor: -1, state: 'empty', wpm: settings.wpm }
  }

  /** @returns the snapshot after the last call. */
  get snapshot(): ReaderSnapshot { return this.#snapshot }

  /** @param settings - the reader's new pace, in force from the next word. */
  setSettings(settings: PaceSettings): void {
    this.#settings = settings
  }

  /**
   * Take a new word list, keeping the band on the same word where the list
   * still holds it. A list that no longer holds it, such as a new turn's, starts
   * from its first word.
   * @param words - the words to play.
   * @param complete - whether the list will not grow.
   * @param now - the clock, the same one the feed stamps words with.
   * @returns the snapshot.
   */
  load(words: readonly ReadingWord[], complete: boolean, now: number): ReaderSnapshot {
    const key = this.#words[this.#cursor]?.key
    const kept = key === undefined ? -1 : words.findIndex(word => word.key === key)
    if (kept < 0) this.#shownAt = now
    this.#cursor = kept >= 0 ? kept : words.length > 0 ? 0 : -1
    this.#words = words
    this.#complete = complete
    return this.#publish(now)
  }

  /**
   * Move the band on when its word's interval is over and the next word may show.
   * @param now - the clock.
   * @returns the snapshot.
   */
  advance(now: number): ReaderSnapshot {
    if (!this.#playing || this.#cursor < 0) return this.#publish(now)
    const last = this.#words.length - 1
    if (this.#settings.pace === 'live') {
      if (this.#cursor < last) this.#show(last, now)
      return this.#publish(now)
    }
    const current = this.#words[this.#cursor]
    const next = this.#words[this.#cursor + 1]
    if (current !== undefined && next !== undefined && this.#ready(next, now)) {
      const interval = 60_000 / this.#wpm()
      const due = this.#shownAt + interval * current.dwell
      // One word a call at most, timed from when it was due so frame timing does not drift the pace;
      // after a stall longer than a word, from now, so a slow frame delays words rather than skipping them.
      if (now >= due) this.#show(this.#cursor + 1, now - due > interval ? now : due)
    }
    return this.#publish(now)
  }

  /**
   * Play from the band's word; at the end of a finished list, from its start.
   * @param now - the clock.
   * @returns the snapshot.
   */
  play(now: number): ReaderSnapshot {
    if (this.#snapshot.state === 'finished') this.#show(0, now)
    else this.#shownAt = now
    this.#playing = true
    return this.#publish(now)
  }

  /** @param now - the clock. @returns the snapshot, paused. */
  pause(now: number): ReaderSnapshot {
    this.#playing = false
    return this.#publish(now)
  }

  /**
   * Show the word `delta` words away, and pause.
   * @param delta - how many words forward, or back when negative.
   * @param now - the clock.
   * @returns the snapshot.
   */
  step(delta: number, now: number): ReaderSnapshot {
    this.#playing = false
    if (this.#cursor >= 0) this.#show(Math.min(this.#words.length - 1, Math.max(0, this.#cursor + delta)), now)
    return this.#publish(now)
  }

  /** @param now - the clock. @returns the snapshot, on the first word and paused. */
  restart(now: number): ReaderSnapshot {
    this.#playing = false
    if (this.#cursor >= 0) this.#show(0, now)
    return this.#publish(now)
  }

  /** @param now - the clock. @returns the snapshot, on the newest word and playing. */
  skipToLive(now: number): ReaderSnapshot {
    if (this.#cursor >= 0) this.#show(this.#words.length - 1, now)
    this.#playing = true
    return this.#publish(now)
  }

  #show(index: number, at: number): void {
    this.#cursor = index
    this.#shownAt = at
  }

  #ready(word: ReadingWord, now: number): boolean {
    return now - word.readyAt >= this.#settings.delayMs
  }

  #wpm(): number {
    const set = Math.min(MAX_WPM, Math.max(MIN_WPM, this.#settings.wpm))
    return this.#settings.pace === 'model' ? modelRate(this.#words) ?? set : set
  }

  #publish(now: number): ReaderSnapshot {
    const next = this.#words[this.#cursor + 1]
    const state: ReaderState = this.#cursor < 0 ? 'empty'
      : next === undefined && this.#complete ? 'finished'
        : !this.#playing ? 'paused'
          : next === undefined || (this.#settings.pace !== 'live' && !this.#ready(next, now)) ? 'waiting' : 'playing'
    const wpm = Math.round(this.#wpm())
    const previous = this.#snapshot
    if (previous.cursor !== this.#cursor || previous.state !== state || previous.wpm !== wpm) this.#snapshot = { cursor: this.#cursor, state, wpm }
    return this.#snapshot
  }
}
