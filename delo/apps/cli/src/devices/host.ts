/**
 * The home process's way to `@delo/home-auth` in the Host it runs: the local device approval, cancel and removal that the
 * update channel's `devices.approve` and `devices.remove` drive (contracts C5 and C19), and the answers to a device's
 * request to unlock sensitive actions that `devices.elevate` drives (C14, "Elevation"). `delorun start` attaches it to
 * the running Host.
 *
 * @module @delo/cli/devices/host
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId } from '@delo/contract-admission'
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
    cancel: (requestId) => { homeAuth.cancelApproval(requestId) },
    remove: async (deviceId) => {
      const result = await homeAuth.revokeDevice(brandString<DeviceId>(deviceId))
      return { removed: result.removed, sessions: result.sessions, connections: result.connections }
    },
    elevations: async () => {
      const { pending, running } = homeAuth.elevationsAtComputer()
      // A home with nothing to name may have no owner yet, and its device listing refuses that.
      if (pending.length === 0 && running.length === 0) return { pending: [], running: [] }
      const named = new Map((await homeAuth.devices()).devices.map(device => [device.id, device]))
      const nameOf = (deviceId: DeviceId) => ({ label: named.get(deviceId)?.label ?? '', platform: named.get(deviceId)?.platform ?? '' })
      return {
        pending: pending.map(request => ({ requestId: request.requestId, deviceId: request.deviceId, ...nameOf(request.deviceId), requestedAt: request.requestedAt, expiresAt: request.expiresAt })),
        running: running.map(elevation => ({ id: elevation.id, deviceId: elevation.deviceId, ...nameOf(elevation.deviceId), endsAt: elevation.endsAt })),
      }
    },
    approveElevation: (requestId, typedCode) => {
      const elevation = homeAuth.approveElevation(requestId, typedCode)
      return { id: elevation.id, deviceId: elevation.deviceId, endsAt: elevation.endsAt }
    },
    revokeElevation: id => homeAuth.revokeElevation(id),
  }
}
