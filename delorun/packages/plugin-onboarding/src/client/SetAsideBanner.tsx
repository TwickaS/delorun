/**
 * The calm inline notice above the message box when the workspace registry started with records set aside because
 * they could not be read. It names the files and points at `delorun doctor`. The Host's answer is read once when the box
 * mounts; dismissing the notice hides it until the studio is loaded again.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Alert } from '@delorun/brand/alert'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './KeyBanner.module.css'

/** What the notice reads and calls. */
export interface SetAsideInjected {
  /** @returns the names of the files records were set aside into, or undefined when the Host cannot be asked. */
  readonly setAside: () => Promise<readonly string[] | undefined>
  /** Whether the person dismissed the notice since the studio loaded. */
  readonly dismissed: {
    readonly getSnapshot: () => boolean
    readonly subscribe: (listener: () => void) => () => void
  }
  /** Hide the notice until the studio is loaded again. */
  readonly dismiss: () => void
}

/** The props of the notice in the input dock: this plugin's copy and the services. */
export type SetAsideBannerProps = PropsLocale<'delorunOnboarding'> & InjectFace<SetAsideInjected>

/**
 * Render the notice while records were set aside and it is not dismissed.
 * @param props - this plugin's copy and the services.
 * @returns the notice, or nothing.
 */
export function SetAsideBanner({ t, setAside, dismissed, dismiss }: SetAsideBannerProps): ReactNode {
  const hidden = useSyncExternalStore(dismissed.subscribe, dismissed.getSnapshot)
  const [files, setFiles] = useState<readonly string[]>([])
  useEffect(() => {
    if (hidden) return undefined
    let current = true
    void setAside().then((answer) => { if (current) setFiles(answer ?? []) })
    return () => { current = false }
  }, [setAside, hidden])
  if (hidden || files.length === 0) return null
  return (
    <Alert
      kind="warning"
      variant="banner"
      role="status"
      className={css.banner}
      title={t('setAside.text', { files: files.join(', ') })}
      secondary={{ label: t('setAside.dismiss'), onClick: dismiss }}
    />
  )
}
