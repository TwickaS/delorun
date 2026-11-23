/**
 * A download's status words with steady numbers: only the digits take the font's fixed-width figures, so a speed or a
 * time left does not jump as it changes, while the decimal point, spaces and units keep their own widths. Setting
 * `tabular-nums` on the whole line instead spreads `5.0` to `5 . 0` in fonts whose tabular point is a digit wide.
 * The panel's rows and the setup guide's cards both draw their status through it.
 */
import type { CSSProperties, ReactNode } from 'react'

const FIXED: CSSProperties = { fontVariantNumeric: 'tabular-nums' }

/**
 * The text with each run of digits in fixed-width figures.
 * @param props - the text.
 * @param props.text - the words to draw.
 * @returns the text; it reads, and is read aloud, the same as the plain string.
 */
export function Figures({ text }: { readonly text: string }): ReactNode {
  const parts = text.split(/(\d+)/u)
  // The parts of one string never reorder, so their places are their keys.
  return <>{parts.map((part, at) => (at % 2 === 1 ? <span key={at} style={FIXED} data-figures="">{part}</span> : part))}</>
}
