/**
 * The terminal window the terminal chapter draws in the frame's box in place of the studio: a title bar with three dots
 * and a monospace body that shows the typed command and, once it is typed, the lines the command printed. It is a plain
 * terminal, not a page of the studio, so it has no sidebar and no title.
 * @module @delorun/website/replica/screens/TerminalWindow
 */
import { Fragment } from 'react'
import type { ReplicaFixture, StudioState } from '../model.ts'
import css from './live.module.css'

/** The props of {@link TerminalWindow}. */
export interface TerminalWindowProps {
  /** The terminal state: the command typed so far, and whether its output shows. */
  readonly terminal: StudioState['terminal']
  /** What the command printed; absent before the session's fixture arrives. */
  readonly output: NonNullable<ReplicaFixture['terminal']>['output']
}

/**
 * A line that breaks only at spaces and after a path separator: each run of characters between them is one unbreakable
 * word, so a narrow window wraps a path at its directories and never inside a name, not even at a hyphen.
 * @param line - the text.
 * @returns the text with its words kept whole and a break opportunity after each `/`.
 */
function breakable(line: string) {
  return line.split(/( +)/).map((word, index) => word.startsWith(' ')
    ? word
    : <Fragment key={index}>{word.split(/(?<=\/)/).map((part, at) => <Fragment key={at}>{at === 0 ? null : <wbr />}<span className={css.word}>{part}</span></Fragment>)}</Fragment>)
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
      <span className={css.prompt}>$ </span>{breakable(terminal.typed)}
      {terminal.ran ? <>{'\n'}{output.map((line, index) => <Fragment key={index}>{index === 0 ? null : '\n'}{breakable(line)}</Fragment>)}{'\n'}</> : null}
    </pre>
  </div>
}
