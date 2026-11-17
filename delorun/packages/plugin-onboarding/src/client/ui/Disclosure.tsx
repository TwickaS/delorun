/**
 * A disclosure: one full-width button that opens a group beneath it. Closed by default. The group mounts when it opens,
 * so a closed disclosure holds nothing to tab to or to read, and it slides in unless the person prefers reduced motion.
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import css from './Disclosure.module.css'

/** The props of the disclosure. */
export interface DisclosureProps {
  /** The button's text. */
  readonly label: string
  /** Opens the group from the start; used for a group the person already changed. */
  readonly defaultOpen?: boolean
  /** The group's content. */
  readonly children: ReactNode
  /** `quiet` is the smaller nested form. */
  readonly size?: 'regular' | 'quiet'
}

/**
 * The disclosure.
 * @param props - the button's text, its size and the group.
 * @returns the button and, when open, the group.
 */
export function Disclosure({ label, defaultOpen = false, size = 'regular', children }: DisclosureProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const panel = useId()
  return (
    <div className={css.root} data-size={size}>
      <button type="button" className={css.button} aria-expanded={open} aria-controls={panel} onClick={() => { setOpen(!open) }}>
        <span className={css.chevron} aria-hidden="true" data-open={open ? '' : undefined} />
        <span>{label}</span>
      </button>
      {open && <div id={panel} className={css.panel}>{children}</div>}
    </div>
  )
}
