/**
 * A tool call in the chat, drawn as the studio's tool row: the tool's name and its command on one line, as in
 * "Bash · pnpm test". Like the studio it shows no status word: a running call carries a dot and a failed one the error
 * tone, each with its status as hidden text. Once there is output, the row itself folds it open.
 * @module @delorun/brand/replica/ToolCard
 */
import css from './ToolCard.module.css'

/** Where a tool call stands. */
export type ToolCardStatus = 'running' | 'done' | 'failed'

/** The props of {@link ToolCard}. */
export interface ToolCardProps {
  /** The localised name of the tool. */
  readonly title: string
  /** The command the tool runs, shown in the monospace face. */
  readonly command: string
  readonly status: ToolCardStatus
  /** The localised status, read by assistive technology only; the studio shows none for a finished call. */
  readonly statusLabel?: string | undefined
  /** The tool's output; without it the row does not fold open. */
  readonly output?: string | undefined
  /** Show the output unfolded. */
  readonly open?: boolean | undefined
  readonly className?: string | undefined
}

/**
 * Render a tool row.
 * @param props - see {@link ToolCardProps}.
 * @returns the row, with `data-status` set to the status.
 */
export function ToolCard({ title, command, status, statusLabel, output, open = false, className }: ToolCardProps) {
  const row = <>
    <span className={css.title}>{title}</span>
    <span className={css.separator} aria-hidden="true">·</span>
    <code className={css.command}>{command}</code>
    {status === 'running' ? <span className={css.dot} aria-hidden="true" data-dot /> : null}
    {statusLabel === undefined ? null : <span className={css.hidden}>{statusLabel}</span>}
  </>
  return (
    <div className={`${css.card} ${className ?? ''}`.trim()} data-status={status}>
      {output === undefined ? <div className={css.row}>{row}</div> : (
        <details className={css.output} open={open}>
          <summary className={`${css.row} ${css.summary}`}>{row}</summary>
          <pre className={css.pre}>{output}</pre>
        </details>
      )}
    </div>
  )
}
