/**
 * The studio replica as the page places it: the brand's `Frame` at a fixed size with the session's still, the live drawn
 * studio once the frame nears the screen, the chapter's caption, and the chapter rail with pause and replay. The drawn
 * studio is inert; the caption is its text alternative and is announced when the chapter changes. With scripts off the
 * page shows the still and every chapter's caption as a list; under reduced motion each chapter is a still.
 * As a pair, the desktop width and the phone width play the same chapter together, offset, and on a narrow screen the
 * phone width comes first and the desktop width scrolls sideways.
 * @module @delorun/website/replica/ReplicaFrame
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from 'react'
import { Button, Frame, TabList, TabPanel } from '@brand'
import { REPLICA_COPY } from './copy.ts'
import type { PressTarget, SessionId } from './model.ts'
import { usePlayer } from './player.ts'
import type { ReplicaWidth } from './screens/StudioLayout.tsx'
import { CHAPTER_FILES } from './sessions/index.ts'
import { Still } from './Still.tsx'
import type { StudioHandle, StudioProps } from './Studio.tsx'
import css from './ReplicaFrame.module.css'

/** The drawn studio's size at each width, in CSS pixels; the frame keeps this aspect ratio and never grows past it. */
export const REPLICA_BOXES: Readonly<Record<ReplicaWidth, { readonly width: number, readonly height: number }>> = {
  desktop: { width: 960, height: 640 },
  phone: { width: 390, height: 760 },
}

/** The media query from which a responsive replica draws the desktop width; `ReplicaFrame.module.css` uses the same width. */
export const WIDE = '(min-width: 1024px)'

/**
 * The widths a responsive replica may draw now.
 * @returns the width the media query picks; on the server, both, so each still is in the page.
 */
function useResponsiveWidth(): readonly ReplicaWidth[] {
  const wide = useSyncExternalStore(
    (listener) => {
      const query = matchMedia(WIDE)
      query.addEventListener('change', listener)
      return () => { query.removeEventListener('change', listener) }
    },
    () => matchMedia(WIDE).matches ? 'wide' : 'narrow',
    () => 'both',
  )
  return wide === 'both' ? ['desktop', 'phone'] : wide === 'wide' ? ['desktop'] : ['phone']
}

/** The props of {@link ReplicaFrame}. */
export interface ReplicaFrameProps {
  readonly session: SessionId
  /**
   * One width; `pair`, the desktop and phone widths side by side, playing together under one rail; or `responsive`, the
   * desktop width from {@link WIDE} up and the phone width below it, chosen by the stylesheet, with only the shown one
   * loaded.
   */
  readonly width: ReplicaWidth | 'pair' | 'responsive'
  readonly className?: string | undefined
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
      void import('./Studio.tsx').then((module) => { setStudio(() => module.default) })
    }, { rootMargin: '100% 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [element])
  return Studio
}

/**
 * Render the replica.
 * @param props - see {@link ReplicaFrameProps}.
 * @returns the replica with its caption and rail.
 */
export function ReplicaFrame({ session, width, className }: ReplicaFrameProps) {
  const file = CHAPTER_FILES[session]
  const widths: readonly ReplicaWidth[] = width === 'pair' || width === 'responsive' ? ['desktop', 'phone'] : [width]
  const responsive = useResponsiveWidth()
  const live = width === 'responsive' ? responsive : widths
  const frame = useRef<HTMLDivElement>(null)
  const studios = useRef(new Map<ReplicaWidth, StudioHandle>())
  const [readyWidths, setReadyWidths] = useState<readonly ReplicaWidth[]>([])
  const ready = live.every(each => readyWidths.includes(each))
  const Studio = useStudioNear(frame)
  const press = useCallback(async (target: PressTarget) => (await Promise.all([...studios.current.values()].map(handle => handle.press(target)))).some(Boolean), [])
  const player = usePlayer({ file, ready, frame, press })
  const idBase = useId()
  const current = file.chapters[player.chapter]
  const chapterIds = file.chapters.map(chapter => chapter.id)
  return <div className={`${css.replica} ${className ?? ''}`.trim()} data-width={width}>
    <TabPanel idBase={idBase} selected={current?.id ?? ''} className={css.panel}>
      <div ref={frame} className={css.frames}>
        {widths.map((each) => {
          const box = REPLICA_BOXES[each]
          return <div key={each} className={css.slot} data-slot={each}>
            <Frame width={box.width} height={box.height} label={REPLICA_COPY.frame[session]} still={<Still file={file} width={each} />} ready={ready}>
              {Studio === undefined || !live.includes(each) ? null : <Studio file={file} width={each} state={player.state} epoch={player.epoch}
                handle={(handle) => { if (handle === null) studios.current.delete(each); else studios.current.set(each, handle) }}
                onReady={() => { setReadyWidths(list => list.includes(each) ? list : [...list, each]) }} />}
            </Frame>
          </div>
        })}
      </div>
      <p className={css.caption} aria-live="polite" data-scripted="">{current?.caption}</p>
    </TabPanel>
    <div className={css.controls} data-scripted="">
      <TabList label={REPLICA_COPY.rail} idBase={idBase} className={css.rail}
        tabs={file.chapters.map(chapter => ({ id: chapter.id, label: chapter.title }))}
        selected={current?.id ?? ''} onSelect={(id) => { player.select(Math.max(0, chapterIds.indexOf(id))) }} />
      {player.reduced ? null : <Button variant="ghost" onClick={player.toggle} className={css.toggle}>
        {player.ended ? REPLICA_COPY.replay : player.paused ? REPLICA_COPY.play : REPLICA_COPY.pause}
      </Button>}
    </div>
    <noscript>
      <style>{`[data-scripted]{display:none!important}`}</style>
      <ol className={css.captions}>{file.chapters.map(chapter => <li key={chapter.id}><strong>{chapter.title}.</strong> {chapter.caption}</li>)}</ol>
    </noscript>
  </div>
}

/**
 * The phone section's replica: a session at the desktop width and the phone width side by side.
 * @param props - the session.
 * @returns the pair.
 */
export function ReplicaPair({ session, className }: { readonly session: SessionId, readonly className?: string | undefined }) {
  return <ReplicaFrame session={session} width="pair" className={className} />
}
