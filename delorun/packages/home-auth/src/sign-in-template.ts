/**
 * The sign-in page's markup with the brand's values filled in. `assets/sign-in.html` carries `{{mark}}`,
 * `{{surface-light}}` and `{{surface-dark}}` where the page needs the mark's drawing and the page colours, so the
 * template repeats no brand value; they come from `@delorun/brand`, the one source.
 * @module @delorun/home-auth/sign-in-template
 */
import { MARK } from '@delorun/brand/mark-data'
import { BRAND_SURFACE } from '@delorun/brand/tokens'

/** The hex mark as inline SVG, decorative, with the plug in the brand accent and the nut in the text colour. */
const MARK_SVG = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="${MARK.nut}" fill="currentColor" fill-rule="evenodd"/><circle cx="${String(MARK.plug.cx)}" cy="${String(MARK.plug.cy)}" r="${String(MARK.plug.r)}" fill="var(--dl-accent)"/></svg>`

/**
 * Fill the brand placeholders of the sign-in template.
 * @param template - the text of `assets/sign-in.html`.
 * @returns the markup with the mark and the two `theme-color` values in place; `{{style}}` and `{{script}}` stay for the route.
 */
export function fillBrand(template: string): string {
  return template
    .replace('{{mark}}', () => MARK_SVG)
    .replace('{{surface-light}}', BRAND_SURFACE.light)
    .replace('{{surface-dark}}', BRAND_SURFACE.dark)
}
