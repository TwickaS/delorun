/**
 * The Multiview entry points in the chat header: the pin button on each row of the agents list, the popover's footer with
 * "Pin running" and "Open Multiview", and the header's Multiview button with its pinned count, its amber dot and its Layout
 * menu.
 */
import { useState, useSyncExternalStore } from 'react'
import {
  IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LAYOUT_PRESETS, type CapacityRefusal } from '../layout/index.ts'
import type { MULTIVIEW_NS} from '../client/contract.ts';
import { EMPTY_CHAT_MULTIVIEW, type ChatMultiview, type MultiviewService } from '../client/contract.ts'
import { ownerOf, runningAgentsOf } from './read.ts'
import css from './Entry.module.css'

/** What the entry points read and do. */
export interface EntryInjected {
  /** The pins, layouts and open state. */
  readonly multiview: MultiviewService
}

type Translate = PropsLocale<typeof MULTIVIEW_NS>['t']

/** The state of one chat as React state. */
function useChat(multiview: MultiviewService, chat: SessionId): ChatMultiview {
  const source = multiview.of(chat)
  return useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
}

/** The sentence a refused pin gives. */
function refusalText(t: Translate, reason: CapacityRefusal, maxPanes: number): string {
  return reason === 'max-panes' ? t('pin.refused.max-panes', { max: String(maxPanes) }) : t('pin.refused.no-room')
}

/** Props of the pin button on an agents-list row. */
export type PinButtonProps = PropsRuntime<'conversation.session.header.actions.subagent.row.trail'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The pin button of one row: a filled pin while the agent is pinned. With the pane limit reached, or no room on the screen,
 * an unpinned agent's button is disabled and says why.
 * @param props - the row, the services and the dictionary.
 * @returns the button.
 */
export function PinButton({ sessionId, label, useSessions, multiview, t }: PinButtonProps) {
  const chat = useSessions(state => ownerOf(state, sessionId))
  const { pins } = useChat(multiview, chat)
  const settings = useSyncExternalStore(listener => multiview.settings.subscribe(listener), () => multiview.settings.getSnapshot())
  const pinned = pins.includes(sessionId)
  const refusal = pinned ? undefined : multiview.capacityRefusal(chat)
  const reason = refusal === undefined ? undefined : refusalText(t, refusal, settings.maxPanes)
  const action = pinned ? t('unpin') : t('pin')
  return (
    <Tooltip label={reason ?? action} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={css.pin}
        data-pinned={pinned || undefined}
        aria-pressed={pinned}
        aria-disabled={reason !== undefined || undefined}
        aria-label={pinned ? t('unpin.aria', { agent: label }) : t('pin.aria', { agent: label })}
        aria-description={reason}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (pinned) multiview.unpin(chat, sessionId)
          else if (reason === undefined) multiview.pin(chat, sessionId)
        }}
        onKeyDown={(event) => { event.stopPropagation() }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/** Props of the popover footer. */
export type FooterProps = PropsRuntime<'conversation.session.header.actions.subagent.footer'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The agents popover's footer: how many agents are pinned and how many more fit, "Pin running", and "Open Multiview".
 * @param props - the chat, the services and the dictionary.
 * @returns the footer.
 */
export function Footer({ sessionId, useSessions, multiview, t }: FooterProps) {
  const { pins, open: shown } = useChat(multiview, sessionId)
  const settings = useSyncExternalStore(listener => multiview.settings.subscribe(listener), () => multiview.settings.getSnapshot())
  const running = useSessions(state => runningAgentsOf(state, sessionId).join('\n'))
  const unpinnedRunning = running === '' ? [] : running.split('\n').filter(id => !pins.includes(id as SessionId)) as SessionId[]
  const room = Math.max(0, settings.maxPanes - 1 - pins.length)
  const full = multiview.capacityRefusal(sessionId) !== undefined
  const pinRunningReason = unpinnedRunning.length > 0
    ? undefined
    : t(running === '' ? 'footer.pinRunning.none' : 'footer.pinRunning.allPinned')
  const status = full ? t('footer.statusFull', { pinned: String(pins.length) }) : t('footer.status', { pinned: String(pins.length), free: String(room) })
  const openDisabled = !shown && pins.length === 0 && unpinnedRunning.length === 0
  return (
    <div className={css.footer} role="group" aria-label={t('button')}>
      <span className={css.status}>{status}</span>
      <Tooltip label={pinRunningReason ?? ''} disabled={pinRunningReason === undefined} side="top" delayMs={500} portal>
        <button
          type="button"
          className={css.footerButton}
          aria-disabled={pinRunningReason !== undefined || undefined}
          onClick={() => { if (pinRunningReason === undefined) multiview.pinAll(sessionId, unpinnedRunning) }}
        >
          {t('footer.pinRunning')}
        </button>
      </Tooltip>
      <button
        type="button"
        className={`${css.footerButton} ${css.footerPrimary}`}
        aria-disabled={openDisabled || undefined}
        onClick={() => { openOrClose(multiview, sessionId, shown, unpinnedRunning) }}
      >
        {shown ? t('footer.close') : t('footer.open')}
      </button>
    </div>
  )
}

/**
 * Open Multiview, pinning every running agent first when nothing is pinned; or close it while it shows.
 * @param multiview - the service.
 * @param chat - the chat.
 * @param shown - whether Multiview shows now.
 * @param running - the running agents that are not pinned.
 */
export function openOrClose(multiview: MultiviewService, chat: SessionId, shown: boolean, running: readonly SessionId[]): void {
  if (shown) { multiview.close(chat); return }
  if (multiview.of(chat).getSnapshot().pins.length === 0) multiview.pinAll(chat, running)
  if (multiview.of(chat).getSnapshot().pins.length > 0) multiview.open(chat)
}

/** Props of the header button. */
export type HeaderButtonProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The header's Multiview button: the pinned count, an amber dot while a pinned agent waits for the person, and, while
 * Multiview shows, the Layout menu. Child chats render nothing.
 * @param props - the chat, the services and the dictionary.
 * @returns the button, or null in an agent's own chat.
 */
export function HeaderButton(props: HeaderButtonProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootHeaderButton {...props} />
}

function RootHeaderButton({ sessionId, useSessions, useSessionStatus, multiview, t }: HeaderButtonProps) {
  const { pins, open: shown } = useChat(multiview, sessionId)
  const waiting = useSessionStatus(statuses => pins.some(pin => statuses.get(pin)?.pendingInteraction?.kind === 'approval'))
  const running = useSessions(state => runningAgentsOf(state, sessionId).join('\n'))
  const [menuOpen, setMenuOpen] = useState(false)
  const unpinnedRunning = running === '' ? [] : running.split('\n').filter(id => !pins.includes(id as SessionId)) as SessionId[]
  const nothing = !shown && pins.length === 0 && unpinnedRunning.length === 0
  const description = [
    pins.length > 0 ? t('button.count', { count: String(pins.length) }) : undefined,
    waiting ? t('button.waiting') : undefined,
  ].filter(part => part !== undefined).join(', ')
  return (
    <span className={css.group}>
      <Tooltip label={nothing ? t('button.open.none') : t('button')} side="bottom" delayMs={500} portal>
        <button
          type="button"
          className={css.button}
          aria-pressed={shown}
          aria-disabled={nothing || undefined}
          aria-label={description === '' ? t('button.aria') : `${t('button.aria')}, ${description}`}
          data-waiting={waiting || undefined}
          onClick={() => { if (!nothing) openOrClose(multiview, sessionId, shown, unpinnedRunning) }}
        >
          <IconPanelLeftOutlineRegular size={16} />
          <span className={css.label}>{t('button')}</span>
          {pins.length > 0 && <span className={css.count} aria-hidden>{pins.length}</span>}
          {waiting && <span className={css.dot} aria-hidden />}
        </button>
      </Tooltip>
      {shown && (
        <Menu
          open={menuOpen}
          portal
          align="end"
          onClose={() => { setMenuOpen(false) }}
          items={[
            ...LAYOUT_PRESETS.map(preset => ({ id: preset, label: t(`layout.${preset}`) })),
            { type: 'separator' as const, id: 'separator' },
            { id: 'reset', label: t('layout.reset') },
          ]}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'reset') multiview.resetLayout(sessionId)
            else multiview.applyPreset(sessionId, LAYOUT_PRESETS.find(preset => preset === id) ?? 'main-column')
          }}
          anchor={
            <button
              type="button"
              className={`${css.button} ${css.layoutButton}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('layout')}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconChevronDownOutlineRegular size={14} />
            </button>
          }
        />
      )}
    </span>
  )
}

/** An empty state, for a chat the store has not seen. */
export const NO_PINS = EMPTY_CHAT_MULTIVIEW
