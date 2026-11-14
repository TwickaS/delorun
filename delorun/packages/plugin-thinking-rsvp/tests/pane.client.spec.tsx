// @vitest-environment jsdom
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { createReaderStore } from '../src/client/store.ts'
import { ThinkingPane } from '../src/client/ThinkingPane.tsx'
import type { ReadingPage, ReadingPart, ReadingSource } from '../src/client/types.ts'
import { scanWords } from '../src/client/words.ts'

// A settled part of turn 1, with its words read as the feed reads them.
function part(key: string, kind: ReadingPart['kind'], text: string): ReadingPart {
  return {
    key, kind, turn: 1, step: 1, text, streaming: false,
    words: scanWords(text, 0, true).words.map((span, index) => ({ key: `${key}#${String(index)}`, part: key, ...span, text: text.slice(span.start, span.end), readyAt: 0 })),
  }
}

const PAGE: ReadingPage = {
  turn: 1, complete: true,
  parts: [part('1:1:0', 'reasoning', 'Read the file first.'), part('1:1:1', 'reply', 'It passes now.')],
}

function source(page: ReadingPage): ReadingSource & { set(next: ReadingPage): void } {
  const listeners = new Set<() => void>()
  let current = page
  return {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { current = next; for (const listener of listeners) listener() },
  }
}

function show(page: ReadingPage) {
  const reading = source(page)
  // A scope key per render keeps each spec's preferences apart.
  const store = createReaderStore().create(String(Math.random()))
  render(<ThinkingPane useReading={bindSnapshotSelector(reading)} useStore={bindSnapshotSelector(store)} actions={store.actions} t={makeTranslate(en)} />)
  return { reading, store }
}

const band = () => screen.getByRole('group', { name: en['band.aria'] })
const region = (name: string) => screen.getByRole('region', { name })

beforeEach(() => {
  // Reduced motion: the reader starts paused, so each spec moves it by hand.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Thinking tab', () => {
  it('says there is nothing to read before the model writes, with playback disabled', () => {
    show({ turn: undefined, parts: [], complete: true })
    expect(within(band()).getByText(en['state.empty'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['control.play'] }).hasAttribute('disabled')).toBe(true)
  })

  it('shows the band’s word with its pivot letter marked, and parts the page at the band', () => {
    show(PAGE)
    expect(band().textContent).toBe('Read')
    expect(within(band()).getByText('e').tagName).toBe('MARK')
    fireEvent.click(screen.getByRole('button', { name: en['control.stepForward'] }))
    fireEvent.click(screen.getByRole('button', { name: en['control.stepForward'] }))
    expect(band().textContent).toBe('file')
    // Every word stays on the page: what was read above the band, what is ahead below it, each part labelled once.
    expect(region(en['page.read']).textContent).toBe(`${en['part.reasoning']}Read the`)
    expect(region(en['page.ahead']).textContent).toBe(`first.${en['part.reply']}It passes now.`)
    expect(screen.getByRole('status').textContent).toBe(en['state.paused'])
  })

  it('reads only the chosen parts', () => {
    show(PAGE)
    fireEvent.click(screen.getByRole('tab', { name: en['control.source.reply'] }))
    expect(band().textContent).toBe('It')
    expect(region(en['page.read']).textContent).toBe(en['part.reply'])
    expect(region(en['page.ahead']).textContent).toBe('passes now.')
  })

  it('steps back, restarts and skips to the newest word', () => {
    show(PAGE)
    fireEvent.click(screen.getByRole('button', { name: en['control.skipToLive'] }))
    expect(band().textContent).toBe('now.')
    expect(screen.getByRole('status').textContent).toBe(en['state.finished'])
    fireEvent.click(screen.getByRole('button', { name: en['control.stepBack'] }))
    expect(band().textContent).toBe('passes')
    fireEvent.click(screen.getByRole('button', { name: en['control.restart'] }))
    expect(band().textContent).toBe('Read')
    expect(screen.getByRole('button', { name: en['control.stepBack'] }).hasAttribute('disabled')).toBe(true)
  })

  it('plays on its own clock once played, and pauses', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'Date'] })
    try {
      show(PAGE)
      fireEvent.click(screen.getByRole('tab', { name: en['control.pace.rate'] }))
      fireEvent.click(screen.getByRole('button', { name: en['control.play'] }))
      expect(screen.getByRole('status').textContent).toBe('')
      // 300 words a minute: 'Read' holds the band for 200 ms.
      act(() => { vi.advanceTimersByTime(250) })
      expect(band().textContent).toBe('the')
      fireEvent.click(screen.getByRole('button', { name: en['control.pause'] }))
      act(() => { vi.advanceTimersByTime(2_000) })
      expect(band().textContent).toBe('the')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers the rate at the set rate, the model’s rate at the model’s, and a delay at both, and keeps each choice', () => {
    const { store } = show(PAGE)
    expect(screen.getByText('300 words a minute')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en['control.pace.rate'] }))
    fireEvent.click(screen.getByRole('button', { name: en['control.faster'] }))
    expect(store.getSnapshot()).toMatchObject({ pace: 'rate', wpm: 350 })
    expect(screen.getByText('350 words a minute')).toBeTruthy()
    expect(screen.getByText(en['control.delayNone'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['control.moreDelay'] }))
    expect(screen.getByText('1 s behind')).toBeTruthy()
    expect(screen.getByRole('button', { name: en['control.lessDelay'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: en['control.pace.live'] }))
    expect(screen.queryByRole('group', { name: en['control.delay'] })).toBeNull()
    expect(screen.queryByText('350 words a minute')).toBeNull()
  })

  it('keeps the band on its word as the page grows', () => {
    const { reading } = show({ ...PAGE, complete: false, parts: [PAGE.parts[0] as ReadingPart] })
    fireEvent.click(screen.getByRole('button', { name: en['control.stepForward'] }))
    expect(band().textContent).toBe('the')
    act(() => { reading.set(PAGE) })
    expect(band().textContent).toBe('the')
    expect(region(en['page.ahead']).textContent).toContain('It passes now.')
  })
})
