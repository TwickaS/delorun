/**
 * A notice: a short message at the top of a step, with the longer text behind a "Read more" disclosure. Used for the
 * preview notice and for warnings that concern the whole step.
 */
import type { ReactNode } from 'react'
import css from './Notice.module.css'

/** The props of the notice. */
export interface NoticeProps {
  /** A warning is amber; the default is neutral. */
  readonly tone?: 'warning'
  /** A heading. */
  readonly title?: string
  /** The message: one or two sentences. */
  readonly children: ReactNode
  /** The longer text, shown behind the disclosure. */
  readonly more?: ReactNode
  /** The disclosure's text. */
  readonly moreLabel?: string
}

/**
 * The notice.
 * @param props - the message and what sits behind the disclosure.
 * @returns the notice.
 */
export function Notice({ tone, title, children, more, moreLabel }: NoticeProps): ReactNode {
  return (
    <div className={css.notice} data-tone={tone} role={tone === 'warning' ? 'status' : undefined}>
      {title !== undefined && <h3 className={css.title}>{title}</h3>}
      <p className={css.text}>{children}</p>
      {more !== undefined && (
        <details className={css.details}>
          <summary className={css.summary}>{moreLabel}</summary>
          <div className={css.more}>{more}</div>
        </details>
      )}
    </div>
  )
}
