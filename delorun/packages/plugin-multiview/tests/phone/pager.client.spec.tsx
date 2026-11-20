// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback, useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneId } from '../../src/layout/index.ts'
import {
  isMounted, pageAt, pageForKey, pageOrder, PhonePager, PhoneSwitch, type PhonePage,
} from '../../src/phone/index.ts'
import { CLAUDE, CODEX, EXPLORER, FIVE, fakeViewport, LABELS, MAIN, mediaList, page, REVIEW } from './helpers.tsx'

afterEach(cleanup)

/** Counts how many bodies are mounted and how often each was mounted, to see distant pages unmount. */
interface Probe {
  readonly live: Set<string>
  readonly mounts: Map<string, number>
}

const probe = (): Probe => ({ live: new Set(), mounts: new Map() })

function Body({ id, record }: { id: PaneId; record: Probe }): JSX.Element {
  // A ref callback runs on mount and on unmount of its element, so it tracks the body's real lifetime.
  const ref = useCallback((element: HTMLDivElement | null): void => {
    if (element === null) record.live.delete(id)
    else {
      record.live.add(id)
      record.mounts.set(id, (record.mounts.get(id) ?? 0) + 1)
    }
  }, [id, record])
  return <div ref={ref} data-body={id}>{id} transcript</div>
}

function Pager(props: { pages?: readonly PhonePage[]; start?: PaneId; record: Probe; onChange?: (id: PaneId) => void }): JSX.Element {
  const [active, setActive] = useState(props.start ?? MAIN)
  return (
    <div style={{ width: 390, height: 844 }}>
      <PhonePager
        pages={props.pages ?? FIVE}
        active={active}
        onActiveChange={id => { props.onChange?.(id); setActive(id) }}
        renderPage={id => <Body id={id} record={props.record} />}
        renderChipIcon={id => <i data-icon={id} />}
        labels={LABELS}
      />
    </div>
  )
}

/** Give the scroller a 390 px layout, which jsdom does not compute, and record the scrolls the pager asks for. */
function layOutScroller(): { scroller: HTMLElement; scrollTo: ReturnType<typeof vi.fn> } {
  const scroller = document.querySelector<HTMLElement>('[data-multiview-pager] > div:nth-child(2)')!
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 390 })
  const scrollTo = vi.fn()
  scroller.scrollTo = scrollTo as typeof scroller.scrollTo
  return { scroller, scrollTo }
}

const swipeTo = (scroller: HTMLElement, left: number): void => {
  scroller.scrollLeft = left
  fireEvent.scroll(scroller)
}

describe('pager arithmetic', () => {
  it('maps a scroll position to the nearest page and clamps to the pages', () => {
    expect(pageAt(0, 390, 5)).toBe(0)
    expect(pageAt(194, 390, 5)).toBe(0)
    expect(pageAt(196, 390, 5)).toBe(1)
    expect(pageAt(390 * 4 + 50, 390, 5)).toBe(4)
    expect(pageAt(9999, 390, 5)).toBe(4)
    expect(pageAt(-40, 390, 5)).toBe(0)
  })

  it('shows page 0 when the scroller has no layout or no pages', () => {
    expect(pageAt(500, 0, 5)).toBe(0)
    expect(pageAt(500, 390, 0)).toBe(0)
  })

  it('keeps the shown page and its neighbours mounted', () => {
    expect([0, 1, 2, 3, 4].map(index => isMounted(index, 2))).toEqual([false, true, true, true, false])
    expect([0, 1, 2].map(index => isMounted(index, 0))).toEqual([true, true, false])
    expect(isMounted(3, 0, 3)).toBe(true)
  })

  it('moves by arrow keys, Home and End, and never past either end', () => {
    expect(pageForKey('ArrowRight', 1, 5)).toBe(2)
    expect(pageForKey('ArrowLeft', 1, 5)).toBe(0)
    expect(pageForKey('Home', 3, 5)).toBe(0)
    expect(pageForKey('End', 1, 5)).toBe(4)
    expect(pageForKey('ArrowLeft', 0, 5)).toBeNull()
    expect(pageForKey('ArrowRight', 4, 5)).toBeNull()
    expect(pageForKey('Home', 0, 5)).toBeNull()
    expect(pageForKey('a', 1, 5)).toBeNull()
  })

  it('orders pages main first, then pins once each in pin order', () => {
    expect(pageOrder(MAIN, [CLAUDE, CODEX, CLAUDE, MAIN])).toEqual([MAIN, CLAUDE, CODEX])
    expect(pageOrder(MAIN, [])).toEqual([MAIN])
  })
})

describe('the phone pager at 390 px', () => {
  it('draws one chip per chat in a tab strip, with the shown one selected', () => {
    render(<Pager record={probe()} />)
    const strip = screen.getByRole('tablist', { name: 'Chats' })
    const chips = within(strip).getAllByRole('tab')
    expect(chips.map(chip => chip.textContent)).toEqual(['Main', 'Claude Code', 'Codex', 'Explorer', 'Review'])
    expect(chips.map(chip => chip.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false'])
    expect(chips.map(chip => chip.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1'])
    expect(strip.querySelector('[data-icon="claude"]')).toBeTruthy()
  })

  it('shows the amber dot only on a chat that needs the person, and names it', () => {
    render(<Pager record={probe()} />)
    const dots = document.querySelectorAll('[data-attention-dot]')
    expect(dots).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /Claude Code/ }).contains(dots[0]!)).toBe(true)
    expect(within(screen.getByRole('tab', { name: /Claude Code/ })).getByRole('img', { name: 'Needs your approval' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Codex' }).querySelector('[data-attention-dot]')).toBeNull()
  })

  it('shows the dot on a chip that is off screen too, so the strip is the way to find it', () => {
    render(<Pager record={probe()} start={REVIEW} />)
    expect(screen.getByRole('tab', { name: /Claude Code/ }).hasAttribute('data-needs-attention')).toBe(true)
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true')
  })

  it('jumps to a page when its chip is tapped', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} onChange={id => changes.push(id)} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    expect(changes).toEqual([CODEX])
    expect(screen.getByRole('tab', { name: 'Codex' }).getAttribute('aria-selected')).toBe('true')
  })

  it('draws one dot per page with the shown one marked, and a dot tap jumps', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} start={CLAUDE} onChange={id => changes.push(id)} />)
    const dots = [...document.querySelectorAll<HTMLElement>('[data-page-dot]')]
    expect(dots.map(dot => dot.getAttribute('data-page-dot'))).toEqual(['main', 'claude', 'codex', 'explorer', 'review'])
    expect(dots.map(dot => dot.hasAttribute('data-active'))).toEqual([false, true, false, false, false])
    fireEvent.click(dots[3]!)
    expect(changes).toEqual([EXPLORER])
    expect(document.querySelector('[data-page-dot="explorer"]')!.hasAttribute('data-active')).toBe(true)
  })

  it('hides the dots from assistive technology, since the strip says the same', () => {
    render(<Pager record={probe()} />)
    expect(document.querySelector('[data-page-dot]')!.parentElement!.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('mounts the shown page and its neighbours only, and unmounts a page that falls out of reach', () => {
    const record = probe()
    render(<Pager record={record} />)
    expect([...record.live].sort()).toEqual(['claude', 'main'])
    expect(document.querySelectorAll('[data-page]')).toHaveLength(5)

    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    expect([...record.live].sort()).toEqual(['claude', 'codex', 'explorer'])
    expect(document.querySelector('[data-page="main"]')!.childElementCount).toBe(0)

    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect([...record.live].sort()).toEqual(['explorer', 'review'])
    expect(record.mounts.get('claude')).toBe(1)
  })

  it('remounts a distant page when it comes back into reach', () => {
    const record = probe()
    render(<Pager record={record} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Main' }))
    expect(record.live.has('main')).toBe(true)
    expect(record.mounts.get('main')).toBe(2)
  })

  it('makes off-screen pages inert so Tab cannot scroll the pager away', () => {
    render(<Pager record={probe()} />)
    const panels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
    expect(panels.map(panel => panel.hasAttribute('inert'))).toEqual([false, true, true, true, true])
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(5)
    expect(document.querySelector('[data-page="main"]')!.getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Main' }).id)
  })

  it('reports a swipe as the page nearest the left edge', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} onChange={id => changes.push(id)} />)
    const { scroller } = layOutScroller()
    swipeTo(scroller, 120)
    expect(changes).toEqual([])
    swipeTo(scroller, 250)
    expect(changes).toEqual([CLAUDE])
    swipeTo(scroller, 390 * 3)
    expect(changes).toEqual([CLAUDE, EXPLORER])
  })

  it('scrolls to the page a chip names and ignores the pages it passes on the way', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} onChange={id => changes.push(id)} />)
    const { scroller, scrollTo } = layOutScroller()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 390 * 3, behavior: 'smooth' })
    changes.length = 0
    swipeTo(scroller, 390)
    swipeTo(scroller, 390 * 2)
    expect(changes).toEqual([])
    swipeTo(scroller, 390 * 3)
    swipeTo(scroller, 390 * 2)
    expect(changes).toEqual([CODEX])
  })

  it('lets a touch on the pages take over from a scroll the pager started', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} onChange={id => changes.push(id)} />)
    const { scroller } = layOutScroller()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    changes.length = 0
    fireEvent.touchStart(scroller)
    swipeTo(scroller, 390)
    expect(changes).toEqual([CLAUDE])
  })

  it('moves with the arrow keys in the strip and keeps focus on the chip', () => {
    render(<Pager record={probe()} />)
    const chip = screen.getByRole('tab', { name: 'Main' })
    chip.focus()
    fireEvent.keyDown(chip, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Claude Code/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Review' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Review' }))
  })

  it('falls back to the first page when the shown chat is no longer pinned', () => {
    const changes: PaneId[] = []
    const record = probe()
    const { rerender } = render(<Pager record={record} start={REVIEW} onChange={id => changes.push(id)} />)
    expect(changes).toEqual([])
    rerender(<Pager record={record} start={REVIEW} pages={FIVE.slice(0, 3)} onChange={id => changes.push(id)} />)
    expect(changes).toEqual([MAIN])
  })

  it('renders an empty pager without failing', () => {
    render(<Pager record={probe()} pages={[]} />)
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('draws a single page for a chat with nothing pinned', () => {
    const record = probe()
    render(<Pager record={record} pages={[page(MAIN, 'Main')]} />)
    expect([...record.live]).toEqual(['main'])
    expect(document.querySelectorAll('[data-page-dot]')).toHaveLength(1)
  })

  it('realigns the shown page when the window turns', () => {
    const observed: (() => void)[] = []
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { observed.push(() => { callback([], this) }) }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    try {
      render(<Pager record={probe()} start={CODEX} />)
      const { scroller } = layOutScroller()
      scroller.scrollLeft = 10
      for (const callback of observed) callback()
      expect(scroller.scrollLeft).toBe(390 * 2)
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('stops ignoring scrolls once the browser reports the scroll ended', () => {
    const changes: PaneId[] = []
    render(<Pager record={probe()} onChange={id => changes.push(id)} />)
    const { scroller } = layOutScroller()
    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    changes.length = 0
    fireEvent(scroller, new Event('scrollend'))
    swipeTo(scroller, 390)
    expect(changes).toEqual([CLAUDE])
  })

  it('sets scrollLeft where the browser has no scrollTo', () => {
    render(<Pager record={probe()} />)
    const { scroller } = layOutScroller()
    // @ts-expect-error: an element without scrollTo, as in jsdom.
    scroller.scrollTo = undefined
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    expect(scroller.scrollLeft).toBe(390 * 2)
  })

  it('skips the smooth scroll under reduced motion', () => {
    const restore = fakeViewport(390)
    const base = window.matchMedia
    window.matchMedia = (query: string) => (query.includes('prefers-reduced-motion') ? mediaList(query, () => true) : base(query))
    try {
      render(<Pager record={probe()} />)
      const { scrollTo } = layOutScroller()
      fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 390 * 2, behavior: 'auto' })
    } finally {
      restore.restore()
    }
  })
})

describe('the breakpoint', () => {
  let viewport: ReturnType<typeof fakeViewport>
  beforeEach(() => { viewport = fakeViewport(390) })
  afterEach(() => { viewport.restore() })

  const Both = (): JSX.Element => <PhoneSwitch phone={<p>pager</p>} split={<p>splits</p>} />

  it('shows the pager at 390 px and the splits from 768 px', () => {
    render(<Both />)
    expect(screen.getByText('pager')).toBeTruthy()
    act(() => { viewport.resize(767) })
    expect(screen.getByText('pager')).toBeTruthy()
    act(() => { viewport.resize(768) })
    expect(screen.getByText('splits')).toBeTruthy()
    act(() => { viewport.resize(1440) })
    expect(screen.getByText('splits')).toBeTruthy()
  })

  it('switches back to the pager when a window narrows', () => {
    viewport.resize(1440)
    render(<Both />)
    expect(screen.getByText('splits')).toBeTruthy()
    act(() => { viewport.resize(390) })
    expect(screen.getByText('pager')).toBeTruthy()
  })

  it('shows the splits where the window cannot be measured', () => {
    viewport.restore()
    const original = window.matchMedia
    // @ts-expect-error: a window without matchMedia, as jsdom without a stub.
    window.matchMedia = undefined
    try {
      render(<Both />)
      expect(screen.getByText('splits')).toBeTruthy()
    } finally {
      window.matchMedia = original
    }
  })
})
