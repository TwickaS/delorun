/**
 * The box a studio replica sits in: the 12 px radius, the theme's line colour and a size fixed by the content's own
 * width and height, so the page never moves when the content arrives. Until then, and with scripts off, the box shows
 * its still; the content then fades in over it.
 * @module @delorun/brand/components/Frame
 */
import type { CSSProperties, ReactNode } from 'react'
import css from './Frame.module.css'

/** The props of {@link Frame}. */
export interface FrameProps {
  /** The content's width in CSS pixels: the frame's widest size, and with `height` its fixed aspect ratio. */
  readonly width: number
  /** The content's height in CSS pixels at `width`. */
  readonly height: number
  /** The localised name of what the frame shows, such as "The studio, editing a theme". */
  readonly label: string
  /** The still: a picture or plain markup that stands for the content until it arrives. */
  readonly still: ReactNode
  /** The live content; while it is absent, or `ready` is false, the still shows. */
  readonly children?: ReactNode
  /** Whether the content is ready to be seen; defaults to whether `children` is given and not null. */
  readonly ready?: boolean
  readonly className?: string | undefined
}

/**
 * Render the frame.
 * @param props - see {@link FrameProps}.
 * @returns a `figure` named by `label`.
 */
export function Frame({ width, height, label, still, children, ready = children != null, className }: FrameProps) {
  const size = { '--frame-width': `${width}px`, aspectRatio: `${width} / ${height}` } as CSSProperties
  return (
    <figure className={`${css.frame} ${className ?? ''}`.trim()} style={size} aria-label={label} data-ready={ready}>
      <div className={css.still} aria-hidden={ready}>{still}</div>
      {children == null ? null : <div className={css.content} aria-hidden={!ready}>{children}</div>}
    </figure>
  )
}
