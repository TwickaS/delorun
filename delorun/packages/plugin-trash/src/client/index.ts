/**
 * The trash plugin's studio half: a "Move to trash" action in each chat's and each workspace's menu, the chats in the
 * trash left out of the sidebar, a new chat in the main pane when the chat it showed moved, and the Trash section in
 * Settings, which restores an item or deletes it forever.
 * @module @delorun/plugin-trash/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'shell.overlay' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.contextMenus Context merge and the 'contextMenu.icon' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: the 'settings.section' and 'settings.section.icon' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.uiWorkspace Context merge and the 'workspace' context-menu target.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { IconTrashOutlineMedium, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { localDrafts, TrashController } from './controller.ts'
import { TrashLeave } from './leave.ts'
import { en, zh, type TrashLocaleKey } from './locales.ts'
import { createTrashToastSource, TrashToast } from './TrashToast.tsx'
import { TrashSection, type TrashSectionInjected } from './TrashSection.tsx'

export type { TrashLocaleKey } from './locales.ts'
export type { TrashState } from './controller.ts'
export type { TrashSectionInjected, TrashSectionProps } from './TrashSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The trash menu actions', Settings section's and toasts' copy. */
    'delorunTrash': TrashLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunTrash'

/** The `settings.section` id of the Trash section. */
export const TRASH_SECTION_ID = 'delorun-trash'

/** The section's place in Settings navigation: after the Privacy section (20). */
export const TRASH_SECTION_ORDER = 21

/** The chat menu action's place: after upstream's Archive (600). */
export const SESSION_MENU_ORDER = 650

/** The workspace menu action's place: after upstream's Delete (300). */
export const WORKSPACE_MENU_ORDER = 310

/** The `contextMenu.icon` key of the actions' trash glyph. */
export const TRASH_ICON_KEY = 'delorun-trash.trash'

/** Required services. */
export const inject = ['slots', 'locale', 'contextMenus', 'uiWorkspace', 'sessions', 'workspaces']

/**
 * Register the dictionaries, the two menu actions, the outcome toast and the Trash section, keep the chats in the
 * trash out of the sidebar, and move the main pane on when the chat it shows moves to the trash.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-trash: dictionaries')
  const t = ctx.locale.bind(NS)
  const toast = createTrashToastSource()
  const trash = new TrashController({
    hide: sessionId => ctx.uiWorkspace.hideSession(SessionId(sessionId)),
    drafts: localDrafts,
    report: toast.report,
  })
  ctx.effect(() => {
    void trash.refresh()
    return () => { trash.dispose() }
  }, 'delorun-trash: the chats in the trash leave the sidebar')
  const leave = new TrashLeave({
    openChat: () => {
      const list = ctx.sessions.list.getSnapshot()
      return list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0)
    },
    workspaceOf: sessionId => ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))?.workspaceId,
    listed: workspaceId => ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId === workspaceId),
    startChat: (workspaceId) => { ctx.uiWorkspace.startSession(workspaceId) },
    subscribe: (listener) => {
      const offs = [ctx.sessions.list.subscribe(listener), ctx.workspaces.list.subscribe(listener)]
      return () => { for (const off of offs) off() }
    },
    document,
  })
  ctx.effect(() => () => { leave.dispose() }, 'delorun-trash: the main pane after a move')
  ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: TRASH_ICON_KEY }, IconTrashOutlineRegular))
  ctx.effect(() => ctx.contextMenus.register({
    id: 'delorun-trash.session', target: 'session', order: SESSION_MENU_ORDER, observe: () => [ctx.locale],
    resolve: ({ sessionId, displayTitle }) => [{
      id: 'trash', label: t('menu.trash'), icon: { key: TRASH_ICON_KEY }, danger: true, separatorBefore: true,
      run: async () => {
        const moveOn = leave.chat(sessionId)
        if (await trash.trashChat(sessionId, displayTitle)) moveOn?.()
      },
    }],
  }), 'delorun-trash: the chat menu action')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'delorun-trash.workspace', target: 'workspace', order: WORKSPACE_MENU_ORDER, observe: () => [ctx.locale],
    resolve: ({ workspaceId }) => [{
      id: 'trash', label: t('menu.trash'), icon: { key: TRASH_ICON_KEY }, danger: true, separatorBefore: true,
      run: async () => {
        const moveOn = leave.workspace(workspaceId)
        if (await trash.trashWorkspace(workspaceId)) moveOn?.()
      },
    }],
  }), 'delorun-trash: the workspace menu action')
  // Frame-wide, so an outcome outlives the menu or the Settings row that raised it.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delorun-trash.toast', locale: NS,
    inject: () => ({ hooks: toast.hooks, dismiss: toast.dismiss }),
  }, TrashToast))
  const section: TrashSectionInjected = {
    hooks: { trash: trash.state },
    reload: () => trash.refresh(),
    retry: () => trash.retry(),
    restore: itemId => trash.restore(itemId),
    purge: (itemId, clearLogs) => trash.purge(itemId, clearLogs),
    empty: clearLogs => trash.empty(clearLogs),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: TRASH_SECTION_ID, order: TRASH_SECTION_ORDER, label: () => t('nav'), locale: NS,
    inject: () => section,
  }, TrashSection))
  // The navigation glyph for the section's row; without it Settings draws the generic gear for this id.
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: TRASH_SECTION_ID }, IconTrashOutlineMedium))
}
