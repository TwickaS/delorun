/**
 * Delorun's button. It renders upstream's `Button`, which owns the native element, focus handling and the pointer and
 * keyboard behaviour, and adds the four Delorun variants and the unavailable state. A pressed button shrinks to
 * `--dl-scale-pressed`, and hover applies only under a fine pointer that can hover.
 * @module @delorun/brand/components/Button
 */
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { Button as UpstreamButton } from '#upstream'
import css from './Button.module.css'

/** The Delorun variants: `primary` (peach fill), `secondary` (outline), `destructive` (outline in the error colour) and `ghost`. */
export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost'

/** The props of {@link Button}: a native button's, plus the variant, the size, a leading icon and the unavailable state. */
export type ButtonProps = {
  readonly variant?: ButtonVariant
  /**
   * Shown but not usable yet, such as a download with no address: the button is marked `aria-disabled`, stays focusable
   * so a screen reader reaches it and the note that `aria-describedby` names, and ignores presses. Unlike `disabled`, it
   * keeps its place in the tab order.
   */
  readonly unavailable?: boolean
  readonly size?: 'md' | 'sm'
  readonly icon?: ReactNode
  readonly className?: string | undefined
} & ButtonHTMLAttributes<HTMLButtonElement>

/**
 * Render a button.
 * @param props - see {@link ButtonProps}; `variant` defaults to `secondary`.
 * @param ref - the native button.
 * @returns the button.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', unavailable = false, className, onClick, ...rest }, ref) {
  const upstream = variant === 'primary' ? 'primary' : variant === 'ghost' ? 'ghost' : 'outline'
  const press = unavailable ? (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault() } : onClick
  return <UpstreamButton ref={ref} variant={upstream} size={size} className={`${css.button} ${css[variant]} ${className ?? ''}`.trim()} data-variant={variant} {...rest} {...(unavailable ? { 'aria-disabled': true } : {})} onClick={press} />
})
