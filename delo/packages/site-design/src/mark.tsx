/**
 * The Delorun mark: a rounded tile with a letter D whose bowl ends in a forward stroke. It draws in the text colour,
 * with the page background showing through the letter, so it follows light and dark without a second file.
 *
 * @module @delo/site-design/mark
 */

/** The mark's drawing, shared by the inline component and the favicon file so the two cannot drift. */
export const MARK_PATHS = {
  tile: 'M8 1h16a7 7 0 0 1 7 7v16a7 7 0 0 1-7 7H8a7 7 0 0 1-7-7V8a7 7 0 0 1 7-7z',
  letter: 'M10.5 8.5v15h5a7.5 7.5 0 0 0 0-15z',
  stroke: 'M17.5 16h5.5',
} as const

/**
 * The mark as an inline image.
 * @param props.size - the width and height in pixels.
 * @param props.title - the accessible name; omit it when text beside the mark already names it.
 * @returns the SVG.
 */
export function Mark({ size = 28, title }: { size?: number, title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title === undefined ? undefined : 'img'} aria-hidden={title === undefined ? true : undefined} aria-label={title} focusable="false">
      <path d={MARK_PATHS.tile} className="fill-fd-foreground" />
      <path d={MARK_PATHS.letter} fill="none" strokeWidth="3" strokeLinejoin="round" className="stroke-fd-background" />
      <path d={MARK_PATHS.stroke} fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-fd-background" />
    </svg>
  )
}
