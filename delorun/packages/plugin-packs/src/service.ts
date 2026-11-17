/**
 * The `packs` Host remote: typed actions the downloads panel, Plugins and onboarding call. Progress reuses the plugin
 * manager's `plugin-manager/install-state` event: after each change of the install list the service announces every
 * item in the list under its request id `pack:<name>`, and a surface calls `packs/list` to read the numbers. A phone takes `packs/list` freely; the other actions
 * are elevated actions of contract C14, so a paired phone takes them only while it holds an unlock (A408).
 *
 * @module @delorun/plugin-packs/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager/types'
import type { PacksHub } from './hub.ts'
import type { PacksNamesRequest, PacksResult, PacksSnapshot } from './wire.ts';
import { packRequestId, type PacksNameRequest } from './wire.ts'

/** What the remote needs of the hub. */
export type PacksOperations = Pick<PacksHub, 'subscribe' | 'snapshot' | 'enqueue' | 'cancel' | 'remove' | 'dismiss' | 'retry'>

/** The remote. */
export class PacksService extends TypertRemoteService {
  private readonly hub: PacksOperations

  /**
   * @param ctx - the Host context.
   * @param hub - the pack hub.
   */
  constructor(ctx: Context, hub: PacksOperations) {
    super(ctx, 'packs')
    this.hub = hub
    ctx.effect(() => hub.subscribe((snapshot) => {
      for (const item of snapshot.queue) ctx.emit('plugin-manager/install-state', { requestId: packRequestId(item.key) as PluginInstallRequestId, phase: item.state === 'ready' || item.state === 'needs-reload' ? 'applying' : 'installing' })
    }))
  }

  /**
   * The packs the installed release publishes and the install list.
   * @returns the snapshot.
   */
  @Remote('list')
  list(): Promise<PacksSnapshot> {
    return this.hub.snapshot()
  }

  /**
   * Add packs to the install list; a pack already queued or working stays as it is.
   * @param request - the package names.
   * @returns the new snapshot, or why nothing was added.
   */
  @Remote('enqueue')
  enqueue(request: PacksNamesRequest): Promise<PacksResult> {
    return this.hub.enqueue(request.names)
  }

  /**
   * Cancel a queued or working install.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  @Remote('cancel')
  cancel(request: PacksNameRequest): Promise<PacksResult> {
    return this.hub.cancel(request.name)
  }

  /**
   * Remove a finished, failed or cancelled item from the list.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  @Remote('remove')
  remove(request: PacksNameRequest): Promise<PacksResult> {
    return this.hub.remove(request.name)
  }

  /**
   * Clear a failed or cancelled item from the list; a phone may do this without an unlock because it only clears a record (A408).
   * @param request - the package name.
   * @returns the new snapshot.
   */
  @Remote('dismiss')
  dismiss(request: PacksNameRequest): Promise<PacksResult> {
    return this.hub.dismiss(request.name)
  }

  /**
   * Start a failed or cancelled install again.
   * @param request - the package name.
   * @returns the new snapshot, or why nothing happened.
   */
  @Remote('retry')
  retry(request: PacksNameRequest): Promise<PacksResult> {
    return this.hub.retry(request.name)
  }
}
