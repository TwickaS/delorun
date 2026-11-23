/**
 * The update's ongoing states, which last until they end and so are not toasts: waiting for chats with Cancel, switching
 * and reconnecting. Each is a compact alert pinned in the sidebar (`variant="alert"`) until the state ends. On a phone
 * the sidebar is hidden, so the same state also shows as a toast at the top with a close button (`variant="toast"`);
 * closing hides that toast only, and a new phase shows it again. Both are `@delorun/brand`'s `Alert`, in the Delorun
 * look's quiet glass style.
 */
import { useEffect, useState } from 'react'
import { Alert, type AlertKind } from '@delorun/brand/alert'
import { ToastSlot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UpdateStateView } from '../wire.ts'
import css from './UpdatePanel.module.css'
import { controlUse, keepVersions, pluralKey, type T } from './parts.tsx'
import { StopChatsMenu, type StopChatsOffer } from './StopChats.tsx'

/** At or below this width the sidebar is hidden and the toast carries the state. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * Follow whether the window is phone width.
 * @returns whether it is.
 */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY)
    if (query === undefined) return undefined
    const follow = (): void => { setPhone(query.matches) }
    query.addEventListener('change', follow)
    return () => { query.removeEventListener('change', follow) }
  }, [])
  return phone
}

/** The connection's states, as the client connection reports them. */
export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | undefined

/** What an ongoing state says and does. */
interface Ongoing {
  /** Whether this is the connection's state and offers Reconnect now. */
  readonly connection?: boolean
  /** The phase, which keys a closed toast. */
  readonly key: string
  readonly text: string
  /** The version the text names, kept whole where it wraps. */
  readonly version?: string
  /** Whether Cancel is on offer. */
  readonly waiting: boolean
}

/**
 * Decide what the update is doing, if it is doing something that lasts.
 * @param state - the update state.
 * @param switching - whether this page began a switch.
 * @param reconnecting - whether the Host is out of reach.
 * @param t - the dictionary.
 * @returns the ongoing state, or `undefined` when nothing lasts.
 */
export function ongoingOf(state: UpdateStateView, switching: boolean, reconnecting: boolean, t: T, connection: ConnectionState = undefined): Ongoing | undefined {
  const progress = state.progress
  if (progress.kind === 'applying' || progress.kind === 'rolling-back') {
    const waiting = progress.phase === 'waiting'
    const text = waiting
      ? progress.runningChats === 0 ? t('progress.waiting.zero') : t(pluralKey('progress.waiting', progress.runningChats), { count: progress.runningChats })
      : t(progress.kind === 'applying' ? 'progress.switching' : 'progress.rollback.switching', { version: progress.target })
    return { key: progress.phase, text, version: progress.target, waiting }
  }
  if (reconnecting || (switching && progress.kind === 'idle' && state.result === undefined)) return { key: 'reconnecting', text: t('progress.reconnecting'), waiting: false }
  // A planned update restart drops the connection on purpose; only a loss with no update behind it is the connection's own state.
  if (connection !== undefined && connection !== 'connected' && state.progress.kind === 'idle' && !switching && !reconnecting) {
    return { key: `connection-${connection}`, text: t(connection === 'connecting' ? 'connection.connecting' : 'connection.lost'), waiting: false, connection: true }
  }
  return undefined
}

/**
 * The whole seconds until a time.
 * @param at - `Date.now()` milliseconds of the moment, or `undefined` for none.
 * @returns the seconds left, at least 1 while the moment lies ahead, or `undefined` once it has passed or without one.
 */
function secondsUntil(at: number | undefined): number | undefined {
  return at === undefined || at <= Date.now() ? undefined : Math.ceil((at - Date.now()) / 1000)
}

/**
 * The whole seconds until a time, counted down while it lies ahead.
 * @param at - `Date.now()` milliseconds of the moment, or `undefined` for none.
 * @returns the seconds left, at least 1 while the moment lies ahead, or `undefined` once it has passed or without one.
 */
export function useSecondsUntil(at: number | undefined): number | undefined {
  const [seconds, setSeconds] = useState(() => secondsUntil(at))
  useEffect(() => {
    setSeconds(secondsUntil(at))
    if (at === undefined) return undefined
    const timer = setInterval(() => { setSeconds(secondsUntil(at)) }, 250)
    return () => { clearInterval(timer) }
  }, [at])
  return seconds
}

/**
 * The muted line under a connection state: the countdown to the next automatic attempt while the loop waits, that it
 * is trying now while an attempt runs, and the reason (this device is offline) while the browser reports no network.
 * @param connection - the connection's state.
 * @param seconds - the seconds until the next automatic attempt, while one is scheduled.
 * @param t - the dictionary.
 * @returns the line.
 */
export function connectionLine(connection: ConnectionState, seconds: number | undefined, t: T): string {
  if (connection === 'disconnected') return t('connection.offline')
  return seconds === undefined ? t('connection.trying') : t('connection.retryIn', { count: seconds })
}

/** The props of {@link UpdateProgress}. */
export interface UpdateProgressProps {
  readonly variant: 'alert' | 'toast'
  readonly state: UpdateStateView
  readonly switching: boolean
  readonly reconnecting: boolean
  readonly t: T
  readonly cancel: () => Promise<unknown>
  /** The Stop running chats and update menu, offered on the sidebar alert while the update waits for chats. */
  readonly stop?: StopChatsOffer
  /** The connection's state; a loss with no update behind it shows as an ongoing state. */
  readonly connection?: ConnectionState | undefined
  /** `Date.now()` milliseconds of the connection's next automatic attempt, while it waits between attempts. */
  readonly retryAt?: number | undefined
  /** Reconnect now. */
  readonly reconnect?: (() => void) | undefined
}

/**
 * Draw the ongoing update state as a sidebar alert or a phone toast.
 * @param props - see {@link UpdateProgressProps}.
 * @returns the alert or toast, or nothing while nothing lasts or the toast was closed.
 */
export function UpdateProgress({ variant, state, switching, reconnecting, t, cancel, stop, connection, retryAt, reconnect }: UpdateProgressProps) {
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<string | undefined>()
  const seconds = useSecondsUntil(retryAt)
  const ongoing = ongoingOf(state, switching, reconnecting, t, connection)
  const use = controlUse(state, 'update-cancel', t)
  if (ongoing === undefined || (variant === 'toast' && closed === ongoing.key)) return null
  const offline = ongoing.connection === true && connection === 'disconnected'
  const kind: AlertKind = offline ? 'warning' : 'progress'
  const cancelOffer = ongoing.waiting
    ? { label: t('progress.cancel'), disabled: busy || use.disabled, title: use.title, onClick: () => { setBusy(true); void cancel().finally(() => { setBusy(false) }) } }
    : undefined
  const card = (
    <Alert
      kind={kind}
      variant={variant === 'toast' ? 'toast' : 'inline'}
      className={variant === 'alert' ? css.pinned : undefined}
      role="status"
      title={keepVersions(ongoing.text, [ongoing.version])}
      line={ongoing.connection === true ? connectionLine(connection, seconds, t) : undefined}
      primary={ongoing.connection === true && reconnect !== undefined ? { label: t('connection.reconnect'), onClick: reconnect } : undefined}
      secondary={cancelOffer}
      extra={variant === 'alert' && ongoing.waiting && stop !== undefined && !controlUse(state, 'update-begin', t).disabled ? <StopChatsMenu offer={stop} t={t} /> : undefined}
      close={variant === 'toast' ? { label: t('progress.close'), onClick: () => { setClosed(ongoing.key) } } : undefined}
      data-update-progress={ongoing.key}
      data-update-variant={variant}
    />
  )
  return variant === 'toast' ? <ToastSlot width={380}>{card}</ToastSlot> : card
}
