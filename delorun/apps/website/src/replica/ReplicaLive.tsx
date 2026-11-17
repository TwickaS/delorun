/**
 * The studio replica, live: the brand's `Frame` at a fixed size with the session's still, the live drawn
 * studio once the frame nears the screen, the chapter's caption, and the chapter rail with pause and replay. The drawn
 * studio is inert; the caption is its text alternative and is announced when the chapter changes. With scripts off the
 * page shows the still and every chapter's caption as a list; under reduced motion each chapter is a still.
 * As a pair, the desktop width and the phone width play the same chapter together under one rail, offset; where the
 * pair is narrower than {@link PAIR_WIDE}, only the phone width shows. Each session's frame is sized to its content ({@link REPLICA_BOXES}), and the frame keeps
 * that size from the first paint, so nothing moves when the live studio arrives.
 * The page places it through `ReplicaFrame.tsx`, which sends this component's first render as static markup and loads
 * this module as a chunk of its own when the frame nears the screen.
 * @module @delorun/website/replica/ReplicaLive
 */
import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from 'react'
import { Button } from '@brand/components/Button.tsx'
import { Frame } from '@brand/components/Frame.tsx'
import { TabList, TabPanel } from '@brand/components/TabList.tsx'
import { REPLICA_COPY } from './copy.ts'
import { openingChapter, type ChapterFile, type PressTarget, type SessionId } from './model.ts'
import { usePlayer } from './player.ts'
import type { ReplicaWidth } from './screens/StudioLayout.tsx'
import { CHAPTER_FILES } from './sessions/index.ts'
import { Still } from './Still.tsx'
import type { StudioHandle, StudioProps } from './ReplicaStudio.tsx'
import css from './ReplicaLive.module.css'

/**
 * A drawn studio's size, in CSS pixels. The frame is `width` wide at most and `height` tall where the replica's column
 * is wide enough for it; the stylesheet (`ReplicaLive.module.css`) gives it the other heights where the column is
 * narrower, since the drawn studio does not scale: its text wraps onto more lines instead, and a card or a chat row
 * that no longer fits would be cut off.
 */
export interface ReplicaBox {
  readonly width: number
  readonly height: number
  /** The height in a column narrower than 400 px (a phone slot), 350 px (a pair's phone slot) or 900 px (a desktop slot). */
  readonly mid?: number | undefined
  /** The height in a column narrower than 310 px (phone slots). */
  readonly narrow?: number | undefined
  /** The height of a phone slot beside the desktop slot in a pair (a column of 900 px or wider). */
  readonly side?: number | undefined
}

/** The frames a session has: one per slot, and the pair's own two, which hold the same session in other column widths. */
export type SlotKind = ReplicaWidth | 'pair-desktop' | 'pair-phone'

/**
 * Each session's frame at the desktop width, at the phone width on its own, and in a pair, where the phone keeps a
 * phone's proportions and has a bezel. Each is as tall as the session's fullest chapter needs at that width, measured
 * with `preview/heights.ts`, so no chapter leaves the frame mostly empty and none is cut off. The Setup versions chapter
 * scrolls to its list by design and is not part of the measure.
 */
export const REPLICA_BOXES: Readonly<Record<SessionId, Readonly<Record<SlotKind, ReplicaBox>>>> = {
  'ordinary-work': {
    desktop: { width: 960, height: 380, mid: 399 },
    phone: { width: 390, height: 467, narrow: 533 },
    'pair-desktop': { width: 960, height: 423 },
    'pair-phone': { width: 390, height: 465, mid: 507, narrow: 531, side: 571 },
  },
  'changes-and-versions': {
    desktop: { width: 960, height: 380, mid: 400 },
    phone: { width: 390, height: 508, mid: 552, narrow: 612 },
    'pair-desktop': { width: 960, height: 380, mid: 400 },
    'pair-phone': { width: 390, height: 508, mid: 552, narrow: 612 },
  },
}

/**
 * The replica's own width, in CSS pixels, from which a responsive replica draws the desktop width; below it, the phone
 * width. `ReplicaLive.module.css` uses the same width in its container query.
 */
export const WIDE = 700

/**
 * The pair's own width, in CSS pixels, from which it draws the desktop width beside the phone width; below it, the phone
 * width alone. `ReplicaLive.module.css` uses the same width in its container query.
 */
export const PAIR_WIDE = 900

/**
 * The widths a replica lays out: both for `pair` and `responsive`, of which the stylesheet shows the ones that fit.
 * @param width - the replica's width prop.
 * @returns the widths, desktop first.
 */
export function slotWidths(width: ReplicaLiveProps['width']): readonly ReplicaWidth[] {
  return width === 'pair' || width === 'responsive' ? ['desktop', 'phone'] : [width]
}

/**
 * The kind of one slot's frame.
 * @param width - the replica's width prop.
 * @param slot - the slot's width.
 * @returns the kind: the slot's own, or the pair's.
 */
export function kindOf(width: ReplicaLiveProps['width'], slot: ReplicaWidth): SlotKind {
  return width === 'pair' ? `pair-${slot}` : slot
}

/**
 * The size of one slot's frame.
 * @param session - the session.
 * @param width - the replica's width prop.
 * @param slot - the slot's width.
 * @returns the box.
 */
export function boxOf(session: SessionId, width: ReplicaLiveProps['width'], slot: ReplicaWidth): ReplicaBox {
  return REPLICA_BOXES[session][kindOf(width, slot)]
}

/**
 * The widths a replica draws now, from the width of its own element.
 * @param element - the replica's element.
 * @param width - the replica's width prop.
 * @returns the widths that fit; on the server and before the first measure, every slot, so each still is in the page.
 */
function useLiveWidths(element: RefObject<Element | null>, width: ReplicaLiveProps['width']): readonly ReplicaWidth[] {
  const threshold = width === 'responsive' ? WIDE : width === 'pair' ? PAIR_WIDE : undefined
  const [wide, setWide] = useState<boolean | undefined>()
  useEffect(() => {
    const target = element.current
    if (target === null || threshold === undefined) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries.at(-1)?.contentRect.width
      if (measured !== undefined) setWide(measured >= threshold)
    })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [element, threshold])
  if (threshold === undefined || wide === undefined) return slotWidths(width)
  if (width === 'pair') return wide ? ['desktop', 'phone'] : ['phone']
  return wide ? ['desktop'] : ['phone']
}

/**
 * Keep the chosen chapter's tab in view when the rail scrolls sideways, as on a phone. It moves only the rail, never the page.
 * @param controls - the element that holds the rail.
 * @param chapter - the chapter's index.
 */
function useRailFollows(controls: RefObject<HTMLElement | null>, chapter: number): void {
  useEffect(() => {
    const list = controls.current?.querySelector<HTMLElement>('[role="tablist"]')
    const tab = list?.querySelectorAll<HTMLElement>('[role="tab"]')[chapter]
    if (list == null || tab === undefined || list.scrollWidth <= list.clientWidth) return
    const left = tab.offsetLeft - list.offsetLeft
    if (left < list.scrollLeft) list.scrollLeft = left
    else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + tab.offsetWidth - list.clientWidth
  }, [controls, chapter])
}

/** The props of {@link ReplicaLive}. */
export interface ReplicaLiveProps {
  readonly session: SessionId
  /**
   * One width; `pair`, the desktop and phone widths side by side, playing together under one rail; or `responsive`, the
   * desktop width when the replica's own column is {@link WIDE} pixels or wider and the phone width below it, chosen by
   * the stylesheet, with only the shown one loaded.
   */
  readonly width: ReplicaWidth | 'pair' | 'responsive'
  readonly className?: string | undefined
  /** The id of the chapter the replay opens on and plays again from; the first chapter when absent. */
  readonly opens?: string | undefined
  /**
   * Each slot's still as markup: the server draws it from the session's fixture (`StillScene.tsx`), and in the browser
   * `ReplicaFrame` hands back the markup the server sent, so the live replica keeps the same still without the fixture's
   * code. Without it, the still is the empty studio of `Still.tsx`.
   */
  readonly stills?: Partial<Record<ReplicaWidth, string>> | undefined
}

/**
 * Load the drawn studio once an element comes within a screen of the view.
 * @param element - the element.
 * @returns the drawn studio, once loaded.
 */
function useStudioNear(element: RefObject<Element | null>): ComponentType<StudioProps> | undefined {
  const [Studio, setStudio] = useState<ComponentType<StudioProps> | undefined>()
  useEffect(() => {
    const target = element.current
    if (target === null) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      // Without the drawn studio the frame keeps its still.
      import('./ReplicaStudio.tsx').then((module) => { setStudio(() => module.default) }, (error: unknown) => { console.error('The studio replay did not load.', error) })
    }, { rootMargin: '100% 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [element])
  return Studio
}

/**
 * Render the replica.
 * @param props - see {@link ReplicaLiveProps}.
 * @returns the replica with its caption and rail.
 */
export function ReplicaLive({ session, width, className, opens, stills }: ReplicaLiveProps) {
  const file: ChapterFile = CHAPTER_FILES[session]
  const widths = slotWidths(width)
  const frame = useRef<HTMLDivElement>(null)
  const live = useLiveWidths(frame, width)
  const studios = useRef(new Map<ReplicaWidth, StudioHandle>())
  const [readyWidths, setReadyWidths] = useState<readonly ReplicaWidth[]>([])
  const ready = live.every(each => readyWidths.includes(each))
  const Studio = useStudioNear(frame)
  const press = useCallback(async (target: PressTarget) => (await Promise.all([...studios.current.values()].map(handle => handle.press(target)))).some(Boolean), [])
  const opening = openingChapter(file, opens)
  const player = usePlayer({ file, ready, frame, press, opening })
  const rail = useRef<HTMLDivElement>(null)
  useRailFollows(rail, player.chapter)
  const idBase = useId()
  const current = file.chapters[player.chapter]
  const chapterIds = file.chapters.map(chapter => chapter.id)
  return <div className={`${css.replica} ${className ?? ''}`.trim()} data-width={width}>
    <TabPanel idBase={idBase} selected={current?.id ?? ''} className={css.panel}>
      <div ref={frame} className={css.frames} data-width={width}>
        {widths.map((each) => {
          const box = boxOf(session, width, each)
          const device = width === 'pair' && each === 'phone'
          const heights = { '--h': `${String(box.height)}px`, '--h-mid': box.mid === undefined ? undefined : `${String(box.mid)}px`, '--h-narrow': box.narrow === undefined ? undefined : `${String(box.narrow)}px`, '--h-side': box.side === undefined ? undefined : `${String(box.side)}px` } as CSSProperties
          return <div key={each} className={css.slot} data-slot={each} data-device={device ? '' : undefined} style={heights}>
            {device ? <div className={css.statusBar} aria-hidden="true"><span className={css.island} /></div> : null}
            <Frame width={box.width} height={box.height} label={REPLICA_COPY.frame[session]} still={<Still file={file} width={each} markup={stills?.[each]} />} ready={ready}>
              {Studio === undefined || !live.includes(each) ? null : <Studio file={file} width={each} state={player.state} epoch={player.epoch}
                handle={(handle) => { if (handle === null) studios.current.delete(each); else studios.current.set(each, handle) }}
                onReady={() => { setReadyWidths(list => list.includes(each) ? list : [...list, each]) }} />}
            </Frame>
          </div>
        })}
      </div>
      <p className={css.caption} aria-live="polite" data-scripted="">{current?.caption}</p>
    </TabPanel>
    <div ref={rail} className={css.controls} data-scripted="">
      <TabList label={REPLICA_COPY.rail} idBase={idBase} className={css.rail}
        tabs={file.chapters.map(chapter => ({ id: chapter.id, label: chapter.title }))}
        selected={current?.id ?? ''} onSelect={(id) => { player.select(Math.max(0, chapterIds.indexOf(id))) }} />
      {player.reduced ? null : <Button variant="ghost" onClick={player.toggle} className={css.toggle}>
        {player.ended ? REPLICA_COPY.replay : player.paused ? REPLICA_COPY.play : REPLICA_COPY.pause}
      </Button>}
    </div>
    <noscript>
      <style>{`[data-scripted]{display:none!important}[data-later]{display:contents!important}[data-start-only]{display:none!important}[data-still-chat] [role=log]{justify-content:flex-end!important}`}</style>
      <ol className={css.captions}>{file.chapters.map(chapter => <li key={chapter.id}><strong>{chapter.title}.</strong> {chapter.caption}</li>)}</ol>
    </noscript>
  </div>
}
