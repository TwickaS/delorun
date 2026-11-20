/**
 * The phone pager: one page per chat (the main chat, then each pinned agent), swiped sideways with native scroll snap. A strip of
 * name chips on top jumps to a page and shows an amber dot where an agent needs the person; dots at the bottom show the position.
 * Pages that are neither shown nor adjacent keep their wrapper but render no body, so only three transcripts are in the DOM.
 * The pager owns no session state: the panel lane supplies the pages and renders each body.
 * @module @delorun/plugin-multiview/phone/PhonePager
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, type JSX, type KeyboardEvent, type ReactNode,
} from 'react'
import type { PaneId } from '../layout/model.ts'
import { isMounted, pageAt, pageForKey } from './pages.ts'
import styles from './PhonePager.module.css'

/** One page of the pager. */
export interface PhonePage {
  /** The chat's pane id, also the page's key. */
  readonly id: PaneId
  /** The chip's text: the chat's or agent's name. */
  readonly label: string
  /** An agent on this page waits for the person (an approval or a question): its chip shows an amber dot. */
  readonly needsAttention: boolean
}

/** What a page body is told. */
export interface PhonePageState {
  /** The page is the one on screen. */
  readonly active: boolean
}

/** The pager's words, so every string reaches the person through a locale dictionary. */
export interface PhonePagerLabels {
  /** Names the pager region, for example "Multiview". */
  readonly region: string
  /** Names the strip of chips, for example "Chats". */
  readonly strip: string
  /** Names the amber dot, for example "Needs your approval". */
  readonly attention: string
}

/** What {@link PhonePager} takes. The pager is controlled: the consumer owns the shown page. */
export interface PhonePagerProps {
  /** The pages in order, the main chat first. */
  readonly pages: readonly PhonePage[]
  /** The shown page. An id that is not in `pages` shows the first page and reports it through `onActiveChange`. */
  readonly active: PaneId
  /**
   * Called when a swipe, a chip, a dot or a key moves to another page, and when `active` names no page.
   * @param id - the page to show.
   */
  readonly onActiveChange: (id: PaneId) => void
  /**
   * Render a page's body, only while the page is shown or adjacent to the shown page.
   * @param id - the page's pane id.
   * @param state - what the page knows about itself.
   */
  readonly renderPage: (id: PaneId, state: PhonePageState) => ReactNode
  /**
   * Render the icon before a chip's label, for example the agent's monogram.
   * @param id - the page's pane id.
   */
  readonly renderChipIcon?: ((id: PaneId) => ReactNode) | undefined
  /** The pager's words. */
  readonly labels: PhonePagerLabels
  /** A class for the pager's root element. */
  readonly className?: string | undefined
}

const reducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const tabId = (root: string, id: string): string => `${root}-tab-${id}`
const panelId = (root: string, id: string): string => `${root}-page-${id}`

/**
 * Draw the pager.
 * @param props - the pages, the shown page and the page renderer.
 * @returns the strip, the swipeable pages and the dots.
 */
export function PhonePager(props: PhonePagerProps): JSX.Element {
  const { pages, active, onActiveChange, renderPage, renderChipIcon, labels, className } = props
  const found = pages.findIndex(page => page.id === active)
  const activeIndex = Math.max(0, found)
  const root = useId().replace(/:/g, '')
  const scroller = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // The page a programmatic scroll is heading for; scroll events on the way there must not report intermediate pages.
  const heading = useRef<number | null>(null)
  const placed = useRef(false)

  const go = useCallback((index: number) => {
    const page = pages[index]
    if (page !== undefined) onActiveChange(page.id)
  }, [pages, onActiveChange])

  useEffect(() => {
    const first = pages[0]
    if (found < 0 && first !== undefined) onActiveChange(first.id)
  }, [found, pages, onActiveChange])

  // Bring the scroller to the shown page: instantly on mount, smoothly afterwards unless the person asked for reduced motion.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    const width = element.clientWidth
    if (pageAt(element.scrollLeft, width, pages.length) === activeIndex && placed.current) return
    const instant = !placed.current || reducedMotion()
    placed.current = true
    heading.current = instant ? null : activeIndex
    const left = activeIndex * width
    if (typeof element.scrollTo === 'function') element.scrollTo({ left, behavior: instant ? 'auto' : 'smooth' })
    else element.scrollLeft = left
  }, [activeIndex, pages.length])

  // Keep the shown page aligned when the window turns or resizes.
  useEffect(() => {
    const element = scroller.current
    if (element === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => { element.scrollLeft = activeIndex * element.clientWidth })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [activeIndex])

  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const settle = (): void => { heading.current = null }
    element.addEventListener('scrollend', settle)
    return () => { element.removeEventListener('scrollend', settle) }
  }, [])

  // Reveal the shown chip in the strip.
  useEffect(() => {
    const chip = strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (typeof chip?.scrollIntoView === 'function') chip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [activeIndex])

  const onScroll = useCallback(() => {
    const element = scroller.current
    if (element === null) return
    const index = pageAt(element.scrollLeft, element.clientWidth, pages.length)
    if (heading.current !== null) {
      if (index === heading.current) heading.current = null
      return
    }
    if (index !== activeIndex) go(index)
  }, [pages.length, activeIndex, go])

  // A touch or wheel on the pages takes over from a programmatic scroll.
  const takeOver = useCallback(() => { heading.current = null }, [])

  const onStripKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const target = pageForKey(event.key, activeIndex, pages.length)
    if (target === null) return
    event.preventDefault()
    go(target)
    strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
  }, [activeIndex, pages.length, go])

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')} role="region" aria-label={labels.region} data-multiview-pager="">
      <div ref={strip} className={styles.strip} role="tablist" aria-label={labels.strip} onKeyDown={onStripKey}>
        {pages.map((page, index) => (
          <button
            key={page.id}
            type="button"
            role="tab"
            id={tabId(root, page.id)}
            className={styles.chip}
            aria-selected={index === activeIndex}
            aria-controls={panelId(root, page.id)}
            tabIndex={index === activeIndex ? 0 : -1}
            data-page-chip={page.id}
            data-needs-attention={page.needsAttention ? '' : undefined}
            onClick={() => { go(index) }}
          >
            {renderChipIcon?.(page.id)}
            <span className={styles.chipLabel}>{page.label}</span>
            {page.needsAttention ? <span className={styles.attention} role="img" aria-label={labels.attention} data-attention-dot="" /> : null}
          </button>
        ))}
      </div>
      <div ref={scroller} className={styles.pages} onScroll={onScroll} onTouchStart={takeOver} onWheel={takeOver}>
        {pages.map((page, index) => (
          <div
            key={page.id}
            role="tabpanel"
            id={panelId(root, page.id)}
            aria-labelledby={tabId(root, page.id)}
            className={styles.page}
            data-page={page.id}
            data-active={index === activeIndex ? '' : undefined}
            // Off-screen pages take no focus, so Tab cannot scroll the pager away from the page the state names.
            {...(index === activeIndex ? {} : { inert: '' })}
          >
            {isMounted(index, activeIndex) ? renderPage(page.id, { active: index === activeIndex }) : null}
          </div>
        ))}
      </div>
      <div className={styles.dots} aria-hidden="true">
        {pages.map((page, index) => (
          <button
            key={page.id}
            type="button"
            tabIndex={-1}
            className={styles.dot}
            data-page-dot={page.id}
            data-active={index === activeIndex ? '' : undefined}
            onClick={() => { go(index) }}
          />
        ))}
      </div>
    </div>
  )
}
