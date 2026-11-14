/**
 * Folds one Session's event window into the latest turn's reading page.
 *
 * The window carries a streaming attempt as client-only live chunks and then
 * as the durable settlement that replaces them, both spelling the same text.
 * Each chunk appends to its block in place and reads only the words it
 * completed, so earlier words keep their objects. Settlement keeps a block
 * whose text it confirms or extends and replaces one it contradicts; a dropped
 * attempt, a replaced or prepended window, or a missed revision rebuilds the
 * page. Word keys do not depend on the attempt, so the reader keeps its place
 * across any of these. The page publishes at most once a frame.
 *
 * A word's time is when this page received the chunk that completed it, on
 * the page's own clock, which the reader's delay compares against; a word that
 * arrived settled, from history, counts as written long ago.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry, SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { scanWords } from './words.ts'
import type { PartKind, ReadingPage, ReadingPart, ReadingSource, ReadingWord } from './types.ts'

/** Requests one callback at the next frame; the browser's animation frame by default. */
export interface FrameScheduler {
  /** @param callback - the publication. @returns a handle for {@link FrameScheduler.cancel}. */
  request(callback: () => void): number
  /** @param handle - a pending request's handle. */
  cancel(handle: number): void
}

const ANIMATION_FRAMES: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: (handle) => { cancelAnimationFrame(handle) },
}

/** The time a settled word counts as written at. */
const SETTLED = 0

/** The page before the Session holds any reasoning or reply. */
const EMPTY: ReadingPage = { turn: undefined, parts: [], complete: true }

interface PartState {
  readonly key: string
  kind: PartKind
  readonly turn: number
  readonly step: number
  text: string
  streaming: boolean
  /** The live attempt that streams the block, until a settlement confirms it. */
  attempt: string | undefined
  /** Offset after the last complete word. */
  consumed: number
  words: ReadingWord[]
  snapshot: ReadingPart | undefined
}

type Block = { readonly kind: PartKind; readonly text: string }

// What a chunk adds to a reasoning or reply block; undefined for every other chunk.
function readingOf(chunk: StreamChunk): { readonly kind: PartKind; readonly index: number; readonly text: string } | undefined {
  switch (chunk.type) {
    case 'block-start':
      if (chunk.blockType === 'reasoning') return { kind: 'reasoning', index: chunk.index, text: '' }
      return chunk.blockType === 'text' ? { kind: 'reply', index: chunk.index, text: '' } : undefined
    case 'reasoning-delta': return { kind: 'reasoning', index: chunk.index, text: chunk.text }
    case 'text-delta': return { kind: 'reply', index: chunk.index, text: chunk.text }
    default: return undefined
  }
}

/** One Session's reading page; it reads the window only while the pane observes it. */
export class ReadingFeed implements ReadingSource {
  readonly #source: SessionEventSource
  readonly #frames: FrameScheduler
  readonly #clock: () => number
  readonly #listeners = new Set<() => void>()
  readonly #parts = new Map<string, PartState>()
  #turn: number | undefined
  #revision = -1
  #page: ReadingPage = EMPTY
  #dirty = false
  #frame: number | undefined
  #detach: (() => void) | undefined
  #disposed = false

  /**
   * @param source - the Session's event window.
   * @param frames - when publications run; tests pass a manual scheduler.
   * @param clock - the page's clock, in milliseconds; the reader's clock must be the same one.
   */
  constructor(source: SessionEventSource, frames: FrameScheduler = ANIMATION_FRAMES, clock: () => number = Date.now) {
    this.#source = source
    this.#frames = frames
    this.#clock = clock
  }

  /** @returns the published page. */
  getSnapshot = (): ReadingPage => this.#page

  /**
   * @param listener - called after each published page.
   * @returns the unsubscribe function; the last one stops reading the window.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (this.#listeners.size === 1 && !this.#disposed) {
      this.#accept(this.#source.getSnapshot())
      this.#publish()
      this.#detach = this.#source.subscribe(() => {
        this.#accept(this.#source.getSnapshot())
        this.#schedule()
      })
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#stop()
    }
  }

  /** Stop reading the window and drop every listener; the feed publishes nothing after. */
  dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
    this.#stop()
  }

  #stop(): void {
    this.#detach?.()
    this.#detach = undefined
    if (this.#frame !== undefined) this.#frames.cancel(this.#frame)
    this.#frame = undefined
  }

  #schedule(): void {
    if (!this.#dirty || this.#frame !== undefined || this.#disposed) return
    this.#frame = this.#frames.request(() => {
      this.#frame = undefined
      this.#publish()
    })
  }

  #accept(window: SessionEventWindow): void {
    if (window.revision === this.#revision) return
    const next = window.revision === this.#revision + 1
    const change = window.change
    if (next && change.kind === 'append') {
      for (const entry of change.entries) this.#absorb(entry)
    } else if (next && change.kind === 'settle-assistant') {
      this.#settle(change.attemptId, change.entry?.event)
    } else {
      this.#rebuild(window.entries)
    }
    this.#revision = window.revision
  }

  #rebuild(entries: readonly SessionEventLikeEntry[]): void {
    this.#clear()
    for (const entry of entries) this.#absorb(entry)
  }

  #clear(): void {
    if (this.#parts.size > 0 || this.#turn !== undefined) this.#dirty = true
    this.#parts.clear()
    this.#turn = undefined
  }

  #absorb(entry: SessionEventLikeEntry): void {
    if (entry.type === 'transient') {
      const { attemptId, turn, step, chunk } = entry.event.data
      this.#chunk(turn, step, chunk, attemptId)
    } else if (entry.event.type === 'assistant/message') {
      this.#message(entry.event)
    }
  }

  #chunk(turn: number, step: number, chunk: StreamChunk, attempt: string): void {
    const time = this.#clock()
    if (chunk.type === 'block-end') {
      const part = this.#parts.get(`${String(turn)}:${String(step)}:${String(chunk.index)}`)
      if (part !== undefined) this.#extend(part, '', time, true)
      return
    }
    const reading = readingOf(chunk)
    if (reading === undefined) return
    const part = this.#part(turn, step, reading.index, reading.kind, attempt)
    if (part !== undefined && reading.text !== '') this.#extend(part, reading.text, time, false)
  }

  // A settled message's blocks: kept where it confirms or extends what streamed, replaced where it does not.
  #message(event: SessionEvent<'assistant/message'>): void {
    const { turn, step } = event.data
    const blocks = new Map<number, Block>()
    for (const { chunk } of expandAssistantStream(event.data.stream)) {
      const reading = readingOf(chunk)
      if (reading === undefined) continue
      blocks.set(reading.index, { kind: reading.kind, text: (blocks.get(reading.index)?.text ?? '') + reading.text })
    }
    for (const [index, block] of blocks) {
      const part = this.#part(turn, step, index, block.kind, undefined)
      if (part === undefined) continue
      if (part.kind !== block.kind || !block.text.startsWith(part.text)) {
        // Replaced in place, so the block keeps its position in the stream.
        Object.assign(part, { kind: block.kind, text: '', streaming: true, consumed: 0, words: [] })
      }
      part.attempt = undefined
      this.#extend(part, block.text.slice(part.text.length), SETTLED, true)
    }
  }

  #settle(attempt: string, event: SessionEvent | undefined): void {
    if (event?.type === 'assistant/message') this.#message(event)
    for (const [key, part] of this.#parts) {
      if (part.attempt === attempt) {
        this.#parts.delete(key)
        this.#dirty = true
      }
    }
  }

  // The block's state, made on its first chunk; a block of an older turn is not read, and a newer turn starts a new page.
  #part(turn: number, step: number, index: number, kind: PartKind, attempt: string | undefined): PartState | undefined {
    if (this.#turn !== undefined && turn < this.#turn) return undefined
    if (this.#turn === undefined || turn > this.#turn) {
      this.#clear()
      this.#turn = turn
    }
    const key = `${String(turn)}:${String(step)}:${String(index)}`
    let part = this.#parts.get(key)
    if (part === undefined) {
      part = { key, kind, turn, step, text: '', streaming: true, attempt, consumed: 0, words: [], snapshot: undefined }
      this.#parts.set(key, part)
      this.#dirty = true
    }
    return part
  }

  #extend(part: PartState, text: string, time: number, final: boolean): void {
    if (text === '' && part.streaming === !final) return
    part.text += text
    part.streaming = !final
    const { words, next } = scanWords(part.text, part.consumed, final)
    if (words.length > 0) {
      part.words = [...part.words, ...words.map((span, offset) => ({
        key: `${part.key}#${String(part.words.length + offset)}`, part: part.key, start: span.start, end: span.end,
        text: span.text, pivot: span.pivot, dwell: span.dwell, readyAt: time,
      }))]
    }
    part.consumed = next
    part.snapshot = undefined
    this.#dirty = true
  }

  #publish(): void {
    if (!this.#dirty) return
    this.#dirty = false
    const parts = [...this.#parts.values()].map((part) => {
      part.snapshot ??= { key: part.key, kind: part.kind, turn: part.turn, step: part.step, text: part.text, streaming: part.streaming, words: part.words }
      return part.snapshot
    })
    this.#page = parts.length === 0 && this.#turn === undefined ? EMPTY
      : { turn: this.#turn, parts, complete: parts.every(part => !part.streaming) }
    for (const listener of this.#listeners) listener()
  }
}

/**
 * The words the reader plays from a page, in stream order.
 * @param page - the feed's page.
 * @param source - which parts to read.
 * @returns the chosen parts' words.
 */
export function readingWords(page: ReadingPage, source: PartKind | 'both'): readonly ReadingWord[] {
  return page.parts.filter(part => source === 'both' || part.kind === source).flatMap(part => part.words)
}
