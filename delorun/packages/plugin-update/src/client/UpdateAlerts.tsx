/**
 * The update's pinned sidebar alert and the line under a stopped chat's composer, which read the update state.
 */
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateLoad } from './controller.ts'
import type { Outcome } from './controller.ts'
import { StoppedChatLine } from './StopChats.tsx'
import { UpdateProgress } from './UpdateProgress.tsx'
import type { StopChatsView } from '../wire.ts'

/** What the sidebar alert reads and does. */
export interface UpdateAlertsInjected {
  readonly hooks: { readonly load: HostObservable<UpdateLoad>, readonly switching: HostObservable<boolean> }
  readonly cancel: () => Promise<unknown>
  readonly stopChats: () => Promise<Outcome<StopChatsView>>
}

/** Props of the sidebar alert. */
export type UpdateAlertsProps = PropsLocale<'delorunUpdate'> & InjectFace<UpdateAlertsInjected>

/**
 * Render the ongoing update state as a compact alert pinned in the sidebar until the state ends.
 * @param props - the hooks, the actions and the dictionary.
 * @returns the alert, or nothing while no update state lasts.
 */
export function UpdateAlerts(props: UpdateAlertsProps) {
  const { t, cancel, stopChats } = props
  const load = props.useLoad(value => value)
  const switching = props.useSwitching(value => value)
  if (load.status !== 'ready') return null
  const { state } = load
  return <UpdateProgress variant="alert" state={state} switching={switching} reconnecting={load.reconnecting} t={t} cancel={cancel}
    stop={{ chats: state.runningChats ?? [], automatic: state.continueStopped, run: stopChats }} />
}

/** What the per-chat line reads and does. */
export interface StoppedChatInjected {
  readonly hooks: { readonly load: HostObservable<UpdateLoad> }
  /** The chat this line belongs to. */
  readonly sessionId: string
  readonly continueChat: (sessionId: string) => Promise<unknown>
}

/** Props of the per-chat line. */
export type StoppedChatProps = PropsLocale<'delorunUpdate'> & InjectFace<StoppedChatInjected>

/**
 * Render the "Stopped for the update" line under a chat's composer.
 * @param props - the hooks, the chat and the dictionary.
 * @returns the line, or nothing when the update did not stop this chat.
 */
export function StoppedChatDock(props: StoppedChatProps) {
  const load = props.useLoad(value => value)
  return <StoppedChatLine stopped={load.status === 'ready' ? load.state.stopped : undefined} sessionId={props.sessionId} t={props.t} onContinue={props.continueChat} />
}
