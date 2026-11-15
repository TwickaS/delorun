/**
 * The Delorun mark, the hex jack: a hexagonal nut whose round hole shows the page, with a plug in the brand colour. This
 * is the one drawing; the favicons, the sidebar and the sites render it from here, and `tests/mark.spec.ts` keeps the
 * static favicon files equal to it.
 *
 * @module @delorun/brand/mark
 */

import { MARK } from './mark-data.ts'

export { MARK }

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
