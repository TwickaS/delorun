/**
 * Delorun's button. It renders upstream's `Button`, which owns the native element, focus handling and the pointer and
 * keyboard behaviour, and adds the four Delorun variants.
 * @module @delorun/brand/components/Button
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Button as UpstreamButton } from '#upstream'
import css from './Button.module.css'

/** The Delorun variants: `primary` (peach fill), `secondary` (outline), `destructive` (outline in the error colour) and `ghost`. */
export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost'

/** The props of {@link Button}: a native button's, plus the variant, the size and a leading icon. */
export type ButtonProps = {
  readonly variant?: ButtonVariant
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
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', className, ...rest }, ref) {
  const upstream = variant === 'primary' ? 'primary' : variant === 'ghost' ? 'ghost' : 'outline'
  return <UpstreamButton ref={ref} variant={upstream} size={size} className={`${css.button} ${css[variant]} ${className ?? ''}`.trim()} data-variant={variant} {...rest} />
})
