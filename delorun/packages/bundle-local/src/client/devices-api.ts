/**
 * Requests to the home's reach, device and unlock routes, through the same-origin requests of
 * [`./host-api.ts`](./host-api.ts).
 * A refusal is the Host's `{ "error": "<CODE>", "message": "<sentence>" }` with a 4xx status.
 * @module @delorun/bundle-local/client/devices-api
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { REQUEST_DISPLAYS, WINDOWLESS_MODES, type PairingView } from '@delorun/home-auth/wire'
import {
  call, fields, hostFailureOf, isBoolean, isRefused, isString, isTime, listOf, optional, orNull, readServedRoute, type Check, type HostFetch,
} from './host-api.ts'

export {
  HostRequestError, hostFailureOf, isRefused, LOOPBACK_REQUIRED, type HostFailure, type HostFetch,
} from './host-api.ts'

/** A device the home approved, as the device list names it. */
export type DeviceId = Branded<'DelorunDeviceId'>

/** One pending approval request, as the approval form names it. */
export type ApprovalRequestId = Branded<'DelorunApprovalRequestId'>

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

/** What `GET /delorun/reach/status` answers in a profile with reach. */
export interface ReachStatus {
  readonly available: true
  /** Whether the owner has claimed this home; before that the device list is not asked for. */
  readonly hasOwner: boolean
  readonly options: readonly ReachOptionStatus[]
}

/** One approved device. */
export interface Device {
  readonly id: DeviceId
  readonly label: string
  readonly platform: string
  /** The address it signed in through; absent in the list a device reads, where it is the computer's to read. */
  readonly address?: string
  /** Milliseconds since the epoch. */
  readonly approvedAt: number
  /** `local` when the device was approved at the home's own computer; absent in the list a device reads. */
  readonly approvedBy?: string | null
  /** Milliseconds since the epoch, or null before the first sign-in. */
  readonly lastSignInAt: number | null
}

/** What `GET /auth/devices` answers once the home has an owner. */
export interface DeviceList {
  /** The first device's id is absent in the list a device reads. */
  readonly owner: { readonly claimedAt: number; readonly firstDeviceId?: string }
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
  /** The Tailscale user the request named, a hint to compare with who the person expects; null when it named none. */
  readonly identity: PairingIdentity | null
  /** Whether the request arrived outside an approval window. */
  readonly windowless: boolean
  /** The wrong codes typed so far; the third cancels the request. */
  readonly wrongCodes: number
}

/** The Tailscale user a request named. */
export interface PairingIdentity {
  /** The login name, such as `person@example.com`. */
  readonly login: string
  /** The display name; the login when the request carried none. */
  readonly name: string
}

/** What `GET /auth/devices/pending` answers. */
export interface PendingDevices {
  /** When the approval window closes, in milliseconds since the epoch; null while it is closed. */
  readonly windowClosesAt: number | null
  readonly pending: readonly PendingDevice[]
  /** The pairing choices the home runs with. */
  readonly pairing: PairingView
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
  reachStatus: '/delorun/reach/status',
  devices: '/auth/devices',
  window: '/auth/devices/window',
  pending: '/auth/devices/pending',
  approve: '/auth/devices/approve',
  cancel: '/auth/devices/cancel',
  remove: '/auth/devices/remove',
} as const

const isReachStatus = fields({
  available: value => value === true,
  hasOwner: isBoolean,
  options: listOf(fields({
    option: isString,
    state: value => (REACH_STATES as readonly unknown[]).includes(value),
    address: optional(isString),
    cause: optional(isString),
    detail: optional(isString),
  })),
})
const isDeviceList = fields({
  owner: fields({ claimedAt: isTime, firstDeviceId: optional(isString) }),
  devices: listOf(fields({
    id: isString, label: isString, platform: isString, address: optional(isString),
    approvedAt: isTime, approvedBy: optional(orNull(isString)), lastSignInAt: orNull(isTime),
  })),
})
const isWindow = fields({ closesAt: isTime })
const isPendingDevices = fields({
  windowClosesAt: orNull(isTime),
  pending: listOf(fields({
    requestId: isString, label: isString, platform: isString, address: isString, createdAt: isTime, expiresAt: isTime,
    identity: orNull(fields({ login: isString, name: isString })), windowless: isBoolean, wrongCodes: isTime,
  })),
  pairing: fields({
    mayAskWithoutWindow: value => (WINDOWLESS_MODES as readonly unknown[]).includes(value),
    showRequest: value => (REQUEST_DISPLAYS as readonly unknown[]).includes(value),
    windowMinutes: isTime, requestExpiryMinutes: isTime, pendingPerIdentity: isTime,
  }),
})
const isApprovedDevice = fields({ device: fields({ id: isString, label: isString, address: isString }) })
const isCancelledRequest = fields({ cancelled: isString })
const isRemovedDevice = fields({ removed: isBoolean, sessions: isTime, connections: isTime })

/**
 * Read the reach state of each option this home builds.
 * @param fetch - the request function, such as the browser's `fetch`.
 * @returns the status, or undefined when this profile has no reach (the route answers 404).
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export function readReachStatus(fetch: HostFetch): Promise<ReachStatus | undefined> {
  return readServedRoute<ReachStatus>(fetch, DEVICE_ROUTES.reachStatus, isReachStatus)
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

/** One request to unlock, as the device's own studio and the computer name it. */
export type ElevationRequestId = Branded<'DelorunElevationRequestId'>

/** One running unlock, as the computer names it to end it. */
export type ElevationId = Branded<'DelorunElevationId'>

/**
 * What `GET /auth/elevation` answers a device about its own unlock on the address it uses: none, a request waiting
 * with the code to type at the computer, or a running unlock. Times are milliseconds since the epoch. `unlockMinutes`
 * is the length an unlock on this address lasts, omitted by a home that predates it.
 */
export type ElevationState =
  | { readonly kind: 'none'; readonly unlockMinutes?: number }
  | { readonly kind: 'pending'; readonly requestId: ElevationRequestId; readonly code: string; readonly expiresAt: number; readonly unlockMinutes?: number }
  | { readonly kind: 'elevated'; readonly elevationId: ElevationId; readonly endsAt: number }

/** One request to unlock waiting at the computer, without its code, which the person reads from the device. */
export interface PendingElevation {
  readonly requestId: ElevationRequestId
  readonly deviceId: DeviceId
  /** Milliseconds since the epoch. */
  readonly requestedAt: number
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/** One running unlock, as the computer lists it. */
export interface RunningElevation {
  readonly id: ElevationId
  readonly deviceId: DeviceId
  /** Milliseconds since the epoch. */
  readonly startedAt: number
  /** Milliseconds since the epoch. */
  readonly endsAt: number
}

/** What `GET /auth/elevation/pending` answers the computer. */
export interface ElevationsAtComputer {
  readonly pending: readonly PendingElevation[]
  readonly running: readonly RunningElevation[]
}

/** The unlock routes this module calls: the device's three, then the computer's three. */
export const ELEVATION_ROUTES = {
  state: '/auth/elevation',
  request: '/auth/elevation/request',
  lock: '/auth/elevation/lock',
  pending: '/auth/elevation/pending',
  approve: '/auth/elevation/approve',
  revoke: '/auth/elevation/revoke',
} as const

/** The Host error code a device route answers on the computer's own address, where no device unlocks. */
export const HOST_MISMATCH = 'HOST_MISMATCH'

/** Interval between two reads of the computer's list of unlock requests while it shows. */
export const ELEVATION_POLL_MS = 2000

const isElevationState: Check = value => fields({ kind: kind => kind === 'none', unlockMinutes: optional(isTime) })(value)
  || fields({ kind: kind => kind === 'pending', requestId: isString, code: code => typeof code === 'string' && /^\d{8}$/.test(code), expiresAt: isTime, unlockMinutes: optional(isTime) })(value)
  || fields({ kind: kind => kind === 'elevated', elevationId: isString, endsAt: isTime })(value)
const isElevationsAtComputer = fields({
  pending: listOf(fields({ requestId: isString, deviceId: isString, requestedAt: isTime, expiresAt: isTime })),
  running: listOf(fields({ id: isString, deviceId: isString, startedAt: isTime, endsAt: isTime })),
})
const isElevationRecord = fields({ id: isString, deviceId: isString, startedAt: isTime, endsAt: isTime })
const isRevoked = fields({ revoked: isBoolean })

/**
 * Read this device's own unlock state.
 * @param fetch - the request function.
 * @returns the state, or undefined where no device unlocks: the computer's own address (`HOST_MISMATCH`) or a profile
 *   without the routes (404).
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
export async function readElevation(fetch: HostFetch): Promise<ElevationState | undefined> {
  try {
    return await call<ElevationState>(fetch, ELEVATION_ROUTES.state, isElevationState)
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind !== 'unreachable' && (failure.status === 404 || (failure.kind === 'refused' && failure.code === HOST_MISMATCH))) return undefined
    throw error
  }
}

/**
 * Read the requests to unlock waiting at the computer and the running unlocks.
 * @param fetch - the request function.
 * @returns both lists.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` on a device), an unreachable Host or an unreadable answer.
 */
export function readElevationsAtComputer(fetch: HostFetch): Promise<ElevationsAtComputer> {
  return call<ElevationsAtComputer>(fetch, ELEVATION_ROUTES.pending, isElevationsAtComputer)
}

/**
 * Approve one request to unlock at the computer with the code the device shows.
 * @param fetch - the request function.
 * @param requestId - the request.
 * @param typedCode - the code the person typed, as eight digits.
 * @returns the unlock that started.
 * @throws {HostRequestError} for a refusal (`APPROVAL_CODE_MISMATCH`, `APPROVAL_EXPIRED` among them), an unreachable
 *   Host or an unreadable answer.
 */
export function approveElevation(fetch: HostFetch, requestId: ElevationRequestId, typedCode: string): Promise<RunningElevation> {
  return call<RunningElevation>(fetch, ELEVATION_ROUTES.approve, isElevationRecord, { requestId, typedCode })
}

/**
 * Decline a request to unlock, or end a running unlock, at the computer.
 * @param fetch - the request function.
 * @param id - the request's or the unlock's id.
 * @returns whether it was waiting or running.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function revokeElevation(fetch: HostFetch, id: ElevationRequestId | ElevationId): Promise<boolean> {
  return (await call<{ revoked: boolean }>(fetch, ELEVATION_ROUTES.revoke, isRevoked, { id })).revoked
}
