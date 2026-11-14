/**
 * The quiet "Dangerous mode" badge under the sidebar's logo. It shows only while the home reports dangerous mode on,
 * on the computer and on a remote studio alike, and opens Settings on Permissions, where the mode is turned off. It
 * reads the state when it mounts, each time the window regains focus and when Settings turns the mode off; a failed
 * read leaves it hidden.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { EVERYWHERE_CHANGED, readEverywhere } from './consents-api.ts'
import type { HostFetch } from './host-api.ts'
import css from './DangerousBadge.module.css'

/** What the plugin supplies the badge. */
export interface DangerousBadgeInjected {
  /** Sends the badge's same-origin request: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Opens Settings on the Permissions section. */
  open: () => void
}

/** Props of the `sidebar.brand.badge` entry. */
export type DangerousBadgeProps = PropsLocale<'delorunConsents'> & InjectFace<DangerousBadgeInjected>

/**
 * Render the badge.
 * @param props - the copy, the request function and the Settings opener.
 * @returns the badge, or nothing while dangerous mode is off or unreadable.
 */
export function DangerousBadge({ t, fetch, open }: DangerousBadgeProps): ReactNode {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let current = true
    const read = (): void => { void readEverywhere(fetch).then((answer) => { if (current) setOn(answer.on) }) }
    read()
    window.addEventListener('focus', read)
    window.addEventListener(EVERYWHERE_CHANGED, read)
    return () => {
      current = false
      window.removeEventListener('focus', read)
      window.removeEventListener(EVERYWHERE_CHANGED, read)
    }
  }, [fetch])
  if (!on) return null
  return (
    <button type="button" className={css.badge} aria-label={t('everywhere.badgeLabel')} data-delorun-dangerous-badge="" onClick={open}>
      {t('everywhere.badge')}
    </button>
  )
}
