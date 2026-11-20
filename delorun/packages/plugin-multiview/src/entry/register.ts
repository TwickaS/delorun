/**
 * Registers the Multiview entry points: the `multiview` service, the pin button, the popover footer, the header button, the
 * auto-pin observer and the reopen on return.
 * @module @delorun/plugin-multiview/entry/register
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.layout merge.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the conversation header slots.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the agents popover's row and footer slots.
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DEFAULT_MULTIVIEW_SETTINGS, MULTIVIEW_ROW_ID, type MultiviewSettings } from '../config.ts'
import { MULTIVIEW_NS, MULTIVIEW_PANEL_ID, type MultiviewPersistence } from '../client/contract.ts'
import { Footer, HeaderButton, PinButton, type EntryInjected } from './Entry.tsx'
import { en, zh } from './locales.ts'
import { catalogOf, mainChatOf } from './read.ts'
import { MultiviewStore } from './state.ts'
import { HandOffWatcher } from './watcher.ts'

/** The header button's place in the actions band: just after the agents list (10), before background tasks (20). */
export const HEADER_ORDER = 11

const PANEL = brandString<MainPanelId>(MULTIVIEW_PANEL_ID)

/** What the registration needs from its surroundings besides the context. */
export interface RegisterOptions {
  /** Where chats' Multiview state is kept. */
  readonly persistence: MultiviewPersistence
  /** The window's size, for "no room" until the layout reports its own area. */
  readonly windowArea: () => { readonly width: number; readonly height: number }
}

/**
 * The settings as an observable that changes identity only when the stored value does.
 * @param ctx - the browser context.
 * @returns the settings, each missing field at its default.
 */
function settingsOf(ctx: Context): HostObservable<MultiviewSettings> {
  const form = ctx.configForms.get<Partial<MultiviewSettings>>(MULTIVIEW_ROW_ID)
  let source: Partial<MultiviewSettings> | undefined
  let merged = DEFAULT_MULTIVIEW_SETTINGS
  return {
    getSnapshot: () => {
      const value = form.getSnapshot().value
      if (value !== source) {
        source = value
        merged = value === undefined ? DEFAULT_MULTIVIEW_SETTINGS : { ...DEFAULT_MULTIVIEW_SETTINGS, ...value }
      }
      return merged
    },
    subscribe: listener => form.subscribe(listener),
  }
}

/**
 * Register everything the entry points add.
 * @param ctx - the browser context; needs `slots`, `locale`, `sessions`, `layout` and `configForms`.
 * @param options - the persistence and the window measure.
 * @returns the service, which the panel lane reads through `ctx.multiview` too.
 */
export function registerEntry(ctx: Context, options: RegisterOptions): MultiviewStore {
  ctx.effect(() => ctx.locale.register(MULTIVIEW_NS, { en, zh }), 'delorun-multiview: dictionaries')
  const settings = settingsOf(ctx)
  const panelRegistered = (): boolean => ctx.slots.entries('main').some(entry => entry.options.key === PANEL)
  const store: MultiviewStore = new MultiviewStore({
    settings,
    persistence: options.persistence,
    windowArea: options.windowArea,
    show: (_chat, open) => {
      if (open) { if (panelRegistered()) ctx.layout.selectPanel(PANEL) }
      else if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) ctx.layout.selectPanel(null)
    },
  })
  ctx.effect(() => ctx.provide('multiview', store), 'delorun-multiview: service')

  const activePanel: HostObservable<string | null> = {
    getSnapshot: () => ctx.layout.panelInfo.getSnapshot().activePanelId,
    subscribe: listener => ctx.layout.panelInfo.subscribe(listener),
  }
  const injected = (): EntryInjected => ({ multiview: store, activePanel })
  // The entry points exist only while the `multiview` main panel is registered: without it "Open Multiview" would do nothing.
  ctx.effect(() => whilePanelRegistered(ctx, panelRegistered, () => mountEntries(ctx, store, injected)), 'delorun-multiview: entry points')
  return store
}

/**
 * Run a mount while the `multiview` main panel is registered: mount when it appears, unmount when it goes.
 * @param ctx - the browser context.
 * @param registered - whether the panel is registered now.
 * @param mount - mounts the entry points and returns their disposer.
 * @returns the disposer, which also unmounts.
 */
function whilePanelRegistered(ctx: Context, registered: () => boolean, mount: () => () => void): () => void {
  let unmount: (() => void) | undefined
  const sync = (): void => {
    const present = registered()
    if (present && unmount === undefined) unmount = mount()
    else if (!present && unmount !== undefined) {
      unmount()
      unmount = undefined
    }
  }
  const stop = ctx.slots.subscribe('main', sync)
  sync()
  return () => {
    stop()
    unmount?.()
    unmount = undefined
  }
}

/**
 * Register the pin button, the popover footer and the header button, and start the hand-off observer.
 * @param ctx - the browser context.
 * @param store - the state.
 * @param injected - the services the components read.
 * @returns the disposer.
 */
function mountEntries(ctx: Context, store: MultiviewStore, injected: () => EntryInjected): () => void {
  const row = 'conversation.session.header.actions.subagent.row.trail'
  const footer = 'conversation.session.header.actions.subagent.footer'
  const actions = 'conversation.session.header.actions'
  const disposers = [
    ctx.slots.inject(row, () => ctx.slots.register({ name: row, id: 'multiview-pin', locale: MULTIVIEW_NS, inject: injected }, PinButton)),
    ctx.slots.inject(footer, () => ctx.slots.register({ name: footer, id: 'multiview-footer', order: 100, locale: MULTIVIEW_NS, inject: injected }, Footer)),
    ctx.slots.inject(actions, () => ctx.slots.register({ name: actions, id: 'multiview-button', order: HEADER_ORDER, locale: MULTIVIEW_NS, inject: injected }, HeaderButton)),
    observeChats(ctx, store),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * Watch the main chat: pin and open for each new hand-off, reopen a chat that had Multiview open, and record a close the
 * person made.
 * @param ctx - the browser context.
 * @param store - the state.
 * @returns the disposer.
 */
function observeChats(ctx: Context, store: MultiviewStore): () => void {
  const watcher = new HandOffWatcher()
  let main: SessionId | undefined
  let shownFor: SessionId | undefined
  const active = (): boolean => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL
  const onSessions = (): void => {
    const state = ctx.sessions.list.getSnapshot()
    const next = mainChatOf(state)
    const fresh = watcher.observe(next, next === undefined ? undefined : catalogOf(state, next))
    const changed = next !== main
    main = next
    if (main === undefined) return
    const config = store.settings.getSnapshot()
    if (changed && config.reopenOnReturn && store.of(main).getSnapshot().open && !active()) store.open(main)
    if (fresh.length === 0) return
    store.pinAll(main, fresh)
    if (config.autoOpen && store.of(main).getSnapshot().pins.length > 0) store.open(main)
  }
  let wasActive = active()
  const onPanel = (): void => {
    const now = active()
    if (now && !wasActive) shownFor = main
    if (!now && wasActive && main !== undefined && main === shownFor) store.markClosed(main)
    wasActive = now
  }
  const stopSessions = ctx.sessions.list.subscribe(onSessions)
  const stopPanel = ctx.layout.panelInfo.subscribe(onPanel)
  onSessions()
  onPanel()
  return () => { stopSessions(); stopPanel() }
}
