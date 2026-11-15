/**
 * The Delorun mark, the hex jack: a hexagonal nut whose round hole shows the page, with a plug in the brand colour. This
 * is the one drawing; the favicons, the sidebar and the sites render it from here, and `tests/mark.spec.ts` keeps the
 * static favicon files equal to it.
 *
 * @module @delorun/brand/mark
 */

/** The mark's drawing in a 32 by 32 box: the nut with its hole (even-odd fill) and the plug's circle. */
export const MARK = {
  nut: 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z M22.6 16A6.6 6.6 0 1 0 9.4 16A6.6 6.6 0 1 0 22.6 16Z',
  plug: { cx: 16, cy: 16, r: 3.6 },
} as const

/**
 * The mark as an inline image. The nut takes the text colour and the plug takes `--dl-accent`, so the mark follows light
 * and dark and the studio's accent.
 * @param props.size - the width and height in pixels.
 * @param props.title - the accessible name; omit it when text beside the mark already names the product.
 * @returns the SVG.
 */
export function Mark({ size = 28, title }: { readonly size?: number, readonly title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title === undefined ? undefined : 'img'} aria-hidden={title === undefined ? true : undefined} aria-label={title} focusable="false" data-delorun-mark="">
      <path d={MARK.nut} fill="currentColor" fillRule="evenodd" />
      <circle cx={MARK.plug.cx} cy={MARK.plug.cy} r={MARK.plug.r} fill="var(--dl-accent, #E5734A)" />
    </svg>
  )
}
