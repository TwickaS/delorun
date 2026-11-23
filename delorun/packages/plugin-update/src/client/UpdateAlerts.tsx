/**
 * The update's pinned sidebar alert and the line under a stopped chat's composer, which read the update state.
 */
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateLoad } from './controller.ts'
import type { Outcome } from './controller.ts'
import { StoppedChatLine } from './StopChats.tsx'
import css from './UpdatePanel.module.css'
import { ongoingOf, UpdateProgress, type ConnectionState } from './UpdateProgress.tsx'
import type { StopChatsView } from '../wire.ts'

/** What the sidebar alert reads and does. */
export interface UpdateAlertsInjected {
  readonly hooks: { readonly load: HostObservable<UpdateLoad>, readonly switching: HostObservable<boolean>, readonly connection: HostObservable<ConnectionState>, readonly retry: HostObservable<number | undefined> }
  /** Reconnect now. */
  readonly reconnect: () => void
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
  const { t, cancel, stopChats, reconnect } = props
  const connection = props.useConnection(value => value)
  const retryAt = props.useRetry(value => value)
  const load = props.useLoad(value => value)
  const switching = props.useSwitching(value => value)
  if (load.status !== 'ready') return null
  const { state } = load
  return <UpdateProgress variant="alert" state={state} switching={switching} reconnecting={load.reconnecting} t={t} cancel={cancel}
    stop={{ chats: state.runningChats ?? [], jobs: state.runningJobs ?? 0, automatic: state.continueStopped, run: stopChats }} connection={connection} retryAt={retryAt} reconnect={reconnect} />
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

/**
 * The `sidebar.footer.action` entry: the alert in the wide sidebar, nothing on the collapsed rail.
 * @param props - the slot's `wide` flag with the alert's hooks and dictionary.
 * @returns the alert, or nothing.
 */
export function UpdateAlertsEntry(props: UpdateAlertsProps & { readonly wide: boolean }) {
  return props.wide ? <UpdateAlerts {...props} /> : <RailDot {...props} />
}

/**
 * The collapsed rail's mark of an ongoing state: one small dot, no text.
 * @param props - the hooks and the dictionary.
 * @returns the dot, or nothing while no state lasts.
 */
function RailDot(props: UpdateAlertsProps) {
  const load = props.useLoad(value => value)
  const switching = props.useSwitching(value => value)
  const connection = props.useConnection(value => value)
  if (load.status !== 'ready') return null
  const ongoing = ongoingOf(load.state, switching, load.reconnecting, props.t, connection)
  return ongoing === undefined ? null : <span className={css.railDot} role="status" aria-label={ongoing.text} title={ongoing.text} data-update-rail-dot />
}
