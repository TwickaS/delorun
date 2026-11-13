/**
 * The right Sidebar's Thinking tab: the latest turn's reasoning and reply,
 * played a word at a time through a fixed band, with the rest of the text laid
 * out as a page that parts at the band: what has been read above it, what is
 * still ahead below it, every word in full.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, ICON_REGULAR_STROKE, SegmentedControl, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ReadingController, type ReaderSnapshot, type ReaderState } from './controller.ts'
import { readingWords } from './feed.ts'
import type { NS } from './locales.ts'
import { MAX_DELAY_SECONDS, MAX_WPM, MIN_WPM, readerSettings, type createReaderStore } from './store.ts'
import type { ReadingPage, ReadingPart, ReadingWord, ThinkingPaneInjected } from './types.ts'
import css from './ThinkingPane.module.css'

/** Words a minute one press of the rate buttons adds or takes away. */
const WPM_STEP = 50

/** Props the tab's seat assembles: preferences, the reading hook and copy. */
export type ThinkingPaneProps = PropsStore<ReturnType<typeof createReaderStore>> & PropsLocale<typeof NS> & InjectFace<ThinkingPaneInjected>

/** @returns whether the system asks for less motion; false where the browser cannot say. */
function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The minus the icon set lacks, drawn at its stroke weight. */
function MinusGlyph(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinecap="round" aria-hidden="true">
      <path d="M3.5 8h9" />
    </svg>
  )
}

/** Skip to the end: a chevron against a bar, which the icon set lacks. */
function LiveGlyph(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4l4 4-4 4" />
      <path d="M11.5 4v8" />
    </svg>
  )
}

/**
 * The text of the chosen parts on one side of the band, each part opened by its label.
 * @param parts - the chosen parts, in stream order.
 * @param word - the band's word, or undefined to lay out every part.
 * @param side - which side of the band.
 * @param t - the tab's translator.
 * @returns the page's runs.
 */
function pageRuns(parts: readonly ReadingPart[], word: ReadingWord | undefined, side: 'read' | 'ahead', t: TranslateNS<typeof NS>): ReactNode[] {
  const at = word === undefined ? -1 : parts.findIndex(part => part.key === word.part)
  const runs: ReactNode[] = []
  for (const [index, part] of parts.entries()) {
    let text = part.text
    let labelled = true
    if (index === at && word !== undefined) {
      // The band stands between the two sides, so neither keeps the whitespace that separated it from the band's word.
      text = side === 'read' ? part.text.slice(0, word.start).trimEnd() : part.text.slice(word.end).trimStart()
      // The band's part keeps its label above the band, where the part begins.
      labelled = side === 'read'
    } else if (side === 'read' ? index > at || at < 0 : index < at) continue
    runs.push(
      <div key={part.key} className={css.run} data-part={part.kind}>
        {labelled && <span className={css.label}>{t(part.kind === 'reasoning' ? 'part.reasoning' : 'part.reply')}</span>}
        <span className={css.text}>{text}</span>
      </div>,
    )
  }
  return runs
}

/**
 * The status line under the band.
 * @param state - the reader's state.
 * @param t - the tab's translator.
 * @returns its copy, or undefined while playing.
 */
function statusOf(state: ReaderState, t: TranslateNS<typeof NS>): string | undefined {
  if (state === 'paused') return t('state.paused')
  if (state === 'waiting') return t('state.waiting')
  if (state === 'finished') return t('state.finished')
  return undefined
}

/**
 * A pair of buttons around a value.
 * @param props - the value's copy, and each button's label, state and action.
 * @returns the stepper.
 */
function Stepper(props: {
  readonly label: string
  readonly value: string
  readonly less: { readonly label: string; readonly disabled: boolean; readonly onClick: () => void }
  readonly more: { readonly label: string; readonly disabled: boolean; readonly onClick: () => void }
}): ReactNode {
  return (
    <div className={css.stepper} role="group" aria-label={props.label}>
      <Tooltip label={props.less.label}>
        <Button variant="ghost" size="sm" aria-label={props.less.label} disabled={props.less.disabled} icon={<MinusGlyph />} onClick={props.less.onClick} />
      </Tooltip>
      <span className={css.stepperValue}>{props.value}</span>
      <Tooltip label={props.more.label}>
        <Button variant="ghost" size="sm" aria-label={props.more.label} disabled={props.more.disabled} icon={<IconPlusOutlineRegular />} onClick={props.more.onClick} />
      </Tooltip>
    </div>
  )
}

/**
 * The Thinking tab's body.
 * @param props - the seat's props.
 * @returns the pane.
 */
export function ThinkingPane({ useReading, useStore, actions, t }: ThinkingPaneProps): ReactNode {
  const page: ReadingPage = useReading(state => state)
  const { source, pace, wpm, delaySeconds } = readerSettings(useStore(state => state))
  const id = useId()

  const parts = useMemo(() => page.parts.filter(part => source === 'both' || part.kind === source), [page, source])
  const words = useMemo(() => readingWords(page, source), [page, source])
  const settings = useMemo(() => ({ pace, wpm, delayMs: delaySeconds * 1000 }), [pace, wpm, delaySeconds])

  const [controller] = useState(() => new ReadingController(settings, !prefersReducedMotion()))
  const [snapshot, setSnapshot] = useState<ReaderSnapshot>(controller.snapshot)
  // A kept tab body outlives its tab's visibility, so the clock runs only while the pane is on screen.
  const [onscreen, setOnscreen] = useState(true)
  const root = useRef<HTMLElement>(null)
  const read = useRef<HTMLDivElement>(null)
  const ahead = useRef<HTMLDivElement>(null)

  useEffect(() => { controller.setSettings(settings) }, [controller, settings])
  useLayoutEffect(() => { setSnapshot(controller.load(words, page.complete, Date.now())) }, [controller, words, page.complete])

  useEffect(() => {
    const element = root.current
    if (element === null || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => { for (const entry of entries) setOnscreen(entry.isIntersecting) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const running = snapshot.state === 'playing' || snapshot.state === 'waiting'
  useEffect(() => {
    if (!running || !onscreen) return undefined
    let handle = requestAnimationFrame(function tick() {
      setSnapshot(controller.advance(Date.now()))
      handle = requestAnimationFrame(tick)
    })
    return () => { cancelAnimationFrame(handle) }
  }, [controller, running, onscreen])

  const word = words[snapshot.cursor]
  // What has been read stays scrolled to its newest line, and what is ahead to its first, unless the reader scrolled away.
  useLayoutEffect(() => {
    const above = read.current
    if (above !== null && above.dataset['held'] !== 'true') above.scrollTop = above.scrollHeight
    const below = ahead.current
    if (below !== null && below.dataset['held'] !== 'true') below.scrollTop = 0
  }, [word, parts])
  const hold = (element: HTMLDivElement, edge: 'end' | 'start'): void => {
    const atEdge = edge === 'end' ? element.scrollTop + element.clientHeight >= element.scrollHeight - 2 : element.scrollTop <= 2
    element.dataset['held'] = atEdge ? 'false' : 'true'
  }

  const now = (): number => Date.now()
  const status = statusOf(snapshot.state, t)
  const pivot = word === undefined ? 0 : Math.min(word.pivot, word.text.length - 1)
  const empty = snapshot.state === 'empty'

  return (
    <section className={css.root} ref={root}>
      <div className={css.page}>
        <div className={css.read} ref={read} role="region" aria-label={t('page.read')} tabIndex={0}
          onScroll={(event) => { hold(event.currentTarget, 'end') }}>
          {pageRuns(parts, word, 'read', t)}
        </div>
        <div className={css.band} role="group" aria-label={t('band.aria')} aria-live="off">
          {empty || word === undefined
            ? <p className={css.empty}>{t('state.empty')}</p>
            : <span className={css.axis}>
              <span className={css.pre}>{word.text.slice(0, pivot)}</span>
              <mark className={css.pivot}>{word.text.slice(pivot, pivot + 1)}</mark>
              <span className={css.post}>{word.text.slice(pivot + 1)}</span>
            </span>}
        </div>
        <div className={css.ahead} ref={ahead} role="region" aria-label={t('page.ahead')} tabIndex={0}
          onScroll={(event) => { hold(event.currentTarget, 'start') }}>
          {word === undefined ? null : pageRuns(parts, word, 'ahead', t)}
        </div>
      </div>
      <p className={css.status} role="status">{status ?? ''}</p>
      <div className={css.toolbar}>
        <div className={css.transport}>
          <Tooltip label={t('control.restart')}>
            <Button variant="ghost" size="sm" aria-label={t('control.restart')} disabled={empty}
              icon={<IconRefreshOutlineRegular />} onClick={() => { setSnapshot(controller.restart(now())) }} />
          </Tooltip>
          <Tooltip label={t('control.stepBack')}>
            <Button variant="ghost" size="sm" aria-label={t('control.stepBack')} disabled={snapshot.cursor <= 0}
              icon={<IconChevronLeftOutlineRegular />} onClick={() => { setSnapshot(controller.step(-1, now())) }} />
          </Tooltip>
          <Tooltip label={t(running ? 'control.pause' : 'control.play')}>
            <Button variant={running || empty ? 'ghost' : 'primary'} size="sm" aria-label={t(running ? 'control.pause' : 'control.play')}
              disabled={empty} icon={running ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
              onClick={() => { setSnapshot(running ? controller.pause(now()) : controller.play(now())) }} />
          </Tooltip>
          <Tooltip label={t('control.stepForward')}>
            <Button variant="ghost" size="sm" aria-label={t('control.stepForward')} disabled={empty || snapshot.cursor >= words.length - 1}
              icon={<IconChevronRightOutlineRegular />} onClick={() => { setSnapshot(controller.step(1, now())) }} />
          </Tooltip>
          <Tooltip label={t('control.skipToLive')}>
            <Button variant="ghost" size="sm" aria-label={t('control.skipToLive')} disabled={empty || snapshot.cursor >= words.length - 1}
              icon={<LiveGlyph />} onClick={() => { setSnapshot(controller.skipToLive(now())) }} />
          </Tooltip>
        </div>
        <SegmentedControl id={`${id}-source`} label={t('control.source')} value={source} onChange={(next) => { actions.setSource(next) }}
          options={[
            { value: 'reasoning', label: t('control.source.reasoning') },
            { value: 'reply', label: t('control.source.reply') },
            { value: 'both', label: t('control.source.both') },
          ]} />
        <SegmentedControl id={`${id}-pace`} label={t('control.pace')} value={pace} onChange={(next) => { actions.setPace(next) }}
          options={[
            { value: 'live', label: t('control.pace.live') },
            { value: 'rate', label: t('control.pace.rate') },
            { value: 'model', label: t('control.pace.model') },
          ]} />
        {pace === 'rate' && (
          <Stepper label={t('control.pace.rate')} value={t('control.wpm', { wpm: String(wpm) })}
            less={{ label: t('control.slower'), disabled: wpm <= MIN_WPM, onClick: () => { actions.setWpm(wpm - WPM_STEP) } }}
            more={{ label: t('control.faster'), disabled: wpm >= MAX_WPM, onClick: () => { actions.setWpm(wpm + WPM_STEP) } }} />
        )}
        {pace === 'model' && <p className={css.rate}>{t('control.wpm', { wpm: String(snapshot.wpm) })}</p>}
        {pace !== 'live' && (
          <Stepper label={t('control.delay')}
            value={delaySeconds === 0 ? t('control.delayNone') : t('control.delayValue', { seconds: String(delaySeconds) })}
            less={{ label: t('control.lessDelay'), disabled: delaySeconds <= 0, onClick: () => { actions.setDelaySeconds(delaySeconds - 1) } }}
            more={{ label: t('control.moreDelay'), disabled: delaySeconds >= MAX_DELAY_SECONDS, onClick: () => { actions.setDelaySeconds(delaySeconds + 1) } }} />
        )}
      </div>
    </section>
  )
}
