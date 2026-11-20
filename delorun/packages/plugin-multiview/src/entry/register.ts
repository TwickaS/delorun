/**
 * Registers the Multiview entry points: the `multiview` service, the pin button, the popover footer, the header button and the
 * auto-pin observer.
 * @module @delorun/plugin-multiview/entry/register
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the conversation header slots.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the agents popover's row and footer slots.
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import { DEFAULT_MULTIVIEW_SETTINGS, MULTIVIEW_ROW_ID, type MultiviewSettings } from '../config.ts'
import { MULTIVIEW_LAYER_ID, MULTIVIEW_NS, type MultiviewPersistence } from '../client/contract.ts'
import { Footer, HeaderButton, PinButton, type EntryInjected } from './Entry.tsx'
import { en, zh } from './locales.ts'
import { catalogOf, mainChatOf } from './read.ts'
import { MultiviewStore } from './state.ts'
import { HandOffWatcher } from './watcher.ts'

/** The slot that holds Multiview's layer around the main chat's content. */
const LAYER_SLOT = 'conversation.main.body'

/** The header button's place in the actions band: just after the agents list (10), before background tasks (20). */
export const HEADER_ORDER = 11

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
 * @param ctx - the browser context; needs `slots`, `locale`, `sessions` and `configForms`.
 * @param options - the persistence and the window measure.
 * @returns the service, which the panel lane reads through `ctx.multiview` too.
 */
export function registerEntry(ctx: Context, options: RegisterOptions): MultiviewStore {
  ctx.effect(() => ctx.locale.register(MULTIVIEW_NS, { en, zh }), 'delorun-multiview: dictionaries')
  const settings = settingsOf(ctx)
  const layerRegistered = (): boolean => ctx.slots.entries(LAYER_SLOT).some(entry => entry.options.id === MULTIVIEW_LAYER_ID)
  const store: MultiviewStore = new MultiviewStore({ settings, persistence: options.persistence, windowArea: options.windowArea })
  ctx.effect(() => ctx.provide('multiview', store), 'delorun-multiview: service')

  const injected = (): EntryInjected => ({ multiview: store })
  // The entry points exist only while Multiview's layer is registered in the main content: without it "Open Multiview" would do nothing.
  ctx.effect(() => whileLayerRegistered(ctx, layerRegistered, () => mountEntries(ctx, store, injected)), 'delorun-multiview: entry points')
  return store
}

/**
 * Run a mount while Multiview's layer is registered: mount when it appears, unmount when it goes.
 * @param ctx - the browser context.
 * @param registered - whether the layer is registered now.
 * @param mount - mounts the entry points and returns their disposer.
 * @returns the disposer, which also unmounts.
 */
function whileLayerRegistered(ctx: Context, registered: () => boolean, mount: () => () => void): () => void {
  let unmount: (() => void) | undefined
  const sync = (): void => {
    const present = registered()
    if (present && unmount === undefined) unmount = mount()
    else if (!present && unmount !== undefined) {
      unmount()
      unmount = undefined
    }
  }
  const stop = ctx.slots.subscribe(LAYER_SLOT, sync)
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
 * Watch the main chat: pin and open for each new hand-off, and, with reopening on return off, close a chat that was left open.
 * @param ctx - the browser context.
 * @param store - the state.
 * @returns the disposer.
 */
function observeChats(ctx: Context, store: MultiviewStore): () => void {
  const watcher = new HandOffWatcher()
  let seen: SessionId | undefined
  const onSessions = (): void => {
    const state = ctx.sessions.list.getSnapshot()
    const main = mainChatOf(state)
    if (main !== seen) {
      // An open chat stays open in its own state, which is what shows it again on return; without that setting it is closed when left
      // and when a page load finds it open.
      if (!store.settings.getSnapshot().reopenOnReturn) for (const chat of [seen, main]) if (chat !== undefined && store.of(chat).getSnapshot().open) store.close(chat)
      seen = main
    }
    const fresh = watcher.observe(main, main === undefined ? undefined : catalogOf(state, main))
    if (main === undefined || fresh.length === 0) return
    store.pinAll(main, fresh)
    if (store.settings.getSnapshot().autoOpen && store.of(main).getSnapshot().pins.length > 0) store.open(main)
  }
  const stop = ctx.sessions.list.subscribe(onSessions)
  onSessions()
  return stop
}
