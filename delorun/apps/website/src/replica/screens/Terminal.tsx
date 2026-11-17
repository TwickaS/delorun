/**
 * The drawn studio's terminal block, for the steps that are commands.
 * @module @delorun/website/replica/screens/Terminal
 */
import type { TerminalLine } from '../model.ts'
import css from './studio.module.css'

/**
 * Render the terminal.
 * @param props - the lines so far.
 * @returns the block.
 */
export function Terminal({ lines }: { readonly lines: readonly TerminalLine[] }) {
  return <pre className={css.terminal}>{lines.map((line, index) => <span key={index} className={css.line} data-kind={line.kind}>{line.kind === 'command' ? `$ ${line.text}` : line.text}{'\n'}</span>)}</pre>
}
