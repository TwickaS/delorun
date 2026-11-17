/**
 * The Delorun mark as the sites draw it: the plug is always peach, whatever look the visitor chose (the brand's `Mark`
 * takes `--dl-accent`, which a look changes).
 *
 * @module @delorun/site-design/product-mark
 */
import type { CSSProperties } from 'react'
import { Mark } from '../../brand/src/mark.tsx'

const PEACH: CSSProperties = { '--dl-accent': 'var(--dl-peach)', display: 'inline-flex' } as CSSProperties

/**
 * The mark with a peach plug.
 * @param props.size - the width and height in pixels.
 * @returns the mark.
 */
export function ProductMark({ size = 28 }: { size?: number }) {
  return <span style={PEACH}><Mark size={size} /></span>
}
