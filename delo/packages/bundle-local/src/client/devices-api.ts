/**
 * Requests to the home's reach and device routes, through the same-origin requests of [`./host-api.ts`](./host-api.ts).
 * A refusal is the Host's `{ "error": "<CODE>", "message": "<sentence>" }` with a 4xx status.
 * @module @delo/bundle-local/client/devices-api
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { call, fields, hostFailureOf, isRefused, isString, isTime, listOf, optional, orNull, type HostFetch } from './host-api.ts'

export {
  HostRequestError, hostFailureOf, isRefused, LOOPBACK_REQUIRED, type HostFailure, type HostFetch,
} from './host-api.ts'

/** A device the home approved, as the device list names it. */
export type DeviceId = Branded<'DeloDeviceId'>

/** One pending approval request, as the approval form names it. */
export type ApprovalRequestId = Branded<'DeloApprovalRequestId'>

/** The states a reach option reports. */
export const REACH_STATES = ['off', 'starting', 'ready', 'degraded', 'blocked', 'stopping', 'failed'] as const

/** One state of {@link REACH_STATES}. */
export type ReachState = (typeof REACH_STATES)[number]

/** One reach option's state. */
export interface ReachOptionStatus {
  /** The option, such as `tailscale-private`. */
  readonly option: string
  readonly state: ReachState
  /** The studio's address on this option, when the option has one. */
  readonly address?: string
  /** The Host's error code for a blocked or failed option. */
  readonly cause?: string
  /** One sentence on why the option is blocked or failed. */
  readonly detail?: string
}

/** What `GET /delo/reach/status` answers in a profile with reach. */
export interface ReachStatus {
  readonly available: true
  readonly options: readonly ReachOptionStatus[]
}

/** One approved device. */
export interface Device {
  readonly id: DeviceId
  readonly label: string
  readonly platform: string
  readonly address: string
  /** Milliseconds since the epoch. */
  readonly approvedAt: number
  /** `local` when the device was approved at the home's own computer. */
  readonly approvedBy: string | null
  /** Milliseconds since the epoch, or null before the first sign-in. */
  readonly lastSignInAt: number | null
}

/** What `GET /auth/devices` answers once the home has an owner. */
export interface DeviceList {
  readonly owner: { readonly claimedAt: number; readonly firstDeviceId: string }
  readonly devices: readonly Device[]
}

/** One device asking for approval. */
export interface PendingDevice {
  readonly requestId: ApprovalRequestId
  readonly label: string
  readonly platform: string
  readonly address: string
  /** Milliseconds since the epoch. */
  readonly createdAt: number
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/** What `GET /auth/devices/pending` answers. */
export interface PendingDevices {
  /** When the approval window closes, in milliseconds since the epoch; null while it is closed. */
  readonly windowClosesAt: number | null
  readonly pending: readonly PendingDevice[]
}

/** What `POST /auth/devices/approve` answers. */
export interface ApprovedDevice {
  readonly device: { readonly id: DeviceId; readonly label: string; readonly address: string }
}

/** What `POST /auth/devices/remove` answers. */
export interface RemovedDevice {
  /** False when the device was not in the list. */
  readonly removed: boolean
  /** Sessions the removal signed out. */
  readonly sessions: number
  /** Connections the removal closed. */
  readonly connections: number
}

/** Interval between two reads of the pending requests while the approval window is open. */
export const PENDING_POLL_MS = 2000

/** The routes this module calls. */
export const DEVICE_ROUTES = {
  reachStatus: '/delo/reach/status',
  devices: '/auth/devices',
  window: '/auth/devices/window',
  pending: '/auth/devices/pending',
  approve: '/auth/devices/approve',
  cancel: '/auth/devices/cancel',
  remove: '/auth/devices/remove',
} as const

const isReachStatus = fields({
  available: value => value === true,
  options: listOf(fields({
    option: isString,
    state: value => (REACH_STATES as readonly unknown[]).includes(value),
    address: optional(isString),
    cause: optional(isString),
    detail: optional(isString),
  })),
})
const isDeviceList = fields({
  owner: fields({ claimedAt: isTime, firstDeviceId: isString }),
  devices: listOf(fields({
    id: isString, label: isString, platform: isString, address: isString,
    approvedAt: isTime, approvedBy: orNull(isString), lastSignInAt: orNull(isTime),
  })),
})
const isWindow = fields({ closesAt: isTime })
const isPendingDevices = fields({
  windowClosesAt: orNull(isTime),
  pending: listOf(fields({
    requestId: isString, label: isString, platform: isString, address: isString, createdAt: isTime, expiresAt: isTime,
  })),
})
const isApprovedDevice = fields({ device: fields({ id: isString, label: isString, address: isString }) })
const isCancelledRequest = fields({ cancelled: isString })
const isRemovedDevice = fields({ removed: value => typeof value === 'boolean', sessions: isTime, connections: isTime })

/**
 * Read the reach state of each option this home builds.
 * @param fetch - the request function, such as the browser's `fetch`.
 * @returns the status, or undefined when this profile has no reach (the route answers 404).
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export async function readReachStatus(fetch: HostFetch): Promise<ReachStatus | undefined> {
  try {
    return await call<ReachStatus>(fetch, DEVICE_ROUTES.reachStatus, isReachStatus)
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind !== 'unreachable' && failure.status === 404) return undefined
    throw error
  }
}

/**
 * Read the approved devices.
 * @param fetch - the request function.
 * @returns the list, or undefined when the home has no owner yet (`NO_OWNER`), which means no devices.
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export async function readDevices(fetch: HostFetch): Promise<DeviceList | undefined> {
  try {
    return await call<DeviceList>(fetch, DEVICE_ROUTES.devices, isDeviceList)
  } catch (error) {
    if (isRefused(error, 'NO_OWNER')) return undefined
    throw error
  }
}

/**
 * Open the five-minute approval window, in which a new device may ask for approval.
 * @param fetch - the request function.
 * @returns when the window closes, in milliseconds since the epoch.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function openApprovalWindow(fetch: HostFetch): Promise<number> {
  return (await call<{ closesAt: number }>(fetch, DEVICE_ROUTES.window, isWindow, {})).closesAt
}

/**
 * Read the approval window and the devices asking for approval.
 * @param fetch - the request function.
 * @returns the window and the pending requests.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function readPendingDevices(fetch: HostFetch): Promise<PendingDevices> {
  return call<PendingDevices>(fetch, DEVICE_ROUTES.pending, isPendingDevices)
}

/**
 * Approve one pending request with the code the device shows.
 * @param fetch - the request function.
 * @param requestId - the pending request.
 * @param typedCode - the code the person typed, as eight digits.
 * @returns the approved device.
 * @throws {HostRequestError} for a refusal (`APPROVAL_CODE_MISMATCH`, `APPROVAL_EXPIRED` among them), an unreachable
 *   Host or an unreadable answer.
 */
export function approveDevice(fetch: HostFetch, requestId: ApprovalRequestId, typedCode: string): Promise<ApprovedDevice> {
  return call<ApprovedDevice>(fetch, DEVICE_ROUTES.approve, isApprovedDevice, { requestId, typedCode })
}

/** What `POST /auth/devices/cancel` answers. */
export interface CancelledRequest {
  /** The request that was cancelled. */
  readonly cancelled: string
}

/**
 * Cancel one pending request, which frees its place among the 5 pending; the device that asked reads it as cancelled.
 * @param fetch - the request function.
 * @param requestId - the pending request.
 * @returns the cancelled request's id.
 * @throws {HostRequestError} for a refusal (`APPROVAL_EXPIRED` for a request no longer pending), an unreachable Host or an
 *   unreadable answer.
 */
export function cancelPendingDevice(fetch: HostFetch, requestId: ApprovalRequestId): Promise<CancelledRequest> {
  return call<CancelledRequest>(fetch, DEVICE_ROUTES.cancel, isCancelledRequest, { requestId })
}

/**
 * Remove one device, which signs it out at once.
 * @param fetch - the request function.
 * @param deviceId - the device.
 * @returns whether it was removed and what the removal closed.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function removeDevice(fetch: HostFetch, deviceId: DeviceId): Promise<RemovedDevice> {
  return call<RemovedDevice>(fetch, DEVICE_ROUTES.remove, isRemovedDevice, { v: 1, deviceId })
}
