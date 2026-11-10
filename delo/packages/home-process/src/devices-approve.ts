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
 *   approves that request with the match code the person typed, which records the approver as `local`.
 *
 * @module @delo/home-process/devices-approve
 */
import type { DevicesApproveRequest } from '@delo/contract-home-process'
import { HomeProcessError } from './errors.ts'

/** A pending approval request as the person's command shows it. */
export interface PendingDevice {
  readonly requestId: string
  readonly label: string
  readonly platform: string
  readonly address: string
  readonly createdAt: number
  readonly expiresAt: number
}

/** The Host's half of the local approval: `@delo/home-auth`'s window, pending requests and approval. */
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
}

/** Which credential a request carried. */
export type ChannelCaller = 'person' | 'host'

/** How often the operation looks for a pending request while the window is open, in milliseconds. */
export const PENDING_POLL_MS = 500

/**
 * Run `devices.approve`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param devices - the Host's local approval, or undefined when the profile does not load `@delo/home-auth`.
 * @param wait - waits between looks for a pending request; a timer by default.
 * @returns the final line's fields: the window and the pending requests, or the approved device.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `APPROVALS_UNAVAILABLE` without home-auth;
 *   `SCHEMA_VIOLATION` for a request id without a code or the reverse; `APPROVAL_FAILED` naming home-auth's code for
 *   a refused approval.
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
  if (devices === undefined) throw new HomeProcessError('APPROVALS_UNAVAILABLE', 'this profile does not load @delo/home-auth')
  const { requestId, typedCode } = request.args
  if ((requestId === undefined) !== (typedCode === undefined)) {
    throw new HomeProcessError('SCHEMA_VIOLATION', 'an approval names both the request and the typed code')
  }
  if (requestId !== undefined && typedCode !== undefined) {
    try {
      return { device: await devices.approve(requestId, typedCode) }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
      const detail = error instanceof Error && 'detail' in error && typeof error.detail === 'string' ? error.detail : 'the approval failed'
      throw new HomeProcessError('APPROVAL_FAILED', `${code}: ${detail}`)
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
