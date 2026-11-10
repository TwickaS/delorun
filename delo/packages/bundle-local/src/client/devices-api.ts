/**
 * Same-origin requests to the home's reach and device routes, and the validation of their JSON answers. Every request
 * carries `credentials: 'same-origin'`; a request with a body sends it as JSON. A refusal is the Host's
 * `{ "error": "<CODE>", "message": "<sentence>" }` with a 4xx status.
 * @module @delo/bundle-local/client/devices-api
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** The `fetch` the requests go through: the browser's own, or a spec's fake. */
export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>

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

/**
 * Why a request did not produce an answer: the Host refused it, the Host could not be reached, or its answer was not
 * the JSON the route promises.
 */
export type HostFailure =
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string }
  | { readonly kind: 'unreachable'; readonly cause: unknown }
  | { readonly kind: 'unreadable'; readonly status: number }

/** A failed request to the home, carrying its {@link HostFailure}. */
export class HostRequestError extends Error {
  /** The route that failed. */
  readonly path: string
  /** Why it failed. */
  readonly failure: HostFailure

  /**
   * @param path - the route that failed.
   * @param failure - why it failed.
   */
  constructor(path: string, failure: HostFailure) {
    super(`${path}: ${failure.kind === 'refused' ? `${failure.code}: ${failure.message}` : failure.kind}`, failure.kind === 'unreachable' ? { cause: failure.cause } : undefined)
    this.name = 'HostRequestError'
    this.path = path
    this.failure = failure
  }
}

/** The Host error code of a refusal that only the home's own computer may perform. */
export const LOOPBACK_REQUIRED = 'LOOPBACK_REQUIRED'

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

/** A predicate over one decoded JSON value. */
type Check = (value: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString: Check = value => typeof value === 'string'
const isTime: Check = value => typeof value === 'number' && Number.isFinite(value)
const orNull = (check: Check): Check => value => value === null || check(value)
const optional = (check: Check): Check => value => value === undefined || check(value)
const listOf = (check: Check): Check => value => Array.isArray(value) && value.every(check)
const fields = (shape: Readonly<Record<string, Check>>): Check =>
  value => isRecord(value) && Object.entries(shape).every(([key, check]) => check(value[key]))

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
const isRefusal = fields({ error: isString, message: isString })

/**
 * Send one request and read its JSON answer.
 * @param fetch - the request function.
 * @param path - the route.
 * @param body - the JSON body; absent sends none.
 * @returns the status and the decoded answer.
 * @throws {HostRequestError} `unreachable` when the request did not complete, `unreadable` when the answer is not JSON.
 */
async function send(fetch: HostFetch, path: string, body?: object): Promise<{ status: number; ok: boolean; json: unknown }> {
  const init: RequestInit = body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
    : { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (cause) {
    throw new HostRequestError(path, { kind: 'unreachable', cause })
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    // The answer is not JSON (a proxy's page, for example): the caller reports an unreadable answer.
    throw new HostRequestError(path, { kind: 'unreadable', status: response.status })
  }
  return { status: response.status, ok: response.ok, json }
}

/**
 * Send one request and validate its answer.
 * @param fetch - the request function.
 * @param path - the route.
 * @param check - the answer's validation.
 * @param body - the JSON body; absent sends a GET.
 * @returns the validated answer.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an answer that fails validation.
 */
async function call<T>(fetch: HostFetch, path: string, check: Check, body?: object): Promise<T> {
  const { status, ok, json } = await send(fetch, path, body)
  if (!ok) {
    if (!isRefusal(json)) throw new HostRequestError(path, { kind: 'unreadable', status })
    const refusal = json as { error: string; message: string }
    throw new HostRequestError(path, { kind: 'refused', status, code: refusal.error, message: refusal.message })
  }
  if (!check(json)) throw new HostRequestError(path, { kind: 'unreadable', status })
  return json as T
}

/**
 * The failure a caught error stands for.
 * @param error - the caught error.
 * @returns the {@link HostRequestError}'s failure; any other error is reported as an unreachable Host, with the error
 *   as its cause.
 */
export function hostFailureOf(error: unknown): HostFailure {
  return error instanceof HostRequestError ? error.failure : { kind: 'unreachable', cause: error }
}

/**
 * Whether an error is the Host's refusal with one code.
 * @param error - the caught error.
 * @param code - the Host error code.
 * @returns true for a {@link HostRequestError} whose refusal carries that code.
 */
export function isRefused(error: unknown, code: string): boolean {
  const failure = hostFailureOf(error)
  return failure.kind === 'refused' && failure.code === code
}

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
