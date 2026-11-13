/**
 * The chat-states plugin's studio half: the Snoozed and Settled shelves of
 * the sidebar's one-list view through upstream's `uiWorkspace.registerShelf`,
 * Snooze and Settle in each chat's menu through `ctx.contextMenus`, a settle
 * hover button, a notice when a change could not be saved, `ctx.deloChatStates`
 * for a sidebar that draws its own shelves, Settings' Snooze and idle chats
 * section, which edits the snooze presets and auto-settle, and a polite live
 * region that announces when the studio loses and regains Delo. The states come
 * from the harness, so every studio shows the same ones.
 *
 * The plugin applies only while the Delo look is on (the `deloStudio`
 * service); the stock look registers nothing, and the harness keeps the
 * states for when the Delo look returns.
 * @module @delo/plugin-chat-states/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the ctx.workspaces merge, which names the archived chats.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.contextMenus merge and the 'contextMenu.icon' seat.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: the 'shell.overlay' slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconAlarmClockOutlineRegular, IconCheckCircleFillRegular, IconCheckCircleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms merge and the 'settings.section' seat.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.uiWorkspace merge and the sidebar row slots.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CHAT_STATES_ROW_ID, DEFAULT_CHAT_STATES_SETTINGS, type ChatStatesSettings } from '../config.ts'
import type { SnoozePresetSetting } from '../snooze.ts'
import type { ChatState, ChatStateRequest } from '../wire.ts'
import { chatStatesApi } from './api.ts'
import { ChatStateFailure, SettleRowButton, type ChatStatesInjected } from './ChatStateActions.tsx'
import { ConnectionStatus, type ConnectionStatusInjected } from './ConnectionStatus.tsx'
import { CustomSnoozeDialog, type CustomSnoozeInjected } from './CustomSnooze.tsx'
import { en, zh, type ChatStatesLocaleKey } from './locales.ts'
import { snoozeLeftText, snoozeOptions, type SnoozeOption } from './snooze-text.ts'
import { SnoozeSettingsSection, type SnoozeSettingsInjected } from './SnoozeSettings.tsx'
import { ChatStateStore } from './store.ts'

export type { ChatStatesApi } from './api.ts'
export { ChatStatesRequestError } from './api.ts'
export type { ChatStatesInjected } from './ChatStateActions.tsx'
export type { ConnectionStatusInjected } from './ConnectionStatus.tsx'
export type { CustomSnoozeInjected } from './CustomSnooze.tsx'
export type { ChatStatesLocaleKey } from './locales.ts'
export type { SnoozeOption } from './snooze-text.ts'
export { snoozeLabelText, snoozeLeftText, snoozeOptions, snoozeWhenText } from './snooze-text.ts'
export type { SnoozeSettingsInjected } from './SnoozeSettings.tsx'
export { ChatStateStore } from './store.ts'
export type { ChatState, ChatStateRequest } from '../wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Each chat's snooze, settle and waking, and the changes to them, for a sidebar that draws its own shelves. */
    deloChatStates: DeloChatStates
  }
}

/** What `ctx.deloChatStates` shares. */
export interface DeloChatStates {
  /** Each chat's state, by session id. */
  readonly states: HostObservable<Readonly<Record<string, ChatState>>>
  /** Snoozed chats, with the time each was snoozed. */
  readonly snoozed: HostObservable<ReadonlyMap<SessionId, number>>
  /** Settled chats, with the time each was settled. */
  readonly settled: HostObservable<ReadonlyMap<SessionId, number>>
  /** Chats woken by their snooze's end and not seen since, with the time each woke. */
  readonly woke: HostObservable<ReadonlyMap<SessionId, number>>
  /** Chats the person returned to the list, with the time each was returned. */
  readonly kept: HostObservable<ReadonlyMap<SessionId, number>>
  /** The idle days after which a chat counts as settled until it changes or is returned; 0 is off. */
  readonly autoSettleDays: HostObservable<number>
  /**
   * Ask the harness for a change; a failure shows the plugin's notice.
   * @param request - the change.
   * @returns when the answer is shown.
   */
  readonly change: (request: ChatStateRequest) => Promise<void>
  /**
   * The snooze menu's rows now, worded in the studio's language.
   * @returns each row's id, label, end time and end.
   */
  readonly snoozeOptions: () => readonly SnoozeOption[]
  /**
   * Word the time left on a snooze, such as 3h.
   * @param until - when the snooze ends.
   * @returns the time left.
   */
  readonly snoozeLeft: (until: number) => string
  /**
   * Open the snooze dialog for a chat: the presets as quick picks, then a date and time or a duration.
   * @param sessionId - the chat.
   */
  readonly openCustom: (sessionId: SessionId) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The chat states' copy. */
    'deloChatStates': ChatStatesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloChatStates'

/** The shelves' ids and places: Snoozed above Settled. */
export const SHELVES = { snoozed: { id: 'delo-snoozed', order: 10 }, settled: { id: 'delo-settled', order: 20 } } as const

/** The Snooze and idle chats section's id and its place in Settings, after the Sidebar section. */
export const SECTION = { id: 'delo-chat-states', order: 3 } as const

/**
 * A chat's menu entries: Snooze (or Wake now) and Settle (or Return to the list), placed between fork (300) and the
 * session id (450). The ids are unique within the session menu.
 */
export const MENU = { snooze: { id: 'delo-chat-states.snooze', order: 350 }, settle: { id: 'delo-chat-states.settle', order: 360 } } as const

/** The settle hover button's id and place among a row's buttons: before archive (100) and pin (200), so pin stays rightmost. */
export const ROW_ACTION = { id: 'delo-settle', order: 50 } as const

/** The menu icons' keys in the `contextMenu.icon` seat. */
export const MENU_ICON_KEYS = {
  snooze: 'delo-chat-states.snooze',
  settle: 'delo-chat-states.settle',
  settled: 'delo-chat-states.settled',
} as const

/**
 * Services every registration needs. `deloStudio`, which `@delo/plugin-theme` provides only while the Delo look is on,
 * is injected inside {@link apply} instead, so the entry stays active under the stock look and registers nothing there.
 */
export const inject = ['slots', 'locale', 'uiWorkspace', 'configForms', 'contextMenus', 'workspaces', 'connection']

/**
 * While the Delo look provides `deloStudio`, read the states, register the shelves and the sidebar's actions.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['deloStudio'], applyStudio)
}

/**
 * Everything the plugin registers while the Delo look is on; disposed with the `deloStudio` service.
 * @param ctx - the browser plugin context, holding `deloStudio`.
 */
export function applyStudio(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-chat-states: dictionaries')
  const store = new ChatStateStore(chatStatesApi)

  const form = ctx.configForms.get<ChatStatesSettings>(CHAT_STATES_ROW_ID)
  const current = (): ChatStatesSettings => form.getSnapshot().value ?? DEFAULT_CHAT_STATES_SETTINGS
  const presets = (): readonly SnoozePresetSetting[] => current().snoozePresets
  const autoSettleDays: HostObservable<number> = { getSnapshot: () => current().autoSettleDays, subscribe: listener => form.subscribe(listener) }
  const refreshSeconds: HostObservable<number> = { getSnapshot: () => current().refreshSeconds, subscribe: listener => form.subscribe(listener) }
  ctx.effect(() => store.start(refreshSeconds), 'delo-chat-states: reads')
  ctx.effect(() => ctx.uiWorkspace.registerShelf({ ...SHELVES.snoozed, label: () => t('shelf.snoozed'), members: store.snoozed }), 'delo-chat-states: Snoozed')
  ctx.effect(() => ctx.uiWorkspace.registerShelf({ ...SHELVES.settled, label: () => t('shelf.settled'), members: store.settled }), 'delo-chat-states: Settled')

  const custom = createSnapshotStore<SessionId | null>(null)
  const openCustom = (sessionId: SessionId): void => { custom.set(sessionId) }
  const locale = (): string => ctx.locale.getLocale().active
  const change = (request: ChatStateRequest): void => { void store.change(request) }
  const dismiss = (): void => { store.failed.set(false) }

  const section: SnoozeSettingsInjected = { settings: form, locale, reportFailure: () => { store.failed.set(true) } }
  ctx.effect(() => ctx.configForms.whileServed([CHAT_STATES_ROW_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: SECTION.id, order: SECTION.order, label: () => t('settings.nav'), locale: NS, inject: () => section,
  }, SnoozeSettingsSection))), 'delo-chat-states: Snooze and idle chats section')

  // An archived chat offers neither entry. Each entry re-resolves when the states, the archive or the language change,
  // and `run` reads the states again, since a menu can stay open while another browser changes the chat.
  const archived = (sessionId: SessionId): boolean => ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)
  const snoozedNow = (sessionId: SessionId): boolean => {
    const until = store.states.getSnapshot()[sessionId]?.snoozedUntil
    return until !== undefined && until > Date.now()
  }
  const settledNow = (sessionId: SessionId): boolean => store.states.getSnapshot()[sessionId]?.settledAt !== undefined
  ctx.effect(() => ctx.contextMenus.register({
    ...MENU.snooze, target: 'session',
    observe: () => [store.states, ctx.workspaces.list, ctx.locale],
    resolve: ({ sessionId }) => archived(sessionId) ? [] : [{
      id: 'snooze', label: t(snoozedNow(sessionId) ? 'snooze.wake' : 'snooze.open'), icon: { key: MENU_ICON_KEYS.snooze },
      run: () => { if (snoozedNow(sessionId)) change({ action: 'wake', session: sessionId }); else openCustom(sessionId) },
    }],
  }), 'delo-chat-states: Snooze menu entry')
  ctx.effect(() => ctx.contextMenus.register({
    ...MENU.settle, target: 'session',
    observe: () => [store.states, ctx.workspaces.list, ctx.locale],
    resolve: ({ sessionId }) => archived(sessionId) ? [] : [{
      id: 'settle', label: t(settledNow(sessionId) ? 'settle.undo' : 'settle'),
      icon: { key: settledNow(sessionId) ? MENU_ICON_KEYS.settled : MENU_ICON_KEYS.settle },
      run: () => { change({ action: settledNow(sessionId) ? 'unsettle' : 'settle', session: sessionId }) },
    }],
  }), 'delo-chat-states: Settle menu entry')
  ctx.effect(() => ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: MENU_ICON_KEYS.snooze }, IconAlarmClockOutlineRegular)
    yield ctx.slots.register({ name: 'contextMenu.icon', key: MENU_ICON_KEYS.settle }, IconCheckCircleOutlineRegular)
    yield ctx.slots.register({ name: 'contextMenu.icon', key: MENU_ICON_KEYS.settled }, IconCheckCircleFillRegular)
  }), 'delo-chat-states: menu icons')

  // Upstream's connection service is not a typed Context member; its consumers read it as the handle it is.
  const connection: ConnectionStatusInjected = { hooks: { connectionState: (ctx.get('connection') as ConnectionHandle).state } }
  const row: ChatStatesInjected = { states: store.states, failed: store.failed, change, dismiss }
  const dialog: CustomSnoozeInjected = { custom, closeCustom: () => { custom.set(null) }, change, locale, now: Date.now, presets }
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action', ...ROW_ACTION, locale: NS, inject: () => row,
  }, SettleRowButton)), 'delo-chat-states: settle hover button')
  ctx.effect(() => ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'delo-chat-states.failure', locale: NS, inject: () => row }, ChatStateFailure)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'delo-chat-states.snooze', locale: NS, inject: () => dialog }, CustomSnoozeDialog)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'delo-chat-states.connection', locale: NS, inject: () => connection }, ConnectionStatus)
  }), 'delo-chat-states: overlay entries')
  ctx.provide('deloChatStates', {
    states: store.states,
    snoozed: store.snoozed,
    settled: store.settled,
    woke: store.woke,
    kept: store.kept,
    autoSettleDays,
    change: request => store.change(request),
    snoozeOptions: () => snoozeOptions(new Date(), t, locale(), presets()).options,
    snoozeLeft: until => snoozeLeftText(until, Date.now(), t),
    openCustom,
  } satisfies DeloChatStates)
}
