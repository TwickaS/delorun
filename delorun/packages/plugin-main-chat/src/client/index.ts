/**
 * The main chat plugin's studio half: the Main chat row at the top of the
 * sidebar's panel list, whose panel has the harness create the main chat,
 * {@link MAIN_CHAT_SESSION_ID}, when it is missing and then shows it, and the
 * composer for its first message.
 * @module @delorun/plugin-main-chat/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.sessions Context merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'main' SlotMap entry.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the 'sidebar.panellist' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSelect, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.uiWorkspace Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAIN_CHAT_PATHS, MAIN_CHAT_SESSION_ID, type MainChatReportCount } from '../wire.ts'
import { en, zh, type MainChatLocaleKey } from './locales.ts'
import { MainChatOpening, type MainChatOpeningInjected } from './MainChatOpening.tsx'
import { MainChatIcon, type MainChatIconInjected } from './MainChatEntry.tsx'
import { MainChatStart, type MainChatStartInjected } from './MainChatStart.tsx'

export type { MainChatLocaleKey } from './locales.ts'
export type { MainChatOpeningInjected, MainChatOpeningProps } from './MainChatOpening.tsx'
export type { MainChatStartInjected, MainChatStartProps } from './MainChatStart.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Main chat row's, panel's and first-message composer's copy. */
    'delorunMainChat': MainChatLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunMainChat'

/** The id of the row in the sidebar's panel list and of the panel it selects. */
export const PANEL_ID = 'delorun-main-chat'

/** How long the panel waits for the page's chat list to hold a main chat the harness has, before it says the main chat did not open. */
export const LIST_WAIT_MS = 30_000

/** The row's place in the panel list: first, above upstream's Plugins (0) and Automation tasks (10). */
export const PANEL_ORDER = -10

/** Required services. */
export const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

const MAIN = brandString<SessionId>(MAIN_CHAT_SESSION_ID)

/**
 * Match the main chat before anything was asked of it: a blank session with
 * no prompt waiting for its first turn, none running and none sent from this
 * page. Every other session, and the main chat afterwards, keeps upstream's
 * composer.
 * @param owner - the shown session and its state.
 * @returns a match for the blank main chat, otherwise null.
 */
export const selectBlankMainChat: ChainSelect<ComposerChainProps, { readonly blank: true }> = (owner) => {
  const { sessionId, session } = owner
  return sessionId === MAIN && session !== undefined && session.blank && !session.awaitingFirstTurn && !session.running && !session.promptAttempted
    ? { blank: true }
    : null
}

// How long the mark waits before asking again after the harness could not answer, such as while it restarts.
const RETRY_MS = 5_000

/**
 * Whether reports wait in the main chat's inbox, which it reads at its next step, for the row's unread mark. The
 * harness counts them ({@link MAIN_CHAT_PATHS}.reports), and the mark keeps one request open that the harness answers
 * when the count changes, so a report shows at once and the mark clears once the main chat has read it.
 * @param ctx - the browser plugin context.
 * @returns the unread mark.
 */
function unreadReports(ctx: Context): HostObservable<boolean> {
  const listeners = new Set<() => void>()
  let unread = false
  ctx.effect(() => {
    const stop = new AbortController()
    void (async () => {
      let version: number | undefined
      while (!stop.signal.aborted) {
        try {
          const query = version === undefined ? '' : `?after=${String(version)}`
          const response = await fetch(`${MAIN_CHAT_PATHS.reports.slice(1)}${query}`, { cache: 'no-store', signal: stop.signal })
          if (!response.ok) throw new Error(`delorun-main-chat: ${MAIN_CHAT_PATHS.reports} answered ${String(response.status)}`)
          const count = (await response.json()) as MainChatReportCount
          // A version below the last one is a harness that started again; the next request waits from its own.
          version = count.version
          const next = count.waiting > 0
          if (next !== unread) {
            unread = next
            for (const listener of listeners) listener()
          }
        } catch (error) {
          if (stop.signal.aborted) return
          console.warn('delorun-main-chat: the main chat\'s reports were not counted:', error)
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, RETRY_MS)
            stop.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              resolve()
            }, { once: true })
          })
        }
      }
    })()
    return () => { stop.abort() }
  }, 'delorun-main-chat: the unread mark')
  return {
    getSnapshot: () => unread,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Register the dictionaries, the Main chat row, which leads the sidebar and selects the panel that opens the main
 * chat, and the first-message composer, and leave the main chat out of the sidebar's chat list, so the row is its one
 * way in.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-main-chat: dictionaries')
  ctx.effect(() => ctx.uiWorkspace.hideSession(MAIN), 'delorun-main-chat: the sidebar\'s chat list leaves the main chat out')
  const t = ctx.locale.bind(NS)
  const unread = unreadReports(ctx)
  const post = async (path: string): Promise<void> => {
    const response = await fetch(path.slice(1), { method: 'POST' })
    // The harness logged why; the panel says so and offers a retry.
    if (response.status !== 204) throw new Error(`delorun-main-chat: ${path} answered ${String(response.status)}`)
  }
  // Whether the main chat is the Session on screen, which keeps the row current after its panel hands the view over.
  const onScreen: HostObservable<boolean> = {
    getSnapshot: () => (ctx.sessions.list.getSnapshot().byId[MAIN]?.retainedBy.mainView ?? 0) > 0,
    subscribe: listener => ctx.sessions.list.subscribe(listener),
  }
  // The page can show the main chat only once its loaded chat list holds it, which can trail the open route as the studio
  // starts; the first connection's reset can also empty a list read before it.
  const listed = (): Promise<void> => new Promise((resolve, reject) => {
    const holds = (): boolean => {
      const list = ctx.sessions.list.getSnapshot()
      return list.phase === 'ready' && list.byId[MAIN] !== undefined
    }
    if (holds()) return resolve()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`delorun-main-chat: the chat list did not list the main chat within ${String(LIST_WAIT_MS)} ms`))
    }, LIST_WAIT_MS)
    const stop = ctx.sessions.list.subscribe(() => {
      if (!holds()) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
  const opening: MainChatOpeningInjected = {
    open: async () => {
      await post(MAIN_CHAT_PATHS.open)
      await listed()
      ctx.uiWorkspace.openSession(MAIN)
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => opening }, MainChatOpening))
  // The row leads the sidebar, above New chat, and stays current while the main chat is on screen.
  ctx.inject(['sidebarLayout'], (child) => {
    child.effect(() => child.sidebarLayout.setLeadPanel(brandString<MainPanelId>(PANEL_ID), onScreen), 'delorun-main-chat: the Main chat row leads the sidebar')
  })
  const icon: MainChatIconInjected = { hooks: { unread } }
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, locale: NS, label: () => t('row'), inject: () => icon,
  }, MainChatIcon))
  const start: MainChatStartInjected = {
    send: async (text) => {
      const binding = ctx.sessions.binding(MAIN)
      if (binding === undefined) throw new Error('delorun-main-chat: the main chat has no session binding on this page')
      const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
      if (!result.ok) throw new Error(`delorun-main-chat: the first message was refused: ${result.error.code}`)
    },
  }
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', select: selectBlankMainChat, locale: NS, inject: () => start,
  }, MainChatStart))
}
