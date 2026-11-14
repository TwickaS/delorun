/**
 * The update channel's `devices.approve` operation (contracts C5 and C19): the local approval at the home's own
 * computer, and the caller rule that keeps it there.
 *
 * - **Two credentials.** The person's own `delorun` reads the start token from the token file. The Host reaches the
 *   channel with a second token, new at every start and held only in memory, so the home process tells the two callers
 *   apart: the channel's `ChannelTokenCheck` (`studio-link.ts`) accepts either for every other operation.
 * - **The caller rule.** `devices.approve` is accepted only with the person's token. The Host's token, which acts for
 *   studio sessions on every listener, reach sessions included, is refused with `LOOPBACK_REQUIRED` before anything is
 *   read or opened.
 * - **The operation.** Without arguments it opens the approval window (claiming the home for the local person when it
 *   has no owner) and answers once a request is pending or the window closed. With `requestId` and `typedCode` it
 *   approves that request with the match code the person typed, which records the approver as `local`. With
 *   `cancelRequestId` alone it cancels that pending request at the person's choice.
 * - **`devices.elevate`.** The same caller rule keeps the answer to a device's request to unlock sensitive actions (C14,
 *   "Elevation") at the computer: it lists the waiting requests and the running elevations, approves a request with the
 *   code the device shows, and declines a request or ends an elevation.
 *
 * @module @delorun/home-process/devices-approve
 */
import type { DevicesApproveRequest, DevicesElevateRequest, DevicesRemoveRequest, PinOffRequest, PinOptionsRequest, PinResumeRequest, PinSetRequest } from '@delorun/contract-home-process'
import { HomeProcessError } from './errors.ts'

/** A pending approval request as the person's command shows it. */
export interface PendingDevice {
  readonly requestId: string
  readonly label: string
  readonly platform: string
  readonly address: string
  readonly createdAt: number
  readonly expiresAt: number
  /** The Tailscale user the request named, or null; a hint the person compares, never proof. */
  readonly identity: { readonly login: string; readonly name: string } | null
  /** Whether the request arrived without an approval window. */
  readonly windowless: boolean
}

/** A device's waiting request to unlock sensitive actions, as the person's command shows it; never with its code. */
export interface PendingElevationRequest {
  readonly requestId: string
  readonly deviceId: string
  /** The device's name and platform, empty when its record is gone. */
  readonly label: string
  readonly platform: string
  readonly requestedAt: number
  readonly expiresAt: number
}

/** A device's running elevation, as the person's command shows it. */
export interface RunningElevation {
  readonly id: string
  readonly deviceId: string
  /** The device's name and platform, empty when its record is gone. */
  readonly label: string
  readonly platform: string
  readonly endsAt: number
}

/** The waiting requests to unlock and the running elevations, oldest first. */
export type ElevationsAtComputer = {
  readonly pending: readonly PendingElevationRequest[]
  readonly running: readonly RunningElevation[]
}

/** The Host's half of the local approval: `@delorun/home-auth`'s window, pending requests and approval. */
export interface LocalDeviceApproval {
  /**
   * Open the approval window, claiming the home for the local person when it has no owner.
   * @returns when the window closes.
   */
  openWindow(): Promise<number>
  /**
   * When the open window closes.
   * @returns the time, or undefined with no window open.
   */
  windowOpenUntil(): number | undefined
  /**
   * The pending requests.
   * @returns their summaries.
   */
  pending(): readonly PendingDevice[]
  /**
   * Approve one request with the typed match code.
   * @param requestId - the request.
   * @param typedCode - the 8 digits the person typed.
   * @returns the new device.
   * @throws an error with a `code` property, such as `APPROVAL_CODE_MISMATCH`, for a refused approval.
   */
  approve(requestId: string, typedCode: string): Promise<{ readonly id: string; readonly label: string; readonly address: string }>
  /**
   * Cancel one pending request.
   * @param requestId - the request.
   * @throws an error with a `code` property, such as `APPROVAL_EXPIRED`, for a request that is not pending.
   */
  cancel(requestId: string): void
  /**
   * Remove one trusted device, ending its sessions and closing its reach connections.
   * @param deviceId - the device.
   * @returns whether it had a record, and how many sessions and connections ended.
   * @throws an error with a `code` property, such as `NO_OWNER`, for a refused removal.
   */
  remove(deviceId: string): Promise<{ readonly removed: boolean; readonly sessions: number; readonly connections: number }>
  /**
   * The waiting requests to unlock sensitive actions and the running elevations.
   * @returns both, with each device's name.
   */
  elevations(): Promise<ElevationsAtComputer>
  /**
   * Approve a request to unlock with the code the person typed from the device.
   * @param requestId - the request.
   * @param typedCode - the 8 digits.
   * @returns the elevation that started.
   * @throws an error with a `code` property, such as `APPROVAL_CODE_MISMATCH`, for a refused approval.
   */
  approveElevation(requestId: string, typedCode: string): { readonly id: string; readonly deviceId: string; readonly endsAt: number }
  /**
   * Decline a request to unlock or end an elevation.
   * @param id - the request id or the elevation id.
   * @returns whether either was found.
   */
  revokeElevation(id: string): boolean
  /**
   * Set or replace the PIN and turn PIN mode on.
   * @param secret - the PIN or passcode.
   * @param options - the idle minutes and the lock-when-hidden choice.
   * @returns the kind of secret.
   * @throws an error with a `code` property, such as `PIN_WEAK`, for a refused secret.
   */
  setPin(secret: string, options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined }): Promise<'pin' | 'passcode'>
  /**
   * Change the idle minutes and lock-when-hidden of PIN mode that is on, without the secret.
   * @param options - the new values; a missing one stays.
   * @returns the settings now in force.
   * @throws an error with a `code` property, such as `PIN_MODE_OFF` while the mode is off.
   */
  setPinOptions(options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined }): Promise<{ readonly idleMinutes: number; readonly lockWhenHidden: boolean }>
  /**
   * Turn PIN mode off.
   */
  turnPinOff(): Promise<void>
  /**
   * Resume PIN unlocks after a home-wide pause.
   */
  resumePin(): Promise<void>
}

/** Which credential a request carried. */
export type ChannelCaller = 'person' | 'host'

/** How often the operation looks for a pending request while the window is open, in milliseconds. */
export const PENDING_POLL_MS = 500

/**
 * Run `devices.approve`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param devices - the Host's local approval, or undefined when the profile does not load `@delorun/home-auth`.
 * @param wait - waits between looks for a pending request; a timer by default.
 * @returns the final line's fields: the window and the pending requests, the approved device, or the cancelled
 *   request's id.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `APPROVALS_UNAVAILABLE` without home-auth;
 *   `SCHEMA_VIOLATION` for a request id without a code or the reverse, or a cancel with either; `APPROVAL_FAILED`
 *   naming home-auth's code for a refused approval or cancel.
 */
export async function approveDevices(
  request: DevicesApproveRequest,
  caller: ChannelCaller,
  devices: LocalDeviceApproval | undefined,
  wait: (ms: number) => Promise<void> = ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'approving a device needs you at your computer: run delorun devices approve there')
  }
  if (devices === undefined) throw new HomeProcessError('APPROVALS_UNAVAILABLE', 'this profile does not load @delorun/home-auth')
  const { requestId, typedCode, cancelRequestId } = request.args
  if ((requestId === undefined) !== (typedCode === undefined)) {
    throw new HomeProcessError('SCHEMA_VIOLATION', 'an approval names both the request and the typed code')
  }
  if (cancelRequestId !== undefined) {
    if (requestId !== undefined) throw new HomeProcessError('SCHEMA_VIOLATION', 'a cancel names only the request to cancel')
    try {
      devices.cancel(cancelRequestId)
    } catch (error) {
      throw homeAuthRefusal('APPROVAL_FAILED', error, 'the cancel failed')
    }
    return { cancelled: cancelRequestId }
  }
  if (requestId !== undefined && typedCode !== undefined) {
    try {
      return { device: await devices.approve(requestId, typedCode) }
    } catch (error) {
      throw homeAuthRefusal('APPROVAL_FAILED', error, 'the approval failed')
    }
  }
  const closesAt = await devices.openWindow()
  for (;;) {
    const pending = devices.pending()
    const open = devices.windowOpenUntil()
    if (pending.length > 0 || open === undefined) return { closesAt: open ?? closesAt, pending }
    await wait(PENDING_POLL_MS)
  }
}

/**
 * A refusal naming home-auth's code and sentence.
 * @param refusal - the operation's refusal code.
 * @param error - what home-auth threw.
 * @param fallback - the sentence for an error without one.
 * @returns the refusal.
 */
function homeAuthRefusal(refusal: 'APPROVAL_FAILED' | 'REMOVAL_FAILED' | 'ELEVATION_FAILED' | 'PIN_FAILED', error: unknown, fallback: string): HomeProcessError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
  const detail = error instanceof Error && 'detail' in error && typeof error.detail === 'string' ? error.detail : fallback
  return new HomeProcessError(refusal, `${code}: ${detail}`)
}

/**
 * Run `devices.remove`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param devices - the Host's local approval, or undefined when the profile does not load `@delorun/home-auth`.
 * @returns whether the device had a record, and how many sessions and reach connections ended.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `APPROVALS_UNAVAILABLE` without home-auth;
 *   `REMOVAL_FAILED` naming home-auth's code for a refused removal.
 */
export async function removeDevice(request: DevicesRemoveRequest, caller: ChannelCaller, devices: LocalDeviceApproval | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'removing a device needs you at your computer: run delorun devices remove there')
  }
  if (devices === undefined) throw new HomeProcessError('APPROVALS_UNAVAILABLE', 'this profile does not load @delorun/home-auth')
  try {
    return await devices.remove(request.args.deviceId)
  } catch (error) {
    throw homeAuthRefusal('REMOVAL_FAILED', error, 'the removal failed')
  }
}

/**
 * Run `devices.elevate`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param devices - the Host's local approval, or undefined when the profile does not load `@delorun/home-auth`.
 * @returns the waiting requests and the running elevations, the elevation that started, or whether a revoke found its
 *   request or elevation.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `APPROVALS_UNAVAILABLE` without home-auth;
 *   `SCHEMA_VIOLATION` for a request id without a code or the reverse, or a revoke with either; `ELEVATION_FAILED`
 *   naming home-auth's code for a refused approval or listing.
 */
export async function elevateDevices(request: DevicesElevateRequest, caller: ChannelCaller, devices: LocalDeviceApproval | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'unlocking sensitive actions on a device needs you at your computer: run delorun devices elevate there')
  }
  if (devices === undefined) throw new HomeProcessError('APPROVALS_UNAVAILABLE', 'this profile does not load @delorun/home-auth')
  const { requestId, typedCode, revokeId } = request.args
  if ((requestId === undefined) !== (typedCode === undefined)) {
    throw new HomeProcessError('SCHEMA_VIOLATION', 'an approval names both the request and the typed code')
  }
  if (revokeId !== undefined && requestId !== undefined) throw new HomeProcessError('SCHEMA_VIOLATION', 'a revoke names only the request or elevation to end')
  try {
    if (revokeId !== undefined) return { revoked: devices.revokeElevation(revokeId) }
    if (requestId !== undefined && typedCode !== undefined) return { elevation: devices.approveElevation(requestId, typedCode) }
    return await devices.elevations()
  } catch (error) {
    throw homeAuthRefusal('ELEVATION_FAILED', error, 'the unlock did not change')
  }
}

/**
 * Run `pin.set`, `pin.options`, `pin.off` or `pin.resume`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param devices - the Host's local approval, or undefined when the profile does not load `@delorun/home-auth`.
 * @returns whether PIN mode is on and, for a set, the kind of secret; a resume answers `paused: false`.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `APPROVALS_UNAVAILABLE` without home-auth;
 *   `PIN_FAILED` naming home-auth's code for a refused secret; the message never holds the secret.
 */
export async function changePin(request: PinSetRequest | PinOffRequest | PinOptionsRequest | PinResumeRequest, caller: ChannelCaller, devices: LocalDeviceApproval | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'changing the PIN needs you at your computer: run delorun there')
  }
  if (devices === undefined) throw new HomeProcessError('APPROVALS_UNAVAILABLE', 'this profile does not load @delorun/home-auth')
  try {
    switch (request.op) {
      case 'pin.set':
        return { enabled: true, secret: await devices.setPin(request.args.secret, request.args) }
      case 'pin.options':
        return { enabled: true, ...await devices.setPinOptions(request.args) }
      case 'pin.off':
        await devices.turnPinOff()
        return { enabled: false }
      case 'pin.resume':
        await devices.resumePin()
        return { paused: false }
      default:
        return assertNever(request)
    }
  } catch (error) {
    throw homeAuthRefusal('PIN_FAILED', error, 'PIN mode did not change')
  }
}

/**
 * Fail at compile time when an operation is not handled.
 * @param value - the value no case handled.
 * @throws {Error} always.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled PIN operation ${JSON.stringify(value)}`)
}
