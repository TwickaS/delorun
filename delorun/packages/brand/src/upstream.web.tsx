/**
 * The same five primitives for pages without a studio, built on the native elements that give the behaviour for free: a
 * `button`, an `input`, a `button` with the `switch` role, and a modal `<dialog>` (focus trap, Escape and return of focus
 * come from the browser). The props are the subset of upstream's that the brand components pass.
 * @module @delorun/brand/upstream.web
 */
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import css from './upstream.web.module.css'

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ')

/** A native button. `variant` is accepted for upstream compatibility; the brand variants style the element. */
export const Button = forwardRef<HTMLButtonElement, { variant?: string, size?: 'md' | 'sm', icon?: ReactNode, className?: string | undefined } & ButtonHTMLAttributes<HTMLButtonElement>>(function Button({ variant: _variant, size = 'md', icon, className, children, ...rest }, ref) {
  return <button ref={ref} type="button" className={join(css.button, css[size], className)} {...rest}>{icon == null ? null : <span className={css.icon}>{icon}</span>}{children}</button>
})

/** A native text input with an optional leading icon. */
export const Input = forwardRef<HTMLInputElement, { icon?: ReactNode, className?: string } & InputHTMLAttributes<HTMLInputElement>>(function Input({ icon, className, ...rest }, ref) {
  return <span className={join(css.wrap, className)}>{icon == null ? null : <span className={css.icon}>{icon}</span>}<input ref={ref} className={css.input} {...rest} /></span>
})

/** A capsule: a button when `onClick` is given, a static span otherwise. */
export function Pill({ active = false, className, children, onClick, ...rest }: { active?: boolean, className?: string | undefined, children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (!onClick) return <span className={join(css.pill, active && css.active, className)}>{children}</span>
  return <button type="button" className={join(css.pill, css.interactive, active && css.active, className)} onClick={onClick} {...rest}>{children}</button>
}

/**
 * A modal `<dialog>` with a heading, a close button, a body and a footer; Escape and the close button call `onClose`.
 * A headless one draws the children alone in the card, and `className` and `contentClassName` reach the card and the
 * region around the header, as upstream's do.
 */
export function Modal({ open, onClose, title, closeLabel, description, children, footer, headless = false, className, contentClassName }: { open: boolean, onClose: () => void, title: string, closeLabel?: string, description?: string | undefined, children?: ReactNode, footer?: ReactNode, tone?: string | undefined, headless?: boolean, className?: string | undefined, contentClassName?: string | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])
  return (
    <dialog ref={dialog} className={join(css.dialog, className)} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose() }}>
      {open ? headless ? children : <>
        <div className={contentClassName}>
          <h2 className={css.heading}>{title}</h2>
          {description === undefined ? null : <p className={css.description}>{description}</p>}
          <div>{children}</div>
        </div>
        {footer === undefined ? null : <div className={css.footer}>{footer}</div>}
        {closeLabel === undefined ? null : <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>×</button>}
      </> : null}
    </dialog>
  )
}

/** A two-state switch: a `button` with the `switch` role whose `aria-checked` carries the state. */
export function Switch({ checked, onChange, label, disabled = false, title, className }: { checked: boolean, onChange: (next: boolean) => void, label: string, disabled?: boolean, title?: string | undefined, className?: string | undefined }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} className={join(css.switch, className)} onClick={() => { onChange(!checked) }}>
      <span className={css.thumb} />
    </button>
  )
}
