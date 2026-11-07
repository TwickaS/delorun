/**
 * Delo's sidebar brand occupants: the product name as a text wordmark, and no mark until an official Delo icon is
 * approved. They replace the default brand that upstream's sidebar draws when no occupant is registered.
 */
import styles from './brand.module.css'

/** The product name the sidebar shows. Brand text, not translated copy. */
export const PRODUCT_NAME = 'Delo'

/**
 * Render the product name as the sidebar's brand name.
 * @returns the wordmark.
 */
export function DeloBrandName() {
  return <span className={styles.name}>{PRODUCT_NAME}</span>
}

/**
 * Render the sidebar's brand mark. Delo has no approved icon yet, so the slot draws nothing and the default mark is
 * not shown.
 * @returns nothing.
 */
export function DeloBrandMark() {
  return null
}
