/**
 * Delorun's sidebar, studio half: T3 Code's sidebar in upstream's seats. The
 * chat list fills `sidebar.workspaces.list`, the header art
 * `sidebar.backdrop`, and Settings → Sidebar chooses the art, its palette,
 * the list's view and the shelves. The list's header offers New chat, so the
 * wide sidebar hides upstream's New Session button, and the foot is one row.
 * Delorun's chat-states plugin (`ctx.delorunChatStates`) adds the Snoozed and
 * Settled shelves, snoozing, settling and wakings; the list follows it
 * arriving or leaving. Below the list, a quiet notice names a newer Delorun
 * release when the harness's update check found one.
 *
 * The plugin applies only while the Delorun look is on (the `delorunStudio`
 * service); with the stock look it registers nothing, and every sidebar and
 * layout change it made is undone.
 * @module @delorun/plugin-sidebar/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'connection/reset' event merge and the connection service's type.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.contextMenus merge, whose open menu keeps its chat's row lit.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.uiWorkspace merge and the list seat.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.sidebarLayout merge and the backdrop seat.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the ctx.layout merge.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.configForms merge and the 'settings.section' and 'settings.launcher' seats.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DelorunChatStates } from '@delorun/plugin-chat-states/client'
// Type-only: the 'delorun-update/open' event the notice's Update now… emits.
import type {} from '@delorun/plugin-update/client'
// Type-only: the ctx.delorunStudio merge.
import type {} from '@delorun/plugin-theme/client'
import { DEFAULT_SIDEBAR_SETTINGS, SIDEBAR_ROW_ID, type SidebarSettings } from '../config.ts'

/** The row of the release check, whose `enabled` switch mounts the notice route. */
const UPDATE_CHECK_ROW_ID = 'delorun-update-check'
import { parseWorkspaceIcon, pruneWorkspaceIcons, withWorkspaceIcon } from '../workspace-icon.ts'
import type { RowStateActions } from './ChatRow.tsx'
import { FootLauncher } from './FootLauncher.tsx'
import { HeaderArt, type HeaderArtInjected } from './HeaderArt.tsx'
import { en, zh } from './locales.ts'
import { Sidebar, type SidebarInjected } from './Sidebar.tsx'
import { SidebarSettingsSection, type SidebarSettingsInjected } from './SettingsSection.tsx'
import './touch-targets.css'
import { UndoNotice, type UndoNoticeInjected } from './UndoNotice.tsx'
import { createUndoLine } from './undo.ts'
import { fetchUpdateNotes, fetchUpdateNotice, UpdateNoticeStore } from './update-notice.ts'
import type { UpdateNoticeFace } from './UpdateNotice.tsx'

export type { RowDrag, RowSnoozeOption, RowStateActions, MenuPoint } from './ChatRow.tsx'
export type { SidebarInjected, SidebarProps, SidebarSources } from './Sidebar.tsx'
export type { SidebarLocaleKey } from './locales.ts'
export type { HeaderArtInjected } from './HeaderArt.tsx'
export type { SidebarSettingsInjected, SidebarSettingsProps } from './SettingsSection.tsx'
export type { FootLauncherProps } from './FootLauncher.tsx'
export type { UndoNoticeInjected, UndoNoticeProps } from './UndoNotice.tsx'
export { createUndoLine, type UndoEntry, type UndoKind, type UndoLine } from './undo.ts'
export { DISMISSED_KEY, fetchUpdateNotes, fetchUpdateNotice, UpdateNoticeResponseSchema, UpdateNoticeStore, type DismissalStorage } from './update-notice.ts'
export { UpdateNoticeCard, type UpdateNoticeCardProps, type UpdateNoticeFace } from './UpdateNotice.tsx'
export { GENERATIVE_SCENES, GenerativeArt, seededRandom, type GenerativeScene } from './GenerativeArt.tsx'
export { IconPicker, ICON_EMOJIS, type IconPickerProps, type IconPickerTarget } from './IconPicker.tsx'
export { GLYPHS, WorkspaceBadge, WorkspaceIconsContext } from './WorkspaceBadge.tsx'
export * from '../workspace-icon.ts'
export {
  BlueprintArt, NightSkyArt, StageBackdrop, STAGE_PALETTES, STAGE_SCENES, INK_EDGE_IDS, INK_EDGE_OPACITY, INK_EDGE_RADIUS, INK_EDGE_SHADE, INK_EDGE_TOKEN, InkEdgeFilters, type InkEdgePart, type StagePalette, type StageScene,
} from './StageArt.tsx'
export { DRAG_DISTANCE, useListDrag, type DragView, type ListDrag, type ListDragOptions } from './drag.ts'
export * from './sections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The chat list's add-workspace affordance, present while the list is mounted. */
    delorunSidebar: DelorunSidebar
  }
}

/** What `ctx.delorunSidebar` shares. */
export interface DelorunSidebar {
  /**
   * Whether the host can add a workspace through the list.
   * @returns the owner's latest `canAddWorkspace`.
   */
  canAddWorkspace(): boolean
  /** Start the owner's add-workspace flow, as the list's Add workspace button does. */
  addWorkspace(): void
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunSidebar'

/**
 * Services every registration needs. `delorunStudio`, which `@delorun/plugin-theme` provides only while the Delorun look is on,
 * is injected inside {@link apply} instead, so the entry stays active under the stock look and registers nothing there.
 */
export const inject = ['slots', 'locale', 'uiWorkspace', 'configForms', 'contextMenus']

/** The Sidebar section's id and its place in Settings, after Appearance. */
export const SECTION = { id: 'delorun-sidebar', order: 2 } as const

/** The foot's Settings button shadows upstream's account launcher (priority 0) in the launcher seat. */
export const LAUNCHER_PRIORITY = -2

/** The undo notice's place among the foot's actions: before the update button, which ends the row. */
export const UNDO_NOTICE = { id: 'delorun-sidebar.undo', order: -2 } as const

/** Upstream's drag floor, which the sidebar keeps unless the chosen width is narrower. */
export const STOCK_MIN_WIDTH = 264

/** Where the sidebar keeps a viewer's preferences, such as the workspace filter and each shelf's folding. */
export const PREFERENCE_PREFIX = 'delorun:sidebar:'

const NONE: ReadonlyMap<SessionId, number> = new Map()
const PRESENT: HostObservable<boolean> = { getSnapshot: () => true, subscribe: () => () => {} }

/**
 * A source over an optional service's own source: the fallback while the service is absent, its value once it
 * arrives, following it in and out.
 * @param ctx - the plugin context, whose `internal/service` event says when a service comes or goes.
 * @param name - the service's name.
 * @param pick - the service's source this one follows.
 * @param fallback - the value while the service is absent.
 * @returns the source.
 */
export function optionalSource<S, T>(ctx: Context, name: string, pick: (service: S) => HostObservable<T>, fallback: T): HostObservable<T> {
  const service = (): S | undefined => ctx.get(name) as S | undefined
  let pickedFor: S | undefined
  let picked: HostObservable<T> | undefined
  const sourceOf = (present: S): HostObservable<T> => {
    if (present !== pickedFor || picked === undefined) {
      pickedFor = present
      picked = pick(present)
    }
    return picked
  }
  return {
    getSnapshot: () => {
      const present = service()
      return present === undefined ? fallback : sourceOf(present).getSnapshot()
    },
    subscribe: (listener) => {
      let inner: (() => void) | undefined
      const follow = (): void => {
        inner?.()
        const present = service()
        inner = present === undefined ? undefined : sourceOf(present).subscribe(listener)
      }
      follow()
      const stop = ctx.on('internal/service', (changed: string) => {
        if (changed !== name) return
        follow()
        listener()
      })
      return () => {
        stop()
        inner?.()
      }
    },
  }
}

/**
 * Each snoozed chat's end, derived from the chat states and kept while they stay the same.
 * @param chatStates - the chat-states service.
 * @returns the source.
 */
export function snoozeEnds(chatStates: DelorunChatStates): HostObservable<ReadonlyMap<SessionId, number>> {
  let seen: unknown
  let ends: ReadonlyMap<SessionId, number> = NONE
  return {
    getSnapshot: () => {
      const states = chatStates.states.getSnapshot()
      if (states !== seen) {
        seen = states
        ends = new Map(Object.entries(states).flatMap(([id, state]) => (state.snoozedUntil === undefined ? [] : [[id as SessionId, state.snoozedUntil]])))
      }
      return ends
    },
    subscribe: listener => chatStates.states.subscribe(listener),
  }
}

/**
 * The row actions over the chat-states service.
 * @param chatStates - the service.
 * @returns the actions.
 */
export function stateActions(chatStates: DelorunChatStates): RowStateActions {
  const change = (request: Parameters<DelorunChatStates['change']>[0]): void => { void chatStates.change(request) }
  return {
    settle: (id) => { change({ action: 'settle', session: id }) },
    unsettle: (id) => { change({ action: 'unsettle', session: id }) },
    snooze: (id, until) => { change({ action: 'snooze', session: id, until }) },
    wake: (id) => { change({ action: 'wake', session: id }) },
    seen: (id) => { change({ action: 'seen', session: id }) },
    snoozeOptions: () => chatStates.snoozeOptions(),
    openCustom: (id) => { chatStates.openCustom(id) },
    snoozeLeft: until => chatStates.snoozeLeft(until),
  }
}

/** A viewer's preferences in the browser's storage; a browser that refuses storage keeps each default. */
export const preference: SidebarInjected['preference'] = {
  read: (key) => {
    try {
      return window.localStorage.getItem(PREFERENCE_PREFIX + key)
    } catch (error) {
      // Storage refused, such as in a private window: the default stands.
      console.warn('delorun sidebar: could not read a preference', error)
      return null
    }
  },
  write: (key, value) => {
    try {
      window.localStorage.setItem(PREFERENCE_PREFIX + key, value)
    } catch (error) {
      // Storage refused: the choice holds for this page only.
      console.warn('delorun sidebar: could not keep a preference', error)
    }
  },
}

/**
 * While the Delorun look provides `delorunStudio`, register the dictionaries, the chat list with the update notice below it, the header art, the Sidebar section
 * and T3 Code's foot (its Settings button and undo notice in one row), and hide upstream's New Session button while the list offers its own.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['delorunStudio'], applyStudio)
}

/**
 * Everything the plugin registers while the Delorun look is on; disposed with the `delorunStudio` service.
 * @param ctx - the browser plugin context, holding `delorunStudio`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-sidebar: dictionaries')
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<SidebarSettings>(SIDEBAR_ROW_ID)
  let seen: unknown
  let settingsValue: SidebarSettings = DEFAULT_SIDEBAR_SETTINGS
  const settings: HostObservable<SidebarSettings> = {
    getSnapshot: () => {
      const value = form.getSnapshot().value
      if (value !== seen) {
        seen = value
        settingsValue = value ?? DEFAULT_SIDEBAR_SETTINGS
      }
      return settingsValue
    },
    subscribe: listener => form.subscribe(listener),
  }

  const art: HeaderArtInjected = { hooks: { settings } }
  ctx.effect(() => ctx.slots.inject('sidebar.backdrop', () => ctx.slots.register({ name: 'sidebar.backdrop', inject: () => art }, HeaderArt)), 'delorun-sidebar: header art')
  const section: SidebarSettingsInjected = { settings: form }
  ctx.effect(() => ctx.configForms.whileServed([SIDEBAR_ROW_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: SECTION.id, order: SECTION.order, label: () => t('settings.nav'), locale: NS, inject: () => section,
  }, SidebarSettingsSection))), 'delorun-sidebar: Sidebar section')

  const pin = (id: SessionId): void => {
    ctx.uiWorkspace.pinSession(id).catch((error: unknown) => { console.warn('delorun sidebar: the chat was not pinned', error) })
  }
  const unpin = (id: SessionId): void => {
    ctx.uiWorkspace.unpinSession(id).catch((error: unknown) => { console.warn('delorun sidebar: the chat was not unpinned', error) })
  }
  const undoLine = createUndoLine()
  const updates = new UpdateNoticeStore(fetchUpdateNotice, preference)
  const refreshMinutes: HostObservable<number> = { getSnapshot: () => settings.getSnapshot().updateNoticeRefreshMinutes, subscribe: settings.subscribe }
  // The notice route exists only while the release check is on. A disabled row is not exposed to the client (status `unavailable`), so
  // only a ready, enabled row reads; reading otherwise answers 404 on every page load.
  const releaseCheck = ctx.configForms.get<{ readonly enabled?: boolean }>(UPDATE_CHECK_ROW_ID)
  ctx.effect(() => {
    let stop: (() => void) | undefined
    const follow = (): void => {
      const { status, value } = releaseCheck.getSnapshot()
      const reads = status === 'ready' && value?.enabled === true
      if (reads && stop === undefined) stop = updates.start(refreshMinutes, listener => ctx.on('connection/reset', listener))
      if (!reads && stop !== undefined) {
        stop()
        stop = undefined
        updates.answered.set(null)
      }
    }
    follow()
    const unsubscribe = releaseCheck.subscribe(follow)
    return () => {
      unsubscribe()
      stop?.()
    }
  }, 'delorun-sidebar: update notice reads')
  // A page a reach listener served, a remote session, shows Update now… only while the Host's state lets it begin an update.
  const remote = (ctx.get('connection') as ConnectionHandle | undefined)?.remoteMedia === 'placeholder'
  const updateNotice: UpdateNoticeFace = { notice: updates.visible, notes: fetchUpdateNotes, open: () => { ctx.emit('delorun-update/open') }, canOpen: remote ? optionalSource<{ readonly canUpdate: HostObservable<boolean> }, boolean>(ctx, 'delorunUpdate', service => service.canUpdate, false) : PRESENT, dismiss: (release) => { updates.dismiss(release) }, remote }
  let actionsFor: DelorunChatStates | undefined
  let actions: RowStateActions | null = null
  const chatStatesSource = <T,>(pick: (service: DelorunChatStates) => HostObservable<T>, fallback: T) =>
    optionalSource<DelorunChatStates, T>(ctx, 'delorunChatStates', pick, fallback)
  const list: SidebarInjected = {
    hooks: {
      snoozed: chatStatesSource(service => service.snoozed, NONE),
      settled: chatStatesSource(service => service.settled, NONE),
      woke: chatStatesSource(service => service.woke, NONE),
      kept: chatStatesSource(service => service.kept, NONE),
      autoSettleDays: chatStatesSource(service => service.autoSettleDays, 0),
      snoozedUntil: chatStatesSource(snoozeEnds, NONE),
      chatStatesReady: chatStatesSource(() => PRESENT, false),
      menuTarget: ctx.contextMenus.active,
      settings,
    },
    states: () => {
      const service = ctx.get('delorunChatStates')
      if (service !== actionsFor) {
        actionsFor = service
        actions = service === undefined ? null : stateActions(service)
      }
      return actions
    },
    pin,
    unpin,
    setWorkspaceIcon: (workspaceId, icon) => {
      if (icon !== null && parseWorkspaceIcon(icon) === undefined) {
        console.warn('delorun sidebar: the workspace icon was not saved because it is not a valid icon')
        return
      }
      form.set('workspaceIcons', withWorkspaceIcon(settings.getSnapshot().workspaceIcons, workspaceId, icon)).then((ok) => {
        if (!ok) console.warn('delorun sidebar: the workspace icon was not saved')
      }, (error: unknown) => { console.warn('delorun sidebar: the workspace icon was not saved', error) })
    },
    attach: latest => ctx.provide('delorunSidebar', {
      canAddWorkspace: () => latest.current.canAddWorkspace,
      addWorkspace: () => { latest.current.addWorkspace() },
    }),
    pruneIcons: (liveIds) => {
      const pruned = pruneWorkspaceIcons(settings.getSnapshot().workspaceIcons, liveIds)
      if (pruned === undefined) return
      form.set('workspaceIcons', pruned).then((ok) => {
        if (!ok) console.warn('delorun sidebar: the icons of removed workspaces were not dropped')
      }, (error: unknown) => { console.warn('delorun sidebar: the icons of removed workspaces were not dropped', error) })
    },
    preference,
    undoLine,
    updateNotice,
  }
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.list', () => ctx.slots.register({
    name: 'sidebar.workspaces.list', locale: NS, inject: () => list,
  }, Sidebar)), 'delorun-sidebar: chat list')

  const notice: UndoNoticeInjected = { undoLine }
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: UNDO_NOTICE.id, order: UNDO_NOTICE.order, locale: NS, inject: () => notice,
  }, UndoNotice)), 'delorun-sidebar: undo notice')
  ctx.effect(() => ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: NS, priority: LAUNCHER_PRIORITY,
  }, FootLauncher)), 'delorun-sidebar: Settings button')
  // The sidebar opens at the chosen width; a drag still narrows it to 264px, or to the width when that is narrower.
  ctx.inject(['layout'], (child) => {
    child.effect(() => {
      let width: number | undefined
      let restore: (() => void) | undefined
      const sync = (): void => {
        const next = settings.getSnapshot().width
        if (next === width) return
        width = next
        restore = child.layout.setSidebarWidths({ default: next, min: Math.min(next, STOCK_MIN_WIDTH) })
      }
      sync()
      const unsubscribe = settings.subscribe(sync)
      return () => {
        unsubscribe()
        restore?.()
      }
    }, 'delorun-sidebar: width')
  })
  // The list's header offers New chat, so the wide sidebar drops upstream's button; the foot is T3 Code's one row, which
  // also holds the global panels (Plugins, Automation tasks, More) as icon buttons, so the brand sits directly above the list.
  ctx.inject(['sidebarLayout'], (child) => {
    child.effect(() => child.sidebarLayout.setNewSessionButton(false), 'delorun-sidebar: New chat in the list header')
    child.effect(() => child.sidebarLayout.setFootRow(true), 'delorun-sidebar: the foot in one row')
    child.effect(() => child.sidebarLayout.setPanelPlacement('footer'), 'delorun-sidebar: the panels in the foot row')
    // The hover peek follows the Collapsed sidebar settings, live.
    child.effect(() => {
      let peek: { enabled: boolean, delayMs: number } | undefined
      let restore: (() => void) | undefined
      const sync = (): void => {
        const { peekOnHover, peekDelayMs } = settings.getSnapshot()
        if (peek?.enabled === peekOnHover && peek.delayMs === peekDelayMs) return
        peek = { enabled: peekOnHover, delayMs: peekDelayMs }
        const previous = restore
        restore = child.sidebarLayout.setHoverPeek(peek)
        previous?.()
      }
      sync()
      const unsubscribe = settings.subscribe(sync)
      return () => {
        unsubscribe()
        restore?.()
      }
    }, 'delorun-sidebar: hover peek')
  })
}
