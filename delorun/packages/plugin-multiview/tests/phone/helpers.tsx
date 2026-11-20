import { vi } from 'vitest'
import type { PaneId } from '../../src/layout/index.ts'
import type { PhonePage } from '../../src/phone/index.ts'

/** A pane id for a spec; ids are Session ids, which are plain strings at runtime. */
export const pane = (id: string): PaneId => id as PaneId

export const MAIN = pane('main')
export const CLAUDE = pane('claude')
export const CODEX = pane('codex')
export const EXPLORER = pane('explorer')
export const REVIEW = pane('review')

export const page = (id: PaneId, label: string, needsAttention = false): PhonePage => ({ id, label, needsAttention })

export const FIVE: readonly PhonePage[] = [
  page(MAIN, 'Main'),
  page(CLAUDE, 'Claude Code', true),
  page(CODEX, 'Codex'),
  page(EXPLORER, 'Explorer'),
  page(REVIEW, 'Review'),
]

export const LABELS = { region: 'Multiview', strip: 'Chats', attention: 'Needs your approval' } as const

type Listener = EventListenerOrEventListenerObject

const fire = (listener: Listener): void => {
  const event = new Event('change')
  if (typeof listener === 'function') listener(event)
  else listener.handleEvent(event)
}

/**
 * A complete `MediaQueryList` for a fake `matchMedia`.
 * @param query - the query text.
 * @param matches - reads whether the query matches now.
 * @param listeners - the set that holds the `change` listeners.
 * @returns the list.
 */
export function mediaList(query: string, matches: () => boolean, listeners: Set<Listener> = new Set()): MediaQueryList {
  return {
    get matches() { return matches() },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: Listener) => { listeners.delete(listener) },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }
}

/**
 * Replace `window.matchMedia` with one that evaluates `max-width` queries against `window.innerWidth`, and return `resize` to change
 * the width the way a phone turning or a window dragging does: it notifies every listener.
 * @param width - the starting window width in CSS pixels.
 * @returns the resize function and a restore function.
 */
export function fakeViewport(width: number): { resize: (next: number) => void; restore: () => void } {
  const original = window.matchMedia
  const all = new Set<Set<Listener>>()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  const matches = (query: string): boolean => {
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query)
    return max !== null && window.innerWidth <= Number(max[1])
  }
  window.matchMedia = vi.fn((query: string): MediaQueryList => {
    const listeners = new Set<Listener>()
    all.add(listeners)
    return mediaList(query, () => matches(query), listeners)
  })
  return {
    resize: next => {
      window.innerWidth = next
      for (const listeners of all) for (const listener of [...listeners]) fire(listener)
    },
    restore: () => { window.matchMedia = original },
  }
}
