/**
 * The Delorun mark, the hex jack the studio's sidebar draws: a hexagonal nut in the text colour whose round hole shows
 * the page, with a plug in Delorun's peach accent. It follows light and dark without a second file.
 *
 * @module @delo/site-design/mark
 */

/** The mark's drawing, the same nut and plug as `@delo/bundle-local`'s sidebar mark and the favicon file. */
export const MARK = {
  nut: 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z M22.6 16A6.6 6.6 0 1 0 9.4 16A6.6 6.6 0 1 0 22.6 16Z',
  plug: { cx: 16, cy: 16, r: 3.6 },
  /** Delorun's default accent, Peach (`@delo/plugin-theme`). */
  peach: '#E5734A',
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
      <path d={MARK.nut} fillRule="evenodd" className="fill-fd-foreground" />
      <circle cx={MARK.plug.cx} cy={MARK.plug.cy} r={MARK.plug.r} fill={MARK.peach} />
    </svg>
  )
}
