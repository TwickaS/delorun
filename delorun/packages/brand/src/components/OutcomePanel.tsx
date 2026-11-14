/**
 * The result of an action shown on its own: a centred icon disc, a heading, a sentence and the next actions, such as
 * a PIN lock's "paused" or "unreachable" outcome. A {@link Notice} sits beside other content; an outcome panel replaces it.
 * @module @delorun/brand/components/OutcomePanel
 */
import type { ReactNode } from 'react'
import type { NoticeIcon, NoticeTone } from './Notice.tsx'
import css from './OutcomePanel.module.css'

/** The props of {@link OutcomePanel}. */
export interface OutcomePanelProps {
  readonly tone?: NoticeTone
  /** `alert` for a failure the person must see now; `status` otherwise. */
  readonly role?: 'status' | 'alert'
  readonly Icon: NoticeIcon
  readonly title: string
  /** A `data-outcome` value, which tests and styles may select. */
  readonly outcome?: string | undefined
  readonly children?: ReactNode
  readonly actions?: ReactNode
}

/**
 * Render an outcome.
 * @param props - see {@link OutcomePanelProps}; `tone` defaults to `info`.
 * @returns the panel.
 */
export function OutcomePanel({ tone = 'info', role = 'status', Icon, title, outcome, children, actions }: OutcomePanelProps) {
  return (
    <div className={css.panel} role={role} data-tone={tone} data-outcome={outcome}>
      <span className={css.disc} aria-hidden="true"><Icon /></span>
      <h2 className={css.title}>{title}</h2>
      {children === undefined ? null : <p className={css.text}>{children}</p>}
      {actions === undefined ? null : <div className={css.actions}>{actions}</div>}
    </div>
  )
}
