/**
 * The remote studio's notice for an answer the home refused because it must be given at the home's own computer, such
 * as a full-access grant. The home keeps the prompt open for its own computer; this notice tells the person where to
 * answer it. One store behind one `shell.overlay` entry holds the notice, so it outlives the conversation surface that
 * answered the prompt.
 */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Full-opacity hold of the notice: two sentences to read, so longer than a one-line outcome. */
const NOTICE_HOLD_MS = 8000

/**
 * The shown notice with the refused action, keyed by its sequence so a second refusal restarts it; null while none
 * shows.
 */
export type RemoteNoticeState = { readonly seq: number; readonly action: string | undefined } | null

/** Store the refusal listener reports into and the overlay entry reads. */
export interface RemoteNoticeSource {
  /** The notice for the overlay entry. */
  readonly hooks: { readonly notice: HostObservable<RemoteNoticeState> }
  /** Show the notice for one refused action, undefined when the home named none. */
  readonly show: (action: string | undefined) => void
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
    show: (action) => { publish({ seq: ++seq, action }) },
    dismiss: () => { publish(null) },
  }
}

/** Props of the `shell.overlay` entry: the notice store and the Devices copy. */
export type RemoteNoticeProps = PropsLocale<'deloDevices'> & InjectFace<Omit<RemoteNoticeSource, 'show'>>

/**
 * The localized name of a refused action: its own phrase for a full-access escalation, the action's identifier for
 * another one, and a generic phrase when the home named none.
 * @param t - the Devices copy.
 * @param action - the refused action.
 * @returns the phrase the notice names.
 */
export function refusedActionText(t: RemoteNoticeProps['t'], action: string | undefined): string {
  if (action === 'full-access-escalation') return t('remote.action.fullAccessEscalation')
  if (action === 'workspace-management') return t('remote.action.workspaceManagement')
  return action === undefined ? t('remote.action.unknown') : t('remote.action.other', { action })
}

/**
 * Render the notice while it shows.
 * @param props - the notice hook, its dismissal and the copy.
 * @returns the banner, or nothing.
 */
export function RemoteNotice({ useNotice, dismiss, t }: RemoteNoticeProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t('remote.refused', { action: refusedActionText(t, notice.action) })}
    icon={<IconWarningOutlineRegular />} holdMs={NOTICE_HOLD_MS}
    actions={[{ label: t('remote.dismiss'), prefix: ' ', onClick: dismiss }]} onDone={dismiss} />
}
