/**
 * A description cut at two lines, with the rest behind "More" under it. The guide's cards and Recommended plugins' market
 * entries both show their descriptions this way, so a long description never stretches a list.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './ListRow.module.css'

/** A description longer than this many characters is shortened to one line with the full text behind "More". */
export const SUMMARY_LIMIT = 140

/**
 * The description and its disclosure.
 * @param props - the text, the disclosure's labels, and whether the text takes its type and colour from its container
 *   (the market entry's description) instead of the guide's own.
 * @returns the paragraph, and "More" or "Less" when the text is cut.
 */
export function Summary({ text, labels, inherit = false }: {
  readonly text: string
  readonly labels: { readonly more: string; readonly less: string }
  readonly inherit?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const summary = useRef<HTMLParagraphElement>(null)
  // A narrow row cuts a shorter description at two lines too, so the clamp itself is measured.
  const [clipped, setClipped] = useState(false)
  useEffect(() => {
    const element = summary.current
    if (element === null || open || typeof ResizeObserver === 'undefined') return
    const measure = (): void => { setClipped(element.scrollHeight > element.clientHeight + 1) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [text, open])
  const long = text.length > SUMMARY_LIMIT || clipped || open
  return (
    <>
      <p id={id} ref={summary} className={css.summary} data-open={open || undefined} data-inherit={inherit || undefined}>{text}</p>
      {long && (
        <Button variant="ghost" size="sm" className={css.more} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open) }}>
          {open ? labels.less : labels.more}
        </Button>
      )}
    </>
  )
}
