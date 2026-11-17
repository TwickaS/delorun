/**
 * The studio replica as the page places it. On the server it writes the live replica's first render (the still, the
 * first caption, the chapter rail and, for scripts off, every caption) as static markup; in the browser it keeps that
 * markup without the code that drew it, and when the frame nears the screen it loads `ReplicaLive.tsx` as a chunk of its
 * own, which takes the same place and plays, keeping the stills the server drew. So the page's start script carries
 * only this shell; the server's markup carries its own styles, so it is styled before any script runs.
 * The frame owns its failure: if the chunk fails to load, the server's markup stays; if the live replica throws while
 * rendering, the server's markup comes back in its place. A chunk that fails to load leaves the still and its caption and
 * hides the chapter rail and Pause, which would do nothing. Either way the still and its caption stay and the rest of the
 * page is untouched, so a page that places a frame needs no guard of its own for it.
 * @module @delorun/website/replica/ReplicaFrame
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { island } from 'virtual:replica-island'
import { ChunkBoundary } from '../components/chunk-boundary.tsx'
import type { SessionId } from './model.ts'
import type { ReplicaLiveProps } from './ReplicaLive.tsx'
import type { ReplicaWidth } from './screens/StudioLayout.tsx'
import { STILL_ATTRIBUTE } from './wrapper.ts'

/** The props of {@link ReplicaFrame}. */
export interface ReplicaFrameProps {
  readonly session: SessionId
  /** See `ReplicaLiveProps`: one width, `pair`, or `responsive`. */
  readonly width: ReplicaLiveProps['width']
  /** Classes for the element that holds the replica. */
  readonly className?: string | undefined
}

/**
 * The stills the server drew inside an element, by width.
 * @param root - the element that holds the server's markup.
 * @returns each still's inner markup.
 */
function serverStills(root: Element): Partial<Record<ReplicaWidth, string>> {
  const stills: Partial<Record<ReplicaWidth, string>> = {}
  for (const element of root.querySelectorAll(`[${STILL_ATTRIBUTE}]`)) {
    const width = element.getAttribute(STILL_ATTRIBUTE)
    if (width === 'desktop' || width === 'phone') stills[width] = element.innerHTML
  }
  return stills
}

/**
 * Render the replica: the server's markup until the live replica's chunk arrives, then the live replica.
 * @param props - see {@link ReplicaFrameProps}.
 * @returns the replica.
 */
export function ReplicaFrame({ session, width, className }: ReplicaFrameProps) {
  const box = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<{
    readonly Live: ComponentType<ReplicaLiveProps>
    readonly stills: Partial<Record<ReplicaWidth, string>>
    /** The server's markup, which comes back if the live replica throws. */
    readonly markup: string
  } | undefined>()
  /** True when the live chunk failed to load: the rail and Pause then cannot work, so the frame hides them. */
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const target = box.current
    if (target === null) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      import('./ReplicaLive.tsx').then(
        (module) => { setLive({ Live: module.ReplicaLive, stills: serverStills(target), markup: target.innerHTML }) },
        // The server's markup stays: the still and its caption. The rail and Pause, which would do nothing, are hidden.
        (error: unknown) => { console.error('The studio replay did not load.', error); setFailed(true) },
      )
    }, { rootMargin: '100% 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [])
  // The browser's `island` is empty: React keeps the server's markup, since the prop never changes until the live
  // replica replaces it in one commit.
  return live === undefined
    ? <>
        <div ref={box} className={className} dangerouslySetInnerHTML={{ __html: island({ session, width }) }} suppressHydrationWarning data-replay-failed={failed ? '' : undefined} />
        {failed ? <style>{'[data-replay-failed] [data-scripted]{display:none!important}'}</style> : null}
      </>
    : <div ref={box} className={className}>
        <ChunkBoundary fallback={<div dangerouslySetInnerHTML={{ __html: live.markup }} />}>
          <live.Live session={session} width={width} stills={live.stills} />
        </ChunkBoundary>
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
