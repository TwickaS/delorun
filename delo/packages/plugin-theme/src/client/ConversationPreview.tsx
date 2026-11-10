/**
 * A sample chat drawn from the display choices: a question, the model's
 * thinking, its steps and terminal output, and the answer, finished or still
 * working. It is Delo's own drawing of upstream's rows, so a choice shows its
 * effect before the person opens a real chat.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import type { CustomDisplay } from '@deepseek-ai/dsh-client-ui-chat'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ConversationSection.module.css'

/** What the preview draws. */
export interface PreviewProps extends PropsLocale<'settings.deloConversation'> {
  /** The display's parts. */
  readonly parts: CustomDisplay
  /** Which replies stay once a turn folds. */
  readonly foldedReplies: 'all' | 'final'
  /** Draw the turn while it works, not finished. */
  readonly running: boolean
}

/** Where a sentence ends, in English or Chinese text. */
const SENTENCE_END = /(?<=[.。])\s*/

/** Milliseconds between the window's streamed words while the preview runs. */
const STREAM_MS = 90

/** Whether the person asked for less motion. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The thinking a running preview has streamed so far: the whole text at
 * rest, a growing prefix while it works.
 * @param text - the full reasoning.
 * @param running - whether the preview runs.
 * @returns the text streamed so far.
 */
function useStream(text: string, running: boolean): string {
  const words = text.split(' ')
  const [count, setCount] = useState(words.length)
  useEffect(() => {
    if (!running || prefersReducedMotion()) {
      setCount(words.length)
      return
    }
    setCount(8)
    const timer = setInterval(() => { setCount(n => (n >= words.length ? 8 : n + 1)) }, STREAM_MS)
    return () => { clearInterval(timer) }
  }, [running, words.length])
  return words.slice(0, count).join(' ')
}

/** A disclosure chevron, pointing right when folded. */
function Chevron({ open }: { open: boolean }) {
  return <span className={css.chevron} data-open={open || undefined} aria-hidden="true" />
}

/**
 * Render the sample chat.
 * @param props - the choices and the dictionary.
 * @returns the preview.
 */
export function ConversationPreview({ t, parts, foldedReplies, running }: PreviewProps) {
  const thinkingText = t('preview.thinking')
  const streamed = useStream(thinkingText, running && parts.thinking === 'window')
  const shown = running ? streamed : thinkingText
  const sentences = thinkingText.split(SENTENCE_END)
  const thinkingOpen = parts.thinking === 'expanded' || (parts.thinking === 'live' && running)
  const thinkingWindow = parts.thinking === 'window'
  const preview = !thinkingOpen && !thinkingWindow && parts.thinking !== 'title'
  const grouped = parts.stepGrouping === 'collapsed' || (parts.stepGrouping === 'history' && !running)
  const folded = !running && parts.foldCompletedTurns

  const thinking = (
    <div className={css.pvThinking}>
      <div className={css.pvRow}>
        <Chevron open={thinkingOpen || thinkingWindow} />
        <span className={css.pvIcon} aria-hidden="true">✦</span>
        <span className={running ? css.pvShimmer : undefined}>{t('preview.thinkingTitle')}</span>
        {preview && <span className={css.pvPreview}>{running ? shown.split(SENTENCE_END).at(-1) : sentences.at(0)}</span>}
      </div>
      {thinkingOpen && <p className={css.pvThinkingBody}>{shown}</p>}
      {thinkingWindow && (
        <div className={css.pvWindow} data-streaming={running || undefined} style={{ '--lines': parts.thinkingWindowLines } as CSSProperties}>
          <p className={css.pvThinkingBody}>{shown}</p>
        </div>
      )}
    </div>
  )

  const steps = grouped
    ? (
      <div className={css.pvRow}>
        <Chevron open={false} />
        <span className={css.pvIcon} aria-hidden="true">⌘</span>
        <span className={running ? css.pvShimmer : undefined}>
          {running && parts.liveProcessDetail ? t('preview.groupRunning') : t('preview.group')}
        </span>
      </div>
    )
    : (
      <>
        <div className={css.pvRow}><span className={css.pvDot} aria-hidden="true" />{t('preview.read1')}</div>
        <div className={css.pvRow}><span className={css.pvDot} aria-hidden="true" />{t('preview.read2')}</div>
        <div className={css.pvRow}>
          <span className={css.pvDot} data-running={running || undefined} aria-hidden="true" />
          <span className={running ? css.pvShimmer : undefined}>{t('preview.ran')}</span>
        </div>
        {parts.openTerminalCards && !running && <pre className={css.pvTerminal}>{t('preview.terminal')}</pre>}
      </>
    )

  return (
    <div className={css.pvChat} aria-hidden="true">
      <div className={css.pvUser}>{t('preview.user')}</div>
      {folded
        ? (
          <>
            <div className={css.pvRow}><Chevron open={false} /><span className={css.pvMuted}>{t('preview.folded')}</span></div>
            {foldedReplies === 'all' && <p className={css.pvReply}>{t('preview.interim')}</p>}
          </>
        )
        : (
          <>
            {thinking}
            <p className={css.pvReply}>{t('preview.interim')}</p>
            {steps}
          </>
        )}
      {running
        ? <div className={css.pvWorking}><span className={css.pvPulse} />{t('preview.running')}</div>
        : <p className={css.pvReply}>{t('preview.answer')}</p>}
    </div>
  )
}
