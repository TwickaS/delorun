/**
 * The home process's way to `@delo/home-auth` in the Host it runs: the local device approval that the update channel's
 * `devices.approve` drives (contracts C5 and C19). `delorun start` attaches it to the running Host.
 *
 * @module @delo/cli/devices/host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocalDeviceApproval } from '@delo/home-process'
import type {} from '@delo/home-auth'

/**
 * The local device approval of a booted Host.
 * @param ctx - the Host's root context.
 * @returns the approval, or undefined when the profile does not load `@delo/home-auth`.
 */
export function localDeviceApproval(ctx: Pick<Context, 'get'>): LocalDeviceApproval | undefined {
  const homeAuth = ctx.get('homeAuth')
  if (homeAuth === undefined) return undefined
  return {
    openWindow: () => homeAuth.openApprovalWindow(),
    windowOpenUntil: () => homeAuth.approvalWindowOpenUntil(),
    pending: () => homeAuth.pendingApprovals(),
    approve: async (requestId, typedCode) => {
      const device = await homeAuth.approveLocally(requestId, typedCode)
      return { id: device.id, label: device.label, address: device.address }
    },
  }
}
