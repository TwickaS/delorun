/**
 * The studio half of `@delo/plugin-changes`: the Changes section in Settings, which reviews, applies, discards and
 * undoes changes, applies the agent's plugin requests, states the protection setting, and opens and ends a work session
 * through the Host's Changes routes; the work-session badge at the
 * sidebar's foot; and the outcome toast. A page that is not at the computer reads everything and acts on nothing.
 * @module @delo/plugin-changes/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'shell.overlay' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the 'settings.section' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ChangesController } from './controller.ts'
import { createChangesToastSource, ChangesToast } from './ChangesToast.tsx'
import { ChangesSection, type ChangesSectionInjected } from './ChangesSection.tsx'
import { en, zh, type ChangesLocaleKey } from './locales.ts'
import { WorkBadge, type WorkBadgeInjected } from './WorkBadge.tsx'

export type { ChangesLocaleKey } from './locales.ts'
export type { ActionOutcome, ChangesLoad, ChangesNotice } from './controller.ts'
export type { ChangesSectionInjected, ChangesSectionProps } from './ChangesSection.tsx'
export type { WorkBadgeInjected, WorkBadgeProps } from './WorkBadge.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Changes section's, its dialogs', its toasts' and the work-session badge's copy. */
    'deloChanges': ChangesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloChanges'

/** The `settings.section` id of the Changes section. */
export const CHANGES_SECTION_ID = 'delo-changes'

/** The section's place in Settings navigation: after the Trash section (21). */
export const CHANGES_SECTION_ORDER = 22

/** The `sidebar.footer.action` id of the work-session badge. */
export const WORK_BADGE_ID = 'delo-changes.work-badge'

/** The badge's place among the sidebar foot's actions: after Delo's undo notice (-2), before the actions at 0 and later. */
export const WORK_BADGE_ORDER = -1

/**
 * How often the page reads the Changes state while it is visible, in milliseconds, so the badge follows a work session
 * opened or ended at a terminal or by its time limit. The studio's own actions read it at once.
 */
export const STATE_REFRESH_MS = 15_000

/** Required services. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries, the outcome toast, the Changes section and the work-session badge, and read the Changes
 * state now and every {@link STATE_REFRESH_MS} while the page is visible.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-changes: dictionaries')
  const t = ctx.locale.bind(NS)
  const toast = createChangesToastSource()
  const changes = new ChangesController({ report: toast.report })
  ctx.effect(() => {
    void changes.refresh()
    return changes.poll(STATE_REFRESH_MS)
  }, 'delo-changes: the state the section and the badge show')
  // Frame-wide, so an outcome outlives the Settings dialog that raised it.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delo-changes.toast', locale: NS,
    inject: () => ({ hooks: toast.hooks, dismiss: toast.dismiss }),
  }, ChangesToast))
  const section: ChangesSectionInjected = {
    hooks: { changes: changes.state, refusedRemote: changes.refusedRemote },
    reload: () => changes.refresh(),
    retry: () => changes.retry(),
    show: id => changes.show(id),
    listPending: () => changes.listPending(),
    reviewWork: plugin => changes.reviewWork(plugin),
    apply: (id, confirmedRisk) => changes.apply(id, confirmedRisk),
    applyRequest: (id, confirmedRisk) => changes.applyRequest(id, confirmedRisk),
    discard: id => changes.discard(id),
    undo: id => changes.undo(id),
    beginWork: plugin => changes.beginWork(plugin),
    done: (plugin, version, confirmedRisk) => changes.done(plugin, version, confirmedRisk),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: CHANGES_SECTION_ID, order: CHANGES_SECTION_ORDER, label: () => t('nav'), locale: NS,
    inject: () => section,
  }, ChangesSection))
  const badge: WorkBadgeInjected = { hooks: { changes: changes.state } }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: WORK_BADGE_ID, order: WORK_BADGE_ORDER, locale: NS, inject: () => badge,
  }, WorkBadge))
}
