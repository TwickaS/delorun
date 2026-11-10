/**
 * The remote studio's notice for a full-access grant. The home refuses a full-access grant answered from a remote
 * session and keeps the prompt open for its own computer; this notice tells the person where to answer it. One store
 * behind one `shell.overlay` entry holds the notice, so it outlives the conversation surface that answered the prompt.
 */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Full-opacity hold of the notice: two sentences to read, so longer than a one-line outcome. */
const NOTICE_HOLD_MS = 8000

/** The shown notice, keyed by its sequence so a second refusal restarts it; null while none shows. */
export type RemoteNoticeState = { readonly seq: number } | null

/** Store the approval listener reports into and the overlay entry reads. */
export interface RemoteNoticeSource {
  /** The notice for the overlay entry. */
  readonly hooks: { readonly notice: HostObservable<RemoteNoticeState> }
  /** Show the notice. */
  readonly show: () => void
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/**
 * Create the notice's store.
 * @returns the observable notice with its show and dismiss actions.
 */
export function createRemoteNoticeSource(): RemoteNoticeSource {
  let state: RemoteNoticeState = null
  let seq = 0
  const listeners = new Set<() => void>()
  const publish = (next: RemoteNoticeState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    hooks: {
      notice: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    show: () => { publish({ seq: ++seq }) },
    dismiss: () => { publish(null) },
  }
}

/**
 * Whether a page hostname names this computer: `localhost`, a `.localhost` name, an IPv4 address in 127/8 or `[::1]`.
 * @param hostname - the page's `location.hostname`.
 * @returns true on a loopback page; false on a remote one, such as a tailnet address.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Props of the `shell.overlay` entry: the notice store and the Devices copy. */
export type RemoteNoticeProps = PropsLocale<'deloDevices'> & InjectFace<Omit<RemoteNoticeSource, 'show'>>

/**
 * Render the notice while it shows.
 * @param props - the notice hook, its dismissal and the copy.
 * @returns the banner, or nothing.
 */
export function RemoteNotice({ useNotice, dismiss, t }: RemoteNoticeProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t('remote.fullAccess')} icon={<IconWarningOutlineRegular />} holdMs={NOTICE_HOLD_MS}
    actions={[{ label: t('remote.dismiss'), prefix: ' ', onClick: dismiss }]} onDone={dismiss} />
}
