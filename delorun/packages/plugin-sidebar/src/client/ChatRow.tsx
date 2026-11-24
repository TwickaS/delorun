/**
 * One chat in the sidebar: a card for pinned, active and working chats, and a
 * slim row on the Snoozed and Settled shelves. A card shows its Workspace's
 * badge and name, the chat's status or age, and its title; hovering it swaps
 * the status for Snooze, Settle and the chat's menu. The menu is the Session
 * menu every plugin adds entries to, opened through the context-menu service
 * from the "..." button, a right-click or the menu key. Ported from T3 Code's
 * `SidebarThreadRow` (`apps/web/src/components/sidebar/SidebarThreadRow.tsx`,
 * MIT, © 2026 T3 Tools Inc.), drawn with the studio's tokens, icons and menus.
 * @module @delorun/plugin-sidebar/client/ChatRow
 */
import {
  FishLogo, HoverCard, IconAgentPresetOutlineRegular, IconAlarmClockOutlineRegular, IconCheckCircleOutlineRegular, IconCheckOutlineRegular,
  IconClockOutlineRegular, IconEllipsisOutlineRegular, IconFolderCloseRegular, IconPinFillRegular,
  IconPinOutlineRegular, IconPlanOutlineRegular, IconQuestionOutlineRegular, IconShieldOutlineRegular, IconSparkleRegular,
  IconUnarchiveOutlineRegular, Menu, relativeTime, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cx } from './cx.ts'
import { useTouchScreen } from './pointer.ts'
import { memo, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { SidebarLocaleKey } from './locales.ts'
import { shouldRecede, waitsOnPerson, type BadgeColor, type ChatStatus, type SidebarChat, type SidebarDropVerb, type SidebarSection } from './sections.ts'
import { WorkspaceBadge } from './WorkspaceBadge.tsx'
import { WorkingRing } from './WorkingRing.tsx'
import css from './ChatRow.module.css'

type Translate = (key: SidebarLocaleKey, params?: Record<string, string | number>) => string

/** The viewport point a menu opens at. */
export interface MenuPoint {
  readonly x: number
  readonly y: number
}

/** One row of the snooze menu, as `ctx.delorunChatStates` words it. */
export interface RowSnoozeOption {
  readonly id: string
  readonly label: string
  readonly when: string
  readonly until: number
}

/** The chat-state actions a row offers; absent without Delorun's chat-states plugin. */
export interface RowStateActions {
  readonly settle: (id: SessionId) => void
  readonly unsettle: (id: SessionId) => void
  readonly snooze: (id: SessionId, until: number) => void
  readonly wake: (id: SessionId) => void
  readonly seen: (id: SessionId) => void
  readonly snoozeOptions: () => readonly RowSnoozeOption[]
  readonly openCustom: (id: SessionId) => void
  readonly snoozeLeft: (until: number) => string
}

/** A row's part in a drag: the press that starts one, and what the row shows while one is on. */
export interface RowDrag {
  /** Start a drag from a press on the row. */
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void
  /** Whether this row is the one dragged. */
  readonly dragging: boolean
  /** Whether the dragged row is over this one. */
  readonly over: boolean
  /** What dropping the dragged row where it is does, or null where it does nothing. */
  readonly verb: SidebarDropVerb | null
}

/** What a row reads and does. */
export interface ChatRowProps {
  readonly chat: SidebarChat
  readonly section: SidebarSection
  /** Whether this chat is open in the main view. */
  readonly current: boolean
  /** The clock, ticking each minute, for ages. */
  readonly now: number
  /** The chat's Workspace badge colour. */
  readonly color: BadgeColor
  /** When the chat woke from a snooze the person has not seen, or undefined. */
  readonly wokeAt: number | undefined
  /** When a snoozed chat wakes, on the Snoozed shelf. */
  readonly snoozedUntil: number | undefined
  /** The chat-state actions, or null without Delorun's chat-states plugin. */
  readonly states: RowStateActions | null
  readonly open: (id: SessionId) => void
  readonly rename: (id: SessionId, title: string) => void
  readonly unpin: (id: SessionId) => void
  /** Open the chat's menu at a point; `toggle` closes it when it is already open for this chat. */
  readonly openMenu: (id: SessionId, title: string, point: MenuPoint, mode?: 'toggle') => void
  /** Whether the chat's menu is open. */
  readonly menuOpen: boolean
  /** The digit Alt jumps to this chat with, shown while Alt is held; null otherwise. */
  readonly jumpLabel: string | null
  /** Whether the row sits in a Workspace folder, one line under the folder's name. */
  readonly inFolder: boolean
  /** The row's drag, in the cards view; absent where rows do not drag. */
  readonly drag?: RowDrag | undefined
  readonly t: Translate
}

/** The status glyphs. */
type StatusIcon = typeof IconShieldOutlineRegular

/**
 * Each status's label key and glyph. Working has no glyph: it draws the orbital ring, which is its own component and
 * carries the motion the frozen arc never had.
 */
const STATUS: Readonly<Record<Exclude<ChatStatus, 'ready'> | 'woke' | 'done', { readonly key: SidebarLocaleKey; readonly icon: StatusIcon | null }>> = {
  working: { key: 'status.working', icon: null },
  approval: { key: 'status.approval', icon: IconShieldOutlineRegular },
  question: { key: 'status.question', icon: IconQuestionOutlineRegular },
  plan: { key: 'status.plan', icon: IconPlanOutlineRegular },
  woke: { key: 'status.woke', icon: IconAlarmClockOutlineRegular },
  done: { key: 'status.done', icon: IconCheckCircleOutlineRegular },
}

/**
 * A row's top status: what it waits on or does, its waking, or a finished unread run.
 * @param chat - the chat.
 * @param woke - whether it woke from a snooze the person has not seen.
 * @returns the status, or null for a quiet chat.
 */
function topStatus(chat: SidebarChat, woke: boolean): keyof typeof STATUS | null {
  if (chat.status !== 'ready') return chat.status
  if (woke) return 'woke'
  return chat.unread ? 'done' : null
}

/**
 * The time a run has taken, ticking each second: seconds, then minutes, then hours and minutes.
 * @param props - when the run started and the dictionary.
 * @returns the duration.
 */
function RunningFor({ since, t }: { readonly since: number; readonly t: Translate }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return <span className={css.tabular}>{t('duration.seconds', { s: seconds })}</span>
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return <span className={css.tabular}>{t('duration.minutes', { m: minutes })}</span>
  return <span className={css.tabular}>{t('duration.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })}</span>
}

/**
 * The chat's model mark: DeepSeek's whale for a DeepSeek model, an agent glyph for any other.
 * @param props - the model, and the icon's size.
 * @returns the mark, with the model as its title.
 */
function ModelIcon({ model, size = 12 }: { readonly model: SidebarChat['model']; readonly size?: number }) {
  if (model === null) return null
  return (
    <span className={css.model} title={model.model}>
      {model.provider.toLowerCase().includes('deepseek') || model.model.toLowerCase().includes('deepseek')
        ? <FishLogo size={size} />
        : <IconAgentPresetOutlineRegular size={size} />}
    </span>
  )
}

/**
 * The details a row's hover card lists, after T3 Code's thread hover card: the title, then the Workspace and its path,
 * the model and the mode.
 * @param props - the chat and its badge colour.
 * @returns the card's content.
 */
function ChatDetails({ chat, color }: { readonly chat: SidebarChat; readonly color: BadgeColor }) {
  return (
    <div className={css.details}>
      <p className={css.detailsTitle}>{chat.title}</p>
      {chat.workspace !== null && (
        <div className={css.detailsRow}>
          <WorkspaceBadge title={chat.workspace.title} workspaceId={chat.workspace.workspaceId} color={color} />
          <span className={css.detailsText}>{chat.workspace.title}</span>
        </div>
      )}
      {chat.workspace !== null && (
        <div className={css.detailsRow}>
          <IconFolderCloseRegular size={12} className={css.detailsIcon} />
          <span className={css.detailsText}>{chat.workspace.path}</span>
        </div>
      )}
      {chat.model !== null && (
        <div className={css.detailsRow}>
          <ModelIcon model={chat.model} />
          <span className={css.detailsText}>{chat.model.model}</span>
        </div>
      )}
      {chat.preset !== null && (
        <div className={css.detailsRow}>
          <IconSparkleRegular size={12} className={css.detailsIcon} />
          <span className={css.detailsText}>{chat.preset}</span>
        </div>
      )}
    </div>
  )
}

/** Each drop verb's badge glyph, as T3 Code's drop badge shows it. */
const DROP_ICON: Readonly<Record<SidebarDropVerb, StatusIcon>> = {
  pin: IconPinFillRegular,
  unpin: IconPinOutlineRegular,
  settle: IconCheckCircleOutlineRegular,
  unsettle: IconUnarchiveOutlineRegular,
  wake: IconAlarmClockOutlineRegular,
}

/**
 * The badge a dragged row shows for what dropping it does.
 * @param props - the verb and the dictionary.
 * @returns the badge.
 */
function DropBadge({ verb, t }: { readonly verb: SidebarDropVerb; readonly t: Translate }) {
  const Icon = DROP_ICON[verb]
  return <span role="status" className={css.dropBadge}><Icon size={12} className={css.dropIcon} />{t(`drop.${verb}`)}</span>
}

/**
 * A digit badge for the Alt jump, in the time slot.
 * @param props - the digit.
 * @returns the badge.
 */
function JumpHint({ label }: { readonly label: string }) {
  return <kbd className={css.jump} aria-hidden="true">{label}</kbd>
}

/**
 * The status label at a card's top right, or in a slim row's time slot.
 * @param props - the status, the run's start and what dismissing a waking does.
 * @returns the label.
 */
function StatusLabel({ status, since, onDismissWoke, t }: {
  readonly status: keyof typeof STATUS
  readonly since: number | undefined
  readonly onDismissWoke: (() => void) | undefined
  readonly t: Translate
}) {
  const { key, icon: Icon } = STATUS[status]
  const body = (
    <>
      {Icon === null ? <WorkingRing className={css.statusIcon} /> : <Icon size={16} className={css.statusIcon} />}
      {t(key)}
      {status === 'working' && since !== undefined && <RunningFor since={since} t={t} />}
    </>
  )
  if (status === 'woke' && onDismissWoke !== undefined) {
    return (
      <Tooltip label={t('action.dismissWoke')} side="top" delayMs={150}>
        <button type="button" className={css.status} data-status={status} aria-label={t('action.dismissWoke')}
          onClick={(event) => { event.stopPropagation(); onDismissWoke() }}>
          {body}
        </button>
      </Tooltip>
    )
  }
  return <span className={css.status} data-status={status}>{body}</span>
}

/**
 * The snooze button and its menu: the presets with when each ends, then Custom….
 * @param props - the chat, the actions and the menu's open state.
 * @returns the button.
 */
function SnoozeButton({ id, states, open, setOpen, t }: {
  readonly id: SessionId
  readonly states: RowStateActions
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly t: Translate
}) {
  // Read when the menu opens, so each opening offers fresh times.
  const options = useMemo(() => (open ? states.snoozeOptions() : []), [open, states])
  const items: MenuEntry[] = [
    ...options.map(option => ({
      id: option.id,
      label: <span className={css.snoozeOption}><span>{option.label}</span><span className={css.snoozeWhen}>{option.when}</span></span>,
    })),
    ...options.length > 0 ? [{ type: 'separator' as const, id: 'custom-group' }] : [],
    { id: 'custom', label: t('action.custom') },
  ]
  return (
    <Menu
      open={open}
      portal
      align="end"
      onClose={() => { setOpen(false) }}
      items={items}
      onSelect={(picked) => {
        setOpen(false)
        if (picked === 'custom') states.openCustom(id)
        else for (const option of options.filter(candidate => candidate.id === picked)) states.snooze(id, option.until)
      }}
      anchor={(
        <Tooltip label={t('action.snooze')} side="top" delayMs={150} disabled={open}>
          <button type="button" className={cx(css.action, css.snooze)} aria-label={t('action.snooze')} aria-haspopup="menu" aria-expanded={open}
            onClick={(event) => { event.stopPropagation(); setOpen(!open) }}>
            <IconClockOutlineRegular size={14} className={css.actionIcon} />
          </button>
        </Tooltip>
      )}
    />
  )
}

/**
 * Render one chat.
 * @param props - the chat, where it sits and what it does.
 * @returns the row.
 */
export const ChatRow = memo(function ChatRow(props: ChatRowProps) {
  const { chat, section, current, now, color, wokeAt, snoozedUntil, states, open, rename, unpin, openMenu, menuOpen, jumpLabel, inFolder, drag, t } = props
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  // On a touch screen Snooze and Settle are in the chat's menu, behind the "..." button, which has the 32px hit area.
  const touch = useTouchScreen()
  const woke = wokeAt !== undefined
  const status = topStatus(chat, woke)
  const recede = shouldRecede({ status: chat.status, unread: chat.unread, woke, current })
  const slim = section === 'snoozed' || section === 'settled'
  const menuShown = snoozeOpen || menuOpen
  const age = relativeTime(chat.updatedAt, now)
  const ageText = t(`time.${age.unit}`, { n: age.n })
  const label = current ? t('row.current', { title: chat.title }) : status === null ? chat.title : t('row.status', { title: chat.title, status: t(STATUS[status].key) })
  const dismissWoke = states === null ? undefined : () => { states.seen(chat.id) }

  const activate = (): void => {
    if (woke) states?.seen(chat.id)
    open(chat.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'F2') {
      event.preventDefault()
      rename(chat.id, chat.title)
      return
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openMenu(chat.id, chat.title, { x: rect.left + 16, y: rect.bottom })
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activate()
  }
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest('button, a, input') !== null) return
    event.preventDefault()
    rename(chat.id, chat.title)
  }
  const onContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    openMenu(chat.id, chat.title, { x: event.clientX, y: event.clientY })
  }
  const pin = chat.pinned && (
    <Tooltip label={t('action.unpin')} side="top" delayMs={150}>
      <button type="button" className={css.pin} aria-label={t('action.unpin')} onClick={(event) => { event.stopPropagation(); unpin(chat.id) }}>
        <IconPinFillRegular size={12} className={css.pinOn} />
        <IconPinOutlineRegular size={12} className={css.pinOff} />
      </button>
    </Tooltip>
  )
  const more = (
    <Tooltip label={t('action.more', { name: chat.title })} side="top" delayMs={150} disabled={menuOpen}>
      <button type="button" className={cx(css.action, css.more)} aria-label={t('action.more', { name: chat.title })} aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          openMenu(chat.id, chat.title, { x: rect.right, y: rect.bottom }, 'toggle')
        }}>
        <IconEllipsisOutlineRegular size={14} className={css.actionIcon} />
      </button>
    </Tooltip>
  )
  const surface = {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    'aria-current': current ? ('page' as const) : undefined,
    'aria-haspopup': 'menu' as const,
    'data-sidebar-row': chat.id,
    'data-current': current,
    'data-recede': recede && !current,
    'data-menu-open': menuShown,
    'data-working': chat.status === 'working',
    'data-unread': chat.unread,
    'data-attention': woke || waitsOnPerson(chat.status),
    onClick: activate,
    onKeyDown,
    onDoubleClick,
    onContextMenu,
    onPointerDown: drag?.onPointerDown,
  }
  const dropBadge = drag?.verb === null || drag?.verb === undefined ? null : <DropBadge verb={drag.verb} t={t} />
  const item = { 'data-drag-id': drag === undefined ? undefined : chat.id, 'data-dragging': drag?.dragging === true, 'data-over': drag?.over === true }

  const details = <ChatDetails chat={chat} color={color} />
  const wrap = (row: ReactNode): ReactNode => (
    <HoverCard anchor={row} content={details} openDelayMs={600} grouped disabled={menuShown || drag?.dragging === true} />
  )
  const settleButton = states !== null && (
    <Tooltip label={t('action.settleChat')} side="top" delayMs={150}>
      <button type="button" className={cx(css.action, css.settle)} aria-label={t('action.settleChat')}
        onClick={(event) => { event.stopPropagation(); states.settle(chat.id) }}>
        <IconCheckOutlineRegular size={14} className={css.actionIcon} />
        {!inFolder && t('action.settle')}
      </button>
    </Tooltip>
  )
  const statusOrAge = status === null ? <span className={css.age}>{ageText}</span> : <StatusLabel status={status} since={chat.promptAt} onDismissWoke={dismissWoke} t={t} />

  if (slim || inFolder) {
    const trailing = section === 'snoozed' && snoozedUntil !== undefined && states !== null
      ? <span className={css.wakeIn}><IconAlarmClockOutlineRegular size={12} className={css.statusIcon} />{states.snoozeLeft(snoozedUntil)}</span>
      : statusOrAge
    const actions = states !== null && (section === 'snoozed'
      ? (
        <Tooltip label={t('action.wake')} side="top" delayMs={150}>
          <button type="button" className={css.action} aria-label={t('action.wake')} onClick={(event) => { event.stopPropagation(); states.wake(chat.id) }}>
            <IconAlarmClockOutlineRegular size={12} className={css.actionIcon} />
          </button>
        </Tooltip>
      )
      : section === 'settled'
        ? (
          <Tooltip label={t('action.unsettle')} side="top" delayMs={150}>
            <button type="button" className={css.action} aria-label={t('action.unsettle')} onClick={(event) => { event.stopPropagation(); states.unsettle(chat.id) }}>
              <IconUnarchiveOutlineRegular size={14} className={css.actionIcon} />
            </button>
          </Tooltip>
        )
        : settleButton)
    return (
      <li {...item} className={css.item} data-variant={inFolder ? 'folder' : 'slim'}>
        {wrap(
          <div {...surface} className={cx(css.row, css.slim, inFolder && css.inFolder)}>
            {!inFolder && <span className={css.slimBadge}>{chat.workspace !== null && <WorkspaceBadge title={chat.workspace.title} workspaceId={chat.workspace.workspaceId} color={color} />}</span>}
            <span className={css.slimTitle} dir="auto">{chat.title}</span>
            {pin}
            <span className={css.trail}>
              {dropBadge ?? (jumpLabel !== null
                ? <JumpHint label={jumpLabel} />
                : (
                  <>
                    <span className={css.trailIdle}>{trailing}</span>
                    <span className={css.trailHover}>{!touch && <span className={css.hoverOnly}>{actions}</span>}{more}</span>
                  </>
                ))}
            </span>
          </div>,
        )}
      </li>
    )
  }

  return (
    <li {...item} className={css.item} data-variant="card">
      {wrap(
        <div {...surface} className={cx(css.row, css.card)}>
          <div className={css.top}>
            {chat.workspace !== null && <WorkspaceBadge title={chat.workspace.title} workspaceId={chat.workspace.workspaceId} color={color} />}
            {pin}
            <span className={css.workspace}>{chat.workspace?.title ?? t('row.noWorkspace')}</span>
            <span className={css.trail}>
              {dropBadge ?? (jumpLabel !== null
                ? <JumpHint label={jumpLabel} />
                : (
                  <>
                    <span className={css.trailIdle}>{statusOrAge}</span>
                    <span className={css.trailHover}>
                      {!touch && (
                        <span className={css.hoverOnly}>
                          {states !== null && chat.status !== 'working' && (
                            <SnoozeButton id={chat.id} states={states} open={snoozeOpen} setOpen={setSnoozeOpen} t={t} />
                          )}
                          {settleButton}
                        </span>
                      )}
                      {more}
                    </span>
                  </>
                ))}
            </span>
          </div>
          <div className={css.titleLine}>
            <span className={css.title} dir="auto">{chat.title}</span>
            <ModelIcon model={chat.model} size={14} />
          </div>
        </div>,
      )}
    </li>
  )
})
