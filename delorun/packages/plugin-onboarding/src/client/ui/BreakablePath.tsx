/**
 * A filesystem path that wraps only after a slash, so a line never splits inside a folder name or at a hyphen in one.
 */
import type { ReactNode } from 'react'
import css from './BreakablePath.module.css'

/**
 * The path with a break opportunity after each slash; a folder name longer than the line is cut with an ellipsis.
 * @param props - the path.
 * @returns the path's parts.
 */
export function BreakablePath({ path }: { readonly path: string }): ReactNode {
  return <>{path.split(/(?<=[\\/])/).map((part, place) => <span key={`${String(place)}-${part}`}><span className={css.part}>{part}</span><wbr /></span>)}</>
}
