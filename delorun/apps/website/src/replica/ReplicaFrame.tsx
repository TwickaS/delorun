/**
 * The studio replica as the page places it. On the server it writes the live replica's first render (the still, the
 * first caption, the chapter rail and, for scripts off, every caption) as static markup; in the browser it keeps that
 * markup without the code that drew it, and when the frame nears the screen it loads `ReplicaLive.tsx` as a chunk of its
 * own, which takes the same place and plays. So the page's start script carries only this shell; the server's markup
 * carries its own styles, so it is styled before any script runs.
 * @module @delorun/website/replica/ReplicaFrame
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { island } from 'virtual:replica-island'
import type { SessionId } from './model.ts'
import type { ReplicaLiveProps } from './ReplicaLive.tsx'

/** The props of {@link ReplicaFrame}. */
export interface ReplicaFrameProps {
  readonly session: SessionId
  /** See `ReplicaLiveProps`: one width, `pair`, or `responsive`. */
  readonly width: ReplicaLiveProps['width']
  /** Classes for the element that holds the replica. */
  readonly className?: string | undefined
}

/**
 * Render the replica: the server's markup until the live replica's chunk arrives, then the live replica.
 * @param props - see {@link ReplicaFrameProps}.
 * @returns the replica.
 */
export function ReplicaFrame({ session, width, className }: ReplicaFrameProps) {
  const box = useRef<HTMLDivElement>(null)
  const [Live, setLive] = useState<ComponentType<ReplicaLiveProps> | undefined>()
  useEffect(() => {
    const target = box.current
    if (target === null) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void import('./ReplicaLive.tsx').then((module) => { setLive(() => module.ReplicaLive) })
    }, { rootMargin: '100% 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [])
  // The browser's `island` is empty: React keeps the server's markup, since the prop never changes until the live
  // replica replaces it in one commit.
  return Live === undefined
    ? <div ref={box} className={className} dangerouslySetInnerHTML={{ __html: island({ session, width }) }} suppressHydrationWarning />
    : <div ref={box} className={className}><Live session={session} width={width} /></div>
}

/**
 * The phone section's replica: a session at the desktop width and the phone width side by side.
 * @param props - the session.
 * @returns the pair.
 */
export function ReplicaPair({ session, className }: { readonly session: SessionId, readonly className?: string | undefined }) {
  return <ReplicaFrame session={session} width="pair" className={className} />
}
