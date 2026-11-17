/**
 * A block of code, such as the install command, with a button that copies it. The block answers in place for
 * {@link COPY_ANSWER_MS}: the button shows a tick and the copied text, or a cross with the failed text on its own line
 * under the code, and a polite live region says the same to a screen reader, again on every press. A failed copy also
 * selects the code, so the visitor can copy it by hand. The button
 * appears once scripts run; without them the block is plain selectable text and keeps its size.
 * @module @delorun/brand/components/CodeBlock
 */
import { useEffect, useRef, useState } from 'react'
import css from './CodeBlock.module.css'

/** How long the copy button shows its answer before it returns to its resting state, in milliseconds. */
export const COPY_ANSWER_MS = 2000

/**
 * Copy text with the Clipboard API, or with a hidden text area where the API is missing or refuses.
 * @param text - the text to put on the clipboard.
 * @returns whether the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // The API is absent (an insecure context or an old browser) or the page lacks permission; the text area below is the fallback.
    void error
  }
  const before = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.focus({ preventScroll: true })
  area.select()
  try {
    return document.execCommand('copy')
  } catch (error) {
    // execCommand throws where the browser has removed it; the copy failed and the caller says so.
    void error
    return false
  } finally {
    area.remove()
    if (before instanceof HTMLElement) before.focus({ preventScroll: true })
  }
}

/** The props of {@link CodeBlock}. Every string is the caller's localised text. */
export interface CodeBlockProps {
  /** The code to show and copy, exactly as copied. */
  readonly code: string
  /** The copy button's accessible name, such as "Copy command". */
  readonly copyLabel: string
  /** The answer after a copy, such as "Copied". */
  readonly copiedLabel: string
  /** The answer after a failed copy, such as "Copy failed. Select the command and copy it." */
  readonly failedLabel: string
  /** An optional caption above the code, such as a file name. */
  readonly caption?: string | undefined
  /** `md` (the default) for body text; `lg` sets the code at headline size, as the closing footer does. */
  readonly size?: 'md' | 'lg'
  readonly className?: string | undefined
}

type Answer = 'idle' | 'copied' | 'failed'

const TICK = 'M20 6 9 17l-5-5'
const CROSS = 'M18 6 6 18M6 6l12 12'

/**
 * Render the code block.
 * @param props - see {@link CodeBlockProps}.
 * @returns the block.
 */
export function CodeBlock({ code, copyLabel, copiedLabel, failedLabel, caption, size = 'md', className }: CodeBlockProps) {
  const [ready, setReady] = useState(false)
  const [answer, setAnswer] = useState<Answer>('idle')
  const [presses, setPresses] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const codeRef = useRef<HTMLElement>(null)
  useEffect(() => {
    setReady(true)
    return () => { clearTimeout(timer.current) }
  }, [])
  const copy = async () => {
    const copied = await copyText(code)
    if (!copied && codeRef.current !== null) window.getSelection()?.selectAllChildren(codeRef.current)
    setAnswer(copied ? 'copied' : 'failed')
    setPresses(count => count + 1)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setAnswer('idle') }, COPY_ANSWER_MS)
  }
  const said = answer === 'copied' ? copiedLabel : answer === 'failed' ? failedLabel : ''
  return (
    <figure className={`${css.block} ${className ?? ''}`.trim()} data-size={size}>
      {caption === undefined ? null : <figcaption className={css.caption}>{caption}</figcaption>}
      <div className={css.row}>
        <pre className={css.pre}><code ref={codeRef}>{code}</code></pre>
        <button type="button" className={css.copy} data-answer={answer} data-ready={ready} aria-label={copyLabel} title={copyLabel} onClick={() => { void copy() }} tabIndex={ready ? 0 : -1}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {answer === 'idle'
              ? <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>
              : <path d={answer === 'copied' ? TICK : CROSS} />}
          </svg>
          {answer === 'copied' ? <span className={css.answer} aria-hidden="true">{said}</span> : null}
        </button>
      </div>
      {answer === 'failed' ? <p className={css.failed} aria-hidden="true">{said}</p> : null}
      {/* A new key per press replaces the text, so a second copy is announced again. */}
      <span role="status" aria-live="polite" className={css.announce}><span key={presses}>{said}</span></span>
    </figure>
  )
}
