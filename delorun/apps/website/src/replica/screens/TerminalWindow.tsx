/**
 * The terminal window the terminal chapter draws in the frame's box in place of the studio: a title bar with three dots
 * and a monospace body that shows the typed command and, once it is typed, the lines the command printed. It is a plain
 * terminal, not a page of the studio, so it has no sidebar and no title.
 * @module @delorun/website/replica/screens/TerminalWindow
 */
import type { ReplicaFixture, StudioState } from '../model.ts'
import css from './studio.module.css'

/** The props of {@link TerminalWindow}. */
export interface TerminalWindowProps {
  /** The terminal state: the command typed so far, and whether its output shows. */
  readonly terminal: StudioState['terminal']
  /** What the command printed; absent before the session's fixture arrives. */
  readonly output: NonNullable<ReplicaFixture['terminal']>['output']
}

/**
 * Render the terminal window.
 * @param props - see {@link TerminalWindowProps}.
 * @returns the window.
 */
export function TerminalWindow({ terminal, output }: TerminalWindowProps) {
  return <div className={css.terminalWindow} data-part="terminal">
    <div className={css.terminalBar} aria-hidden="true"><span className={css.terminalDot} /><span className={css.terminalDot} /><span className={css.terminalDot} /></div>
    <pre className={css.terminalBody}>
      <span className={css.prompt}>$ </span>{terminal.typed}
      {terminal.ran ? <>{'\n'}{output.join('\n')}{'\n'}</> : null}
    </pre>
  </div>
}
