/**
 * A link in the text-safe peach, which reaches 4.5:1 on a light page, underlined so colour is not the only cue.
 * @module @delorun/brand/components/Link
 */
import { forwardRef, type AnchorHTMLAttributes } from 'react'
import css from './Link.module.css'

/**
 * Render a link.
 * @param props - a native anchor's props.
 * @param ref - the anchor.
 * @returns the anchor.
 */
export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({ className, ...rest }, ref) {
  return <a ref={ref} className={`${css.link} ${className ?? ''}`.trim()} {...rest} />
})
