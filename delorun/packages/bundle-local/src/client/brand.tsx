/**
 * Delorun's sidebar brand occupants: the hex jack mark and the brand name. They replace the default brand that
 * upstream's sidebar draws when no occupant is registered, in the wide sidebar and, for the mark, the folded rail.
 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MARK } from '@delorun/brand/mark'
import styles from './brand.module.css'

/** The product name the page title uses. Brand text, not translated copy. */
export const PRODUCT_NAME = 'Delorun'

/** The name the sidebar's brand row shows, one word in every language. Brand text, not translated copy. */
export const BRAND_NAME = 'Delorun'

/**
 * Render the brand name as the sidebar's brand name.
 * @returns the wordmark.
 */
export function DelorunBrandName() {
  return <span className={styles.name}>{BRAND_NAME}</span>
}

/**
 * Render the sidebar's brand mark: the hex jack, its nut in the brand row's text colour and its plug in the accent, so a
 * custom accent recolours it.
 * @param props - the square edge, in pixels, that the sidebar asks for.
 * @returns the mark, hidden from assistive technology; the brand row names the product.
 */
export function DelorunBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-delorun-mark="">
      <path d={MARK.nut} fill="currentColor" fillRule="evenodd" />
      <circle className={styles.plug} cx={MARK.plug.cx} cy={MARK.plug.cy} r={MARK.plug.r} />
    </svg>
  )
}
