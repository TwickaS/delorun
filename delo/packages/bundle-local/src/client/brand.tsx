/**
 * Delo's sidebar brand occupants: the hex jack mark and the product name. They replace the default brand that
 * upstream's sidebar draws when no occupant is registered, in the wide sidebar and, for the mark, the folded rail.
 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import styles from './brand.module.css'

/** The product name the sidebar shows. Brand text, not translated copy. */
export const PRODUCT_NAME = 'Delo'

/** The mark's nut: a hexagon whose round hole shows the ground. */
const NUT = 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z M22.6 16A6.6 6.6 0 1 0 9.4 16A6.6 6.6 0 1 0 22.6 16Z'

/**
 * Render the product name as the sidebar's brand name.
 * @returns the wordmark.
 */
export function DeloBrandName() {
  return <span className={styles.name}>{PRODUCT_NAME}</span>
}

/**
 * Render the sidebar's brand mark: the hex jack, its nut in the brand row's text colour and its plug in the accent, so a
 * custom accent recolours it.
 * @param props - the square edge, in pixels, that the sidebar asks for.
 * @returns the mark, hidden from assistive technology; the brand row names the product.
 */
export function DeloBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-delo-mark="">
      <path d={NUT} fill="currentColor" fillRule="evenodd" />
      <circle className={styles.plug} cx="16" cy="16" r="3.6" />
    </svg>
  )
}
