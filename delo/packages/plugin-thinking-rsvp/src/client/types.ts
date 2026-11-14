/**
 * The reader's shared vocabulary: what the feed folds a Session into, and what
 * the pane reads through its inject hooks.
 */

/** What a part of the model's output is: its reasoning, or its reply. */
export type PartKind = 'reasoning' | 'reply'

/** Which parts the reader plays. */
export type ReadingSourceChoice = PartKind | 'both'

/** One word the reader can show, with where it sits in its part's text. */
export interface ReadingWord {
  /** Stable across settlement and rebuilds: the part's key and the word's position in it. */
  readonly key: string
  /** The owning part's key. */
  readonly part: string
  /** Offset of the word in the part's text. */
  readonly start: number
  /** Offset after the word in the part's text. */
  readonly end: number
  /** The word as shown, without its Markdown markup. */
  readonly text: string
  /** Index, within the word, of the letter the eye fixes on. */
  readonly pivot: number
  /** How long the word holds the band, as a multiple of one word's interval. */
  readonly dwell: number
  /** When the page received the chunk that completed the word, on the page's clock; 0 for a word that arrived settled. */
  readonly readyAt: number
}

/** One reasoning or reply block of one step, as the model streamed it. */
export interface ReadingPart {
  /** `<turn>:<step>:<block>`, the same while the block streams and after it settles. */
  readonly key: string
  readonly kind: PartKind
  readonly turn: number
  readonly step: number
  /** The block's raw text so far. */
  readonly text: string
  /** True while the model may still extend the block. */
  readonly streaming: boolean
  /** The block's complete words, in order. */
  readonly words: readonly ReadingWord[]
}

/** The latest turn's parts, in stream order. */
export interface ReadingPage {
  /** The turn the page shows; undefined before the Session holds any reasoning or reply. */
  readonly turn: number | undefined
  readonly parts: readonly ReadingPart[]
  /** True when no part is still streaming. */
  readonly complete: boolean
}

/** The feed, as the pane binds it: the current page, the same object until it changes. */
export interface ReadingSource {
  /** @returns the current page. */
  getSnapshot(): ReadingPage
  /** @param listener - called after each published page. @returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** What the pane receives besides its store, hooks and dictionary. */
export interface ThinkingPaneInjected {
  readonly hooks: { readonly reading: ReadingSource }
}
