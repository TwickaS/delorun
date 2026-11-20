/**
 * The studio half of `@delorun/plugin-update`: Settings → Updates (the release that runs, Check now, Update now…, and
 * the rollback panel), the report dialog, and the frame-wide progress and outcome cards, all reading and acting through
 * the Host's update routes. The sidebar's "Update now…" button opens the same dialog through the
 * `delorun-update/open` event. The page reloads itself once when the Host answers as another release than the one this
 * page loaded.
 * @module @delorun/plugin-update/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'shell.overlay' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the 'settings.section' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'remote/call-denied' event, which opens the studio's unlock dialog.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: the 'conversation.composer.dock' SlotMap entry and the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UpdateController } from './controller.ts'
import { en, zh, type UpdateLocaleKey } from './locales.ts'
import { UpdateOverlay, type UpdateOverlayInjected } from './UpdateOverlay.tsx'
import { StoppedChatDock, type StoppedChatInjected } from './UpdateAlerts.tsx'
import { UpdatePanel, type UpdatePanelInjected, type UpdateSettings } from './UpdatePanel.tsx'

export type { UpdateLocaleKey } from './locales.ts'
export type { Outcome, UpdateLoad, UpdateRefusal } from './controller.ts'
export type { UpdateOverlayInjected, UpdateOverlayProps } from './UpdateOverlay.tsx'
export type { UpdatePanelInjected, UpdatePanelProps } from './UpdatePanel.tsx'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Open the update report dialog. Emitted by the sidebar's "Update now…" button.
     * @mode parallel
     */
    'delorun-update/open'(): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** What the update screens tell other plugins; the sidebar's notice follows `canUpdate`. */
    delorunUpdate: DelorunUpdate
  }
}

/** What `ctx.delorunUpdate` shares. */
export interface DelorunUpdate {
  /** Whether the Host's state says this page may begin an update (`may['update-begin']`); false until the first read. */
  readonly canUpdate: HostObservable<boolean>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The update screens' copy. */
    'delorunUpdate': UpdateLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunUpdate'

/** The `settings.section` id of the Updates section. */
export const UPDATE_SECTION_ID = 'delorun-update'

/** The section's place in Settings navigation: right before the Changes section (22). */
export const UPDATE_SECTION_ORDER = 21.5

/** The `settings.section` id of the Changes section, where changes to Delorun itself wait for review. */
const CHANGES_SECTION_ID = 'delorun-changes'

/** The Loader row id of the host half, which names the settings namespace the Updates section edits. */
export const UPDATE_ROW_ID = 'delorun-plugin-update'

/** Required services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the dictionaries, the Updates section and the frame-wide cards, and read the update state until the page closes.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-update: dictionaries')
  const t = ctx.locale.bind(NS)
  const dialog = createSnapshotStore(false)
  const controller = new UpdateController({
    unlockNeeded: (control) => {
      const endpoint = `delorunUpdate/${control}`
      ctx.emit('remote/call-denied', { endpoint, reason: `elevation-required: ${endpoint}` })
    },
    reload: () => { location.reload() },
    faceGrant: () => ctx.get('delorunFaceGrant')?.grant,
  })
  ctx.effect(() => controller.poll(), 'delorun-update: the update state the screens show')
  const mayBegin = (): boolean => {
    const load = controller.state.getSnapshot()
    return load.status === 'ready' && load.state.access.may['update-begin'].ok
  }
  const canUpdate = createSnapshotStore(mayBegin())
  ctx.effect(() => controller.state.subscribe(() => { canUpdate.set(mayBegin()) }), 'delorun-update: whether this page may update')
  ctx.provide('delorunUpdate', { canUpdate })
  ctx.effect(() => ctx.on('delorun-update/open', () => { dialog.set(true) }), 'delorun-update: the sidebar opens the dialog')
  const panel: UpdatePanelInjected = {
    hooks: { load: controller.state },
    reload: () => controller.refresh(),
    check: () => controller.check(),
    openDialog: () => { dialog.set(true) },
    rollback: body => controller.rollback(body),
    settings: ctx.configForms.get<UpdateSettings>(UPDATE_ROW_ID),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: UPDATE_SECTION_ID, order: UPDATE_SECTION_ORDER, label: () => t('nav'), locale: NS,
    inject: () => panel,
  }, UpdatePanel))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'delorun-update.stopped', order: 50, locale: NS,
    inject: (sessionId): StoppedChatInjected => ({ hooks: { load: controller.state }, sessionId, continueChat: id => controller.continueChat(id) }),
  }, StoppedChatDock))
  const overlay: UpdateOverlayInjected = {
    hooks: { load: controller.state, switching: controller.switching, dialog },
    actions: { prepare: () => controller.prepare(), apply: body => controller.apply(body) },
    cancel: () => controller.cancel(),
    dismiss: () => controller.dismiss(),
    closeDialog: () => { dialog.set(false) },
    openChanges: () => { ctx.get('settingsShell')?.openSection(CHANGES_SECTION_ID) },
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delorun-update.cards', locale: NS, inject: () => overlay,
  }, UpdateOverlay))
}
