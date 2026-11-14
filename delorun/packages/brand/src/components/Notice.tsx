/**
 * An in-place notice: an optional icon, a bold title, a sentence and optional actions. The live-region role is the
 * caller's choice, because only the caller knows whether the notice interrupts.
 * @module @delorun/brand/components/Notice
 */
import type { ComponentType, ReactNode, SVGProps } from 'react'
import css from './Notice.module.css'

/** An icon component that accepts SVG props, such as the studio's sprite icons. */
export type NoticeIcon = ComponentType<SVGProps<SVGSVGElement>>

/** The tones of a {@link Notice}. */
export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

/** The props of {@link Notice}. */
export interface NoticeProps {
  readonly tone?: NoticeTone
  /** `status` (polite, the default) or `alert` (assertive) for a failure the person must see now. */
  readonly role?: 'status' | 'alert'
  readonly Icon?: NoticeIcon | undefined
  readonly title: string
  /** A `data-outcome` value, which tests and styles may select. */
  readonly outcome?: string | undefined
  /** The sentence. */
  readonly children?: ReactNode
  /** Buttons or links under the sentence. */
  readonly actions?: ReactNode
}

/**
 * Render a notice.
 * @param props - see {@link NoticeProps}; `tone` defaults to `info`.
 * @returns the notice.
 */
export function Notice({ tone = 'info', role = 'status', Icon, title, outcome, children, actions }: NoticeProps) {
  return (
    <div className={css.notice} role={role} data-tone={tone} data-outcome={outcome}>
      {Icon === undefined ? null : <Icon className={css.icon} aria-hidden="true" />}
      <div className={css.text}>
        <strong className={css.title}>{title}</strong>
        {children === undefined ? null : <span>{children}</span>}
        {actions === undefined ? null : <div className={css.actions}>{actions}</div>}
      </div>
    </div>
  )
}
