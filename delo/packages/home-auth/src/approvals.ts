/**
 * Approval requests on a route whose identity factor is `tailnet-membership`, and the approval window that admits them
 * (contract C5, "Approval request" and "Approval window").
 *
 * - **The window.** A request is accepted only while the person has opened a window at the home's own computer: the
 *   loopback studio's "Add a device" or `delorun devices approve`. A window lasts 5 minutes and closes at the first
 *   approval. Outside a window the route answers `APPROVALS_CLOSED` without reading the body, because every request on
 *   this route has the source `127.0.0.1` and a standing queue could be kept full by any device on the tailnet.
 * - **The request.** Bound to the listener's studio address, it expires 5 minutes after it was created; a home holds at
 *   most 5 pending, and a source makes at most 10 a minute. Its state is read with its request secret at most once
 *   every 2 seconds.
 * - **The local approval.** The person chooses one pending request and types the match code its device shows. A wrong
 *   code is refused with `APPROVAL_CODE_MISMATCH` and the third cancels that request only. The person may also cancel
 *   a pending request, which frees its place when 5 are pending: a request is never replaced without that choice.
 *
 * Everything here is in memory: a restart closes the window and drops pending requests, which the new device sees as
 * `APPROVAL_EXPIRED` and sends again.
 *
 * @module @delo/home-auth/approvals
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, ReachListenerId, StudioAddress } from '@delo/contract-admission'
import {
  DEVICE_APPROVAL_LIMITS, type ApprovalRequestAccepted, type ApprovalRequestId, type ApprovalRequestState, type Base64Url,
  type DevicePublicKeyJwk,
} from '@delo/contract-device-approval'
import { HomeAuthError } from './errors.ts'
import { AttemptLimiter } from './rate-limit.ts'
import { matchCode, typedCodeMatches } from './match-code.ts'
import { hashSecret, newSecret, secretMatches, type RandomBytes } from './secret.ts'

const MINUTE_MS = 60 * 1000

/** A pending or settled approval request, as the home holds it. */
export interface ApprovalRecord {
  readonly id: ApprovalRequestId
  /** SHA-256 of the request secret; the secret itself is handed out once. */
  readonly secretHash: string
  readonly devicePublicKey: DevicePublicKeyJwk
  readonly deviceId: DeviceId
  readonly label: string
  readonly platform: string
  readonly listener: ReachListenerId
  readonly address: StudioAddress
  /** The source the per-source limit counted; under the Tailscale fallback always `127.0.0.1`. */
  readonly source: string
  readonly createdAt: number
  readonly expiresAt: number
  /** The 8-digit match code, which only the person compares. */
  readonly code: string
  state: ApprovalRequestState
  wrongCodes: number
  lastReadAt: number | undefined
}

/** A request as the local approval form shows it: no key, no code, no secret. */
export interface PendingSummary {
  readonly requestId: ApprovalRequestId
  readonly label: string
  readonly platform: string
  readonly address: StudioAddress
  readonly createdAt: number
  readonly expiresAt: number
}

/** A request message after its fields were read. */
export interface ApprovalRequestInput {
  readonly devicePublicKey: DevicePublicKeyJwk
  readonly deviceId: DeviceId
  readonly deviceNonce: Base64Url
  readonly label: string
  readonly platform: string
}

/** What the approvals read. */
export interface ApprovalsOptions {
  readonly now: () => number
  readonly random: RandomBytes
  /** The 32-byte raw home public key and its base64url text, read when a request is answered. */
  readonly homeKey: () => { readonly publicKey: Uint8Array; readonly publicKeyText: Base64Url }
}

/** The approval window and the approval requests of one home. */
export class Approvals {
  private windowClosesAt: number | undefined
  private readonly requests = new Map<string, ApprovalRecord>()
  private readonly sources: AttemptLimiter

  /**
   * @param options - the clock, the random source and the home key.
   */
  constructor(private readonly options: ApprovalsOptions) {
    this.sources = new AttemptLimiter({
      limit: DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource,
      windowMs: MINUTE_MS,
      now: options.now,
    })
  }

  /**
   * Open the approval window, or extend an open one to 5 minutes from now.
   * @returns when it closes, in milliseconds since the epoch.
   */
  openWindow(): number {
    this.windowClosesAt = this.options.now() + DEVICE_APPROVAL_LIMITS.approvalWindowMs
    return this.windowClosesAt
  }

  /** Close the window; pending requests stay pending until they expire or are approved. */
  closeWindow(): void {
    this.windowClosesAt = undefined
  }

  /**
   * When the open window closes.
   * @returns the time, or undefined when no window is open.
   */
  windowOpenUntil(): number | undefined {
    if (this.windowClosesAt === undefined || this.windowClosesAt <= this.options.now()) return undefined
    return this.windowClosesAt
  }

  /**
   * Refuse a request outside an open window; the route calls this before it reads the body.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` when no window is open.
   */
  assertWindowOpen(): void {
    if (this.windowOpenUntil() === undefined) {
      throw new HomeAuthError('APPROVALS_CLOSED', 'This home is not accepting new devices now. On the home\'s computer, choose Add a device in the studio\'s settings, or run delorun devices approve, then try again within 5 minutes')
    }
  }

  /**
   * Accept one approval request.
   * @param input - the request's fields.
   * @param where - the listener, its studio address and the source the limit counts.
   * @returns C5's `201` answer.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` outside a window; `APPROVAL_RATE_LIMITED` past the source's limit;
   *   `APPROVAL_PENDING_LIMIT` when 5 requests are pending.
   */
  request(
    input: ApprovalRequestInput,
    where: { readonly listener: ReachListenerId; readonly address: StudioAddress; readonly source: string },
  ): ApprovalRequestAccepted {
    this.assertWindowOpen()
    if (!this.sources.take(where.source)) throw new HomeAuthError('APPROVAL_RATE_LIMITED', 'Too many device requests from this address in the last minute')
    this.expire()
    const pending = [...this.requests.values()].filter(record => record.state === 'pending')
    if (pending.length >= DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome) {
      throw new HomeAuthError('APPROVAL_PENDING_LIMIT', 'This home has 5 device requests waiting. At the home\'s computer, run delorun devices approve to approve one or cancel one, then try again')
    }
    const nonceBytes = DEVICE_APPROVAL_LIMITS.nonceBytes
    const id = brandString<ApprovalRequestId>(newSecret(nonceBytes, this.options.random))
    const secret = brandString<Base64Url>(newSecret(nonceBytes, this.options.random))
    const homeNonce = brandString<Base64Url>(newSecret(nonceBytes, this.options.random))
    const key = this.options.homeKey()
    const createdAt = this.options.now()
    const expiresAt = createdAt + DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs
    this.requests.set(id, {
      id,
      secretHash: hashSecret(secret),
      devicePublicKey: input.devicePublicKey,
      deviceId: input.deviceId,
      label: input.label,
      platform: input.platform,
      listener: where.listener,
      address: where.address,
      source: where.source,
      createdAt,
      expiresAt,
      code: matchCode({ homePublicKey: key.publicKey, deviceId: input.deviceId, homeNonce, deviceNonce: input.deviceNonce, address: where.address }),
      state: 'pending',
      wrongCodes: 0,
      lastReadAt: undefined,
    })
    return { requestId: id, requestSecret: secret, homePublicKey: key.publicKeyText, homeNonce, expiresAt }
  }

  /**
   * The state of one request, read by the new device with its request secret.
   * @param id - the request id.
   * @param secret - the request secret.
   * @returns the state.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` for an unknown id or a wrong secret, which are answered alike;
   *   `APPROVAL_RATE_LIMITED` for a read within 2 seconds of the last one.
   */
  state(id: string, secret: string): ApprovalRequestState {
    this.expire()
    const record = this.requests.get(id)
    if (record === undefined || !secretMatches(secret, record.secretHash)) {
      throw new HomeAuthError('APPROVAL_EXPIRED', 'This request is unknown or has expired. Send a new one')
    }
    const at = this.options.now()
    if (record.lastReadAt !== undefined && at - record.lastReadAt < DEVICE_APPROVAL_LIMITS.requestStateReadIntervalMs) {
      throw new HomeAuthError('APPROVAL_RATE_LIMITED', 'Read a request\'s state at most once every 2 seconds')
    }
    record.lastReadAt = at
    return record.state
  }

  /**
   * The pending requests, for the local approval form.
   * @returns their summaries, oldest first.
   */
  pending(): readonly PendingSummary[] {
    this.expire()
    return [...this.requests.values()]
      .filter(record => record.state === 'pending')
      .map(record => ({
        requestId: record.id,
        label: record.label,
        platform: record.platform,
        address: record.address,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      }))
  }

  /**
   * Check a typed code against a pending request; a wrong code counts and the third cancels the request.
   * @param id - the request id.
   * @param typedCode - the digits the person typed.
   * @returns the pending request.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` for an unknown, expired, cancelled or approved request;
   *   `APPROVAL_CODE_MISMATCH` for a wrong code.
   */
  check(id: string, typedCode: string): ApprovalRecord {
    this.expire()
    const record = this.requests.get(id)
    if (record?.state !== 'pending') throw new HomeAuthError('APPROVAL_EXPIRED', 'This request is no longer waiting. Ask the new device to send a new one')
    if (!typedCodeMatches(typedCode, record.code)) {
      record.wrongCodes += 1
      if (record.wrongCodes >= DEVICE_APPROVAL_LIMITS.wrongTypedCodesPerRequest) record.state = 'cancelled'
      throw new HomeAuthError('APPROVAL_CODE_MISMATCH', record.state === 'cancelled'
        ? 'That code is wrong. After three wrong codes this request is cancelled; ask the new device to send a new one'
        : 'That code is not the one the new device shows. Type the eight digits on its screen')
    }
    return record
  }

  /**
   * Cancel a pending request at the person's choice; the new device reads its state as `cancelled`.
   * @param id - the request id.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` for an unknown, expired, cancelled or approved request.
   */
  cancel(id: string): void {
    this.expire()
    const record = this.requests.get(id)
    if (record?.state !== 'pending') throw new HomeAuthError('APPROVAL_EXPIRED', 'This request is no longer waiting')
    record.state = 'cancelled'
  }

  /**
   * Mark a checked request approved and close the window, which closes at the first approval.
   * @param record - the request {@link check} returned.
   */
  approved(record: ApprovalRecord): void {
    record.state = 'approved'
    this.closeWindow()
  }

  /**
   * Mark expired requests, and forget every request 5 minutes after its expiry, so the new device can still read how
   * its request ended.
   */
  private expire(): void {
    const at = this.options.now()
    for (const [id, record] of this.requests) {
      if (record.expiresAt > at) continue
      if (record.state === 'pending') record.state = 'expired'
      if (record.expiresAt + DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs <= at) this.requests.delete(id)
    }
  }
}
