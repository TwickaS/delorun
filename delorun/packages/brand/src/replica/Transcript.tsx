/**
 * The scrolling column of a chat. It is a log named by its label and keeps its end in view after every render.
 * @module @delorun/brand/replica/Transcript
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import css from './Transcript.module.css'

/** The props of {@link Transcript}. */
export interface TranscriptProps {
  /** The localised accessible name of the log. */
  readonly label: string
  readonly children: ReactNode
  readonly className?: string | undefined
}

/**
 * Render a transcript.
 * @param props - see {@link TranscriptProps}.
 * @returns the log, scrolled to its end.
 */
export function Transcript({ label, children, className }: TranscriptProps) {
  const log = useRef<HTMLDivElement>(null)
  // No dependency array: the end stays in view whichever child changed, including a tool card that opens.
  useLayoutEffect(() => {
    const element = log.current
    if (element !== null) element.scrollTop = element.scrollHeight
  })
  return <div ref={log} role="log" aria-label={label} className={`${css.transcript} ${className ?? ''}`.trim()}>{children}</div>
}
