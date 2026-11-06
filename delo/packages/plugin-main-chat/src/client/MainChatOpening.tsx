/**
 * The panel the Main chat row selects. It only opens the main chat: it has
 * the harness make the main chat when it is missing and shows it, which
 * closes the panel, and says when it did not.
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'main' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './MainChatOpening.module.css'

/** What the panel does. */
export interface MainChatOpeningInjected {
  /**
   * Show the main chat's thread, creating the main chat when it is missing.
   * @returns when it shows; rejects when the harness did not open it.
   */
  readonly open: () => Promise<void>
}

/** The panel's props: its dictionary and its injected call. */
export type MainChatOpeningProps = OwnerOf<'main'> & PropsLocale<'deloMainChat'> & InjectFace<MainChatOpeningInjected>

/**
 * Render the panel: empty while the main chat opens, and a notice with a retry when it did not.
 * @param props - the dictionary and the call that opens the main chat.
 * @returns the panel.
 */
export function MainChatOpening({ t, open }: Pick<MainChatOpeningProps, 't' | 'open'>) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let shown = true
    setFailed(false)
    open().catch((error: unknown) => {
      // The harness logged why; the panel says so and offers a retry.
      console.warn('delo-main-chat: the main chat did not open', error)
      if (shown) setFailed(true)
    })
    return () => { shown = false }
  }, [open, attempt])
  return (
    <div className={css.page} aria-busy={!failed}>
      {failed && (
        <div className={css.notice}>
          <span role="alert">{t('open.failed')}</span>
          <Button variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('open.retry')}</Button>
        </div>
      )}
    </div>
  )
}
