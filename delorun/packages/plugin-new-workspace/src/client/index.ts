/**
 * The studio half of `@delorun/plugin-new-workspace`: one guided dialog to start a workspace from a new folder, a folder on
 * this computer or a Git clone. It loads only while the Delorun look is on (the `delorunStudio` service exists), so the
 * stock look keeps upstream's flow. `ctx.delorunNewWorkspace` opens the dialog for the sidebar, the new-chat picker, the
 * hero and onboarding.
 * @module @delorun/plugin-new-workspace/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'shell.overlay' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the `remote/call-denied` event.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { createApi } from './api.ts'
import { en, NS, zh, type NewWorkspaceLocaleKey } from './locales.ts'
import { Overlay, type OpenFlow, type OverlayInjected } from './Overlay.tsx'
import type { FolderBrowse } from './screens/FolderScreen.tsx'

export { createApi, type ApiFailure, type ApiOptions, type ApiResult, type NewWorkspaceApi } from './api.ts'
export { en, NS, zh, type NewWorkspaceLocaleKey } from './locales.ts'

/** Which surface opens the flow. */
export type NewWorkspaceSource = 'sidebar' | 'picker' | 'hero' | 'onboarding'

/** What the flow came to. */
export type NewWorkspaceOutcome =
  | { readonly kind: 'created', readonly workspaceId: string, readonly path: string }
  | { readonly kind: 'cancelled' }

/** The new-workspace flow, for the plugins that offer it. */
export interface DelorunNewWorkspace {
  /**
   * Open the flow. A second call while one is open ends the first as cancelled and starts a fresh dialog. Closing the
   * dialog (Escape, the close button or Cancel) resolves `cancelled`; a clone that is already running keeps running on the
   * Host and is not cancelled by closing.
   * @param request - which surface opens it; the sidebar when absent.
   * @returns how the flow ended: the workspace it made, or cancelled.
   */
  open(request?: { readonly from: NewWorkspaceSource }): Promise<NewWorkspaceOutcome>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's new-workspace flow. */
    delorunNewWorkspace: DelorunNewWorkspace
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The new-workspace flow's copy. */
    'delorunNewWorkspace': NewWorkspaceLocaleKey
  }
}

/** The `shell.overlay` id of the dialog. */
export const OVERLAY_ID = 'delorun-new-workspace'

/** Required services. */
export const inject = ['slots', 'locale']

/** The flow on show and the call that settles its promise. */
interface Opened extends OpenFlow {
  readonly resolve: (outcome: NewWorkspaceOutcome) => void
}

/**
 * Register the copy, the dialog and the service while the Delorun look provides `delorunStudio`.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  // The spacing tokens exist only while the Delorun look is on, as with every row of the studio bundle.
  ctx.inject(['delorunStudio'], (inner) => { applyStudio(inner) })
}

/**
 * Everything the plugin registers while the Delorun look provides `delorunStudio`.
 * @param ctx - the browser plugin context, holding `delorunStudio`.
 */
function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-new-workspace: dictionaries')
  const store = createSnapshotStore<Opened | null>(null)
  let counter = 0
  const settle = (outcome: NewWorkspaceOutcome, id?: number): void => {
    const current = store.getSnapshot()
    if (current === null || (id !== undefined && current.id !== id)) return
    store.set(null)
    current.resolve(outcome)
  }
  const service: DelorunNewWorkspace = {
    open: request => new Promise<NewWorkspaceOutcome>((resolve) => {
      settle({ kind: 'cancelled' })
      counter += 1
      store.set({ id: counter, from: request?.from ?? 'sidebar', resolve })
    }),
  }
  ctx.effect(() => ctx.provide('delorunNewWorkspace', service), 'delorun-new-workspace: service')
  ctx.effect(() => () => { settle({ kind: 'cancelled' }) }, 'delorun-new-workspace: an open flow ends when the plugin does')
  const uiWorkspace = (): Context['uiWorkspace'] => {
    const workspace = ctx.get('uiWorkspace')
    if (workspace === undefined) throw new Error('delorun new workspace: the studio has no workspace navigation')
    return workspace
  }
  const browse: FolderBrowse = {
    list: async (path, signal) => uiWorkspace().listDirectory(path, signal),
    create: async (parent, name) => uiWorkspace().createDirectory(parent, name),
  }
  // A refusal until the device is unlocked opens the studio's unlock dialog the way a refused Remote call does.
  const api = createApi({
    unlockNeeded: (route) => {
      const endpoint = `delorunNewWorkspace/${route}`
      ctx.emit('remote/call-denied', { endpoint, reason: `elevation-required: ${endpoint}` })
    },
  })
  const injected: OverlayInjected = {
    hooks: { open: store },
    api,
    browse,
    close: (id) => { settle({ kind: 'cancelled' }, id) },
    created: (id, created) => { settle({ kind: 'created', ...created }, id) },
  }
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: OVERLAY_ID, locale: NS, inject: () => injected,
  }, Overlay)), 'delorun-new-workspace: the dialog')
}
