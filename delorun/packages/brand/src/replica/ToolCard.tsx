/**
 * A tool call in the chat: its title, a status capsule, the command and, once there is output, a folded view of it.
 * @module @delorun/brand/replica/ToolCard
 */
import { Pill } from '../components/Pill.tsx'
import css from './ToolCard.module.css'

/** Where a tool call stands. */
export type ToolCardStatus = 'running' | 'done' | 'failed'

/** The capsule tone of each status. */
const TONES = { running: 'neutral', done: 'success', failed: 'error' } as const

/** The props of {@link ToolCard}. */
export interface ToolCardProps {
  /** The localised name of the tool. */
  readonly title: string
  /** The command the tool runs, shown in the monospace face. */
  readonly command: string
  readonly status: ToolCardStatus
  /** The localised text of the status capsule. */
  readonly statusLabel: string
  /** The tool's output; without it the card has no folded section. */
  readonly output?: string | undefined
  /** The localised summary of the folded output. */
  readonly outputLabel: string
  /** Show the output unfolded. */
  readonly open?: boolean | undefined
  readonly className?: string | undefined
}

/**
 * Render a tool card.
 * @param props - see {@link ToolCardProps}.
 * @returns the card, with `data-status` set to the status.
 */
export function ToolCard({ title, command, status, statusLabel, output, outputLabel, open = false, className }: ToolCardProps) {
  return (
    <div className={`${css.card} ${className ?? ''}`.trim()} data-status={status}>
      <div className={css.header}>
        <span className={css.title}>{title}</span>
        <Pill tone={TONES[status]} className={css.status}>
          {status === 'running' ? <span className={css.dot} aria-hidden="true" data-dot /> : null}
          {statusLabel}
        </Pill>
      </div>
      <code className={css.command}>{command}</code>
      {output === undefined ? null : (
        <details className={css.output} open={open}>
          <summary className={css.summary}>{outputLabel}</summary>
          <pre className={css.pre}>{output}</pre>
        </details>
      )}
    </div>
  )
}
