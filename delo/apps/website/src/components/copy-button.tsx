/**
 * The install command with a button that copies it.
 *
 * @module @delo/website/copy-button
 */
import { useEffect, useRef, useState } from 'react'
import { COPY } from '../site/copy.ts'

/** How long the button shows that the copy worked, in milliseconds. */
const COPIED_MS = 2000

/**
 * Copies text with the Clipboard API, or with a hidden text area where the API is missing or refuses.
 * @param text - the text to put on the clipboard.
 * @returns whether the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // The API is absent (insecure context, old browser) or the page lacks permission; the text area below is the fallback.
    void error
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

/**
 * The command in its dark block, with an icon button that copies it. The icon swaps to a tick for a moment; a polite
 * live region announces the same to a screen reader.
 * @param props.text - the command to show and copy.
 * @returns the block.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    if (!(await copyText(text))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-lg bg-fd-foreground py-1 pl-4 pr-1 text-fd-background">
      <code className="min-w-0 break-words font-mono text-base">{text}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={COPY.copyLabel}
        title={copied ? COPY.copiedLabel : COPY.copyLabel}
        className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-fd-background/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-background"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {copied
            ? <path d="M20 6 9 17l-5-5" />
            : <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>}
        </svg>
      </button>
      <span role="status" aria-live="polite" className="sr-only">{copied ? COPY.copiedLabel : ''}</span>
    </span>
  )
}
