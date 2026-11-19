/**
 * A link drawn as the brand's button: the same stylesheet, variants and states as {@link Button} (hover only under a real
 * pointer, pressed shrink, focus ring, the unavailable state), on an `<a>`. The studio has no use for it and its button
 * primitive is upstream's, so this module is the sites' only and is not exported from the index.
 * @module @delorun/brand/button-link
 */
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import type { ButtonVariant } from './components/Button.tsx'
import buttonCss from './components/Button.module.css'
import baseCss from './upstream.web.module.css'

/** The props of {@link ButtonLink}: an anchor's, plus the variant, the size, a leading icon and the unavailable state. */
export type ButtonLinkProps = {
  readonly variant?: ButtonVariant
  /**
   * Shown but not usable yet, such as a download with no address: the link keeps its place in the tab order and is marked
   * `aria-disabled`, so a screen reader reaches it and the note that `aria-describedby` names, and it does not navigate.
   */
  readonly unavailable?: boolean
  readonly size?: 'md' | 'sm'
  readonly icon?: ReactNode
  readonly className?: string | undefined
} & AnchorHTMLAttributes<HTMLAnchorElement>

/**
 * Render a link as a button.
 * @param props - see {@link ButtonLinkProps}; `variant` defaults to `secondary`.
 * @param ref - the anchor.
 * @returns the anchor. An unavailable link has no `href`, since an anchor without one is not a link to follow, and it
 *   keeps `role="link"` and a tab stop, so assistive technology still announces it and the keyboard reaches it.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink({ variant = 'secondary', size = 'md', unavailable = false, icon, className, onClick, children, href, ...rest }, ref) {
  const press = unavailable ? (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault() } : onClick
  const classes = [baseCss.button, baseCss[size], buttonCss.button, buttonCss[variant], className].filter(Boolean).join(' ')
  return (
    <a ref={ref} className={classes} data-variant={variant} {...rest} {...unavailable ? { 'aria-disabled': true, role: 'link', tabIndex: 0 } : { href }} onClick={press}>
      {icon == null ? null : <span className={baseCss.icon}>{icon}</span>}
      {children}
    </a>
  )
})
