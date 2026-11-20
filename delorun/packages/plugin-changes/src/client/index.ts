/**
 * The studio half of `@delorun/plugin-changes`: the Changes section in Settings, which reviews, applies, discards and
 * undoes changes to plugins and to Delorun itself, applies the agent's plugin requests, turns protection on and off, and
 * opens and ends a work session through the Host's Changes routes; the work-session badge at the sidebar's foot; and the
 * outcome toast. On a paired device each control follows the state's `access`: one that stays at the
 * computer is disabled, and one that needs an unlock opens the studio's unlock dialog when the route asks for it.
 * @module @delorun/plugin-changes/client
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
// Type-only: the 'remote/call-denied' event, which opens the studio's unlock dialog.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { ChangesController } from './controller.ts'
import { createChangesToastSource, ChangesToast } from './ChangesToast.tsx'
import { CreateSection, type CreateSectionInjected } from './CreateSection.tsx'
import { ChangesSection, type ChangesSectionInjected } from './ChangesSection.tsx'
import { en, zh, type ChangesLocaleKey } from './locales.ts'
import { WorkBadge, type WorkBadgeInjected } from './WorkBadge.tsx'

export type { ChangesLocaleKey } from './locales.ts'
export type { ActionOutcome, ChangesLoad, ChangesNotice, CopyOutcome, HarnessEffects } from './controller.ts'
export type { ChangesSectionInjected, ChangesSectionProps } from './ChangesSection.tsx'
export type { CreateSectionInjected, CreateSectionProps } from './CreateSection.tsx'
export type { WorkBadgeInjected, WorkBadgeProps } from './WorkBadge.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Changes section's, its dialogs', its toasts' and the work-session badge's copy. */
    'delorunChanges': ChangesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunChanges'

/** The `settings.section` id of the Changes section. */
export const CHANGES_SECTION_ID = 'delorun-changes'

/** The section's place in Settings navigation: after the Trash section (21). */
export const CHANGES_SECTION_ORDER = 22

/** The `settings.section` id of the Create a plugin section. */
export const CREATE_SECTION_ID = 'delorun-create-plugin'

/** Create a plugin's place in Settings navigation: right after the Changes section. */
export const CREATE_SECTION_ORDER = 23

/** The `sidebar.footer.action` id of the work-session badge. */
export const WORK_BADGE_ID = 'delorun-changes.work-badge'

/** The badge's place among the sidebar foot's actions: after Delorun's undo notice (-2), before the actions at 0 and later. */
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
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-changes: dictionaries')
  const t = ctx.locale.bind(NS)
  const toast = createChangesToastSource()
  const changes = new ChangesController({
    report: toast.report,
    // Read at the call, so the Face ID service may load after this plugin.
    faceGrant: () => ctx.get('delorunFaceGrant')?.grant,
  })
  ctx.effect(() => {
    void changes.refresh()
    const stop = changes.poll(STATE_REFRESH_MS)
    return () => {
      stop()
      changes.dispose()
    }
  }, 'delorun-changes: the state the section and the badge show')
  // Frame-wide, so an outcome outlives the Settings dialog that raised it.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delorun-changes.toast', locale: NS,
    inject: () => ({ hooks: toast.hooks, dismiss: toast.dismiss }),
  }, ChangesToast))
  const section: ChangesSectionInjected = {
    hooks: { changes: changes.state, harnessEffects: changes.harnessEffects, restarting: changes.restarting },
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
    harnessApply: (id, to, confirmedRisk) => changes.harnessApply(id, to, confirmedRisk),
    harnessUndo: id => changes.harnessUndo(id),
    harnessDiscard: id => changes.harnessDiscard(id),
    makeCopy: () => changes.makeCopy(),
    startSafeMode: () => changes.startSafeMode(),
    exitSafeMode: () => changes.exitSafeMode(),
    protectionOn: () => changes.protectionOn(),
    protectionOff: confirmed => changes.protectionOff(confirmed),
    noticeSeen: id => changes.noticeSeen(id),
    restart: stopChats => changes.restart(stopChats),
    cancelRestart: () => changes.cancelRestart(),
    reloadPage: () => { location.reload() },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: CHANGES_SECTION_ID, order: CHANGES_SECTION_ORDER, label: () => t('nav'), locale: NS,
    inject: () => section,
  }, ChangesSection))
  const create: CreateSectionInjected = {
    workspaces: () => changes.workspaces(),
    create: (name, kind, workspace) => changes.createPlugin(name, kind, workspace),
    request: (name, workspace) => changes.requestPlugin(name, workspace),
    reveal: (name, workspace) => changes.revealPlugin(name, workspace),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: CREATE_SECTION_ID, order: CREATE_SECTION_ORDER, label: () => t('create.nav'), locale: NS,
    inject: () => create,
  }, CreateSection))
  const badge: WorkBadgeInjected = { hooks: { changes: changes.state } }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: WORK_BADGE_ID, order: WORK_BADGE_ORDER, locale: NS, inject: () => badge,
  }, WorkBadge))
}
