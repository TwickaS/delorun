/**
 * A state line: one full-width row with an icon and a message, placed under the control it describes and never beside
 * a button. The message wraps and is never cut off. Green means success only.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import css from './StateLine.module.css'

/** What the line reports. */
export type StateTone = 'loading' | 'success' | 'info' | 'warning' | 'error'

/** The mark of each state. */
const MARKS: Readonly<Record<StateTone, string>> = { loading: '…', success: '✓', info: 'i', warning: '!', error: '✕' }

/** The props of the line. */
export interface StateLineProps {
  /** What the line reports. */
  readonly tone: StateTone
  /** What it says, including what to do next on a warning or an error. */
  readonly children: ReactNode
  /** A button that retries or fixes it. */
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

/**
 * The state line.
 * @param props - the state, its message and an optional action.
 * @returns the row.
 */
export function StateLine({ tone, children, action }: StateLineProps): ReactNode {
  return (
    <div className={css.line} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={css.mark} aria-hidden="true">{MARKS[tone]}</span>
      <span className={css.text}>{children}</span>
      {action !== undefined && <Button variant="outline" size="sm" className={css.action} onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
