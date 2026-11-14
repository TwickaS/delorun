/**
 * Browser half of the Thinking tab: the right Sidebar's reader of the latest turn's reasoning and reply, one feed per
 * Session, released with its Session. It applies only while the Delorun look provides `delorunStudio`, as every row of
 * `@delorun/bundle-studio` does.
 * @module @delorun/plugin-thinking-rsvp/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'sidebar.right.pane.tab' SlotMap entry and the tab registry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ReadingFeed } from './feed.ts'
import { en, NS, zh } from './locales.ts'
import { createReaderStore } from './store.ts'
import { ThinkingArtwork } from './ThinkingArtwork.tsx'
import { ThinkingPane } from './ThinkingPane.tsx'
import type { ThinkingPaneInjected } from './types.ts'

/** The tab type's id, which is also this package's browser module id. */
export const TAB_ID = '@delorun/plugin-thinking-rsvp'

/** The tab type the right Sidebar opens this pane for. */
export const TAB_KIND = 'thinking-rsvp'

/** Services every registration needs; `delorunStudio` is injected inside {@link apply}, so the stock look registers nothing. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRightTabs']

/**
 * While the Delorun look provides `delorunStudio`, register the tab.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['delorunStudio'], applyStudio)
}

/**
 * Register the tab's dictionaries, its preference store, its type and its body; disposed with the `delorunStudio` service
 * or the plugin.
 * @param ctx - the browser plugin context, holding `delorunStudio`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'thinking-rsvp: dictionaries')
  const t = ctx.locale.bind(NS)
  const settings = createReaderStore()

  // Each feed lives until its Session's binding goes or this plugin unloads, whichever comes first.
  const feeds = new Map<SessionBinding, { readonly feed: ReadingFeed; readonly release: () => void }>()
  const feedOf = (binding: SessionBinding): ReadingFeed => {
    const held = feeds.get(binding)
    if (held !== undefined) return held.feed
    const feed = new ReadingFeed(binding.eventSource)
    const release = binding.ctx.effect(() => () => {
      feeds.delete(binding)
      feed.dispose()
    }, 'thinking-rsvp: reading feed')
    feeds.set(binding, { feed, release })
    return feed
  }
  ctx.effect(() => () => {
    for (const { release } of [...feeds.values()]) release()
  }, 'thinking-rsvp: reading feeds')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    // Leaving the tab for Files and coming back keeps the reader's place in the turn.
    keepMounted: true,
    title: () => t('tab.title'),
    guide: [{ id: 'open', order: 70, title: () => t('tab.title'), description: () => t('tab.description'), icon: ThinkingArtwork }],
  }), 'thinking-rsvp: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, store: settings,
    inject: (sessionId: string): ThinkingPaneInjected => {
      const binding = ctx.sessions.binding(SessionId(sessionId))
      if (binding === undefined) throw new Error(`thinking-rsvp: unknown Session "${sessionId}"`)
      return { hooks: { reading: feedOf(binding) } }
    },
  }, ThinkingPane)), 'thinking-rsvp: tab body')
}
