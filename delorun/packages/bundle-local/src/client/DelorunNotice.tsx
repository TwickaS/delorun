/**
 * Delorun's preview notice: its own status, in the locale dictionary, shown in the shared body-portaled modal. It shows once per notice version on a browser and
 * then calls the onboarding step's `complete`, which keeps the notice out of the way of the first session.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Dialog } from '@delorun/brand'
import type { PrivacyLocaleKey } from './locales.ts'
import css from './DelorunNotice.module.css'

/** Browser-local key that records the acknowledged notice version. Per-viewer convenience only. */
export const NOTICE_STORAGE_KEY = 'delorun.preview-notice'

/** The version of the notice copy; a copy change bumps it so the notice shows again. */
export const NOTICE_VERSION = '1'

/**
 * Whether this browser acknowledged the current notice version.
 * @param storage - the browser's local storage, or undefined where none exists.
 * @returns true when the current version is recorded; false when it is not, or when storage cannot be read.
 */
export function noticeAcknowledged(storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(NOTICE_STORAGE_KEY) === NOTICE_VERSION
  } catch {
    // Storage blocked (for example a private window): the notice shows again on the next load.
    return false
  }
}

/**
 * Record the current notice version on this browser.
 * @param storage - the browser's local storage, or undefined where none exists.
 */
export function acknowledgeNotice(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(NOTICE_STORAGE_KEY, NOTICE_VERSION)
  } catch {
    // Storage blocked: the notice is not remembered and shows again on the next load.
  }
}

/** The notice is acknowledged only by its button, so Escape and the backdrop do nothing. */
const ignoreImplicitDismiss = (): void => {}

/** Injected face of the notice: the bound copy lookup. */
export interface DelorunNoticeInjected {
  /** Looks up a notice string in the locale dictionary. */
  t: (key: PrivacyLocaleKey) => string
}

/** Onboarding-step props plus the injected face. */
export type DelorunNoticeProps = PropsRuntime<'settings.onboarding'> & InjectFace<DelorunNoticeInjected>

/**
 * Render the notice until this browser acknowledges it, then report the step complete.
 * @param props - onboarding owner state (`complete`) and the injected copy lookup.
 * @returns the dialog, or nothing once acknowledged.
 */
export function DelorunNotice({ complete, t }: DelorunNoticeProps): ReactNode {
  const [open, setOpen] = useState(() => !noticeAcknowledged())
  const finished = useRef(false)
  useEffect(() => {
    if (!open && !finished.current) {
      finished.current = true
      complete()
    }
  }, [complete, open])
  useEffect(() => {
    if (!open) return
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [open])
  if (!open) return null
  const paragraphs = t('notice.body').split('\n\n')
  const dismiss = (): void => {
    acknowledgeNotice()
    setOpen(false)
  }
  return (
    <Dialog open title={t('notice.title')} onClose={ignoreImplicitDismiss} headless className={css.dialog as string}>
      <div className={css.content}>
        <h2 className={css.title}>{t('notice.title')}</h2>
        <div className={css.copy}>
          {paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </div>
        <div className={css.actions}>
          <Button variant="primary" className={css.primary} onClick={dismiss}>{t('notice.continue')}</Button>
        </div>
      </div>
    </Dialog>
  )
}
