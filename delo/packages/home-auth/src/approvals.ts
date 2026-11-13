/**
 * Approval requests on a route whose identity factor is `tailnet-membership`, and the approval window that admits them
 * (contract C5, "Approval request" and "Approval window").
 *
 * - **The window.** A request is accepted while the person has opened a window at the home's own computer: the
 *   loopback studio's "Add a device" or `delorun devices approve`. A window lasts the configured minutes (5 by default)
 *   and closes at the first approval.
 * - **Without a window.** A request is accepted only when it names a Tailscale identity that the `pairing`
 *   configuration allows to ask: the computer's own user by default, any user on the tailnet, or none
 *   ({@link mayAskWithoutWindow}); each identity has at most the configured number waiting. Any other request outside a
 *   window is answered `APPROVALS_CLOSED` without reading the body, because every request on this route has the source
 *   `127.0.0.1` and a standing queue could be kept full by any device on the tailnet. The identity is a quota and
 *   display hint: a local process can send it too, and gains only a waiting request that needs the code from its own
 *   screen.
 * - **The request.** Bound to the listener's studio address, it expires after the configured minutes (5 by default); a
 *   home holds at most 5 pending, and a source makes at most 10 a minute. Its state is read with its request secret at
 *   most once every 2 seconds.
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
import { formatMatchCode, matchCode, typedCodeMatches } from './match-code.ts'
import { mayAskWithoutWindow, type PairingSpec, type TailnetIdentity } from './pairing.ts'
import { hashSecret, newSecret, secretMatches, type RandomBytes } from './secret.ts'
import type { SecretSink } from '@delo/contract-operational-logs'

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
  /** The Tailscale user the request named, as a quota and display hint; undefined when it named none. */
  readonly identity: TailnetIdentity | undefined
  /** Whether the request was accepted outside an approval window. */
  readonly windowless: boolean
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
  /** The Tailscale user the request named, a hint the person compares with who they expect; null when it named none. */
  readonly identity: TailnetIdentity | null
  /** Whether the request arrived outside an approval window, which is what the studio's notice announces. */
  readonly windowless: boolean
  /** The wrong codes typed so far; the third cancels the request. */
  readonly wrongCodes: number
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
  /** The resolved pairing choices, read per call so a change in Settings applies without a restart. */
  readonly pairing: () => PairingSpec
  /** Where a request's secret and match code are registered while the request is kept; none registers nothing. */
  readonly secrets?: SecretSink | undefined
}

/** Where a request arrived and who it names. */
export interface RequestOrigin {
  readonly listener: ReachListenerId
  readonly address: StudioAddress
  readonly source: string
  /** The Tailscale user the request's headers name, if any. */
  readonly identity?: TailnetIdentity | undefined
  /** The Tailscale login of the user this computer is signed in as, when the listener's provider knows it. */
  readonly computerUser?: string | undefined
}

/** The approval window and the approval requests of one home. */
export class Approvals {
  private windowClosesAt: number | undefined
  private readonly requests = new Map<string, ApprovalRecord>()
  /** The disposers of each kept request's registered secret and match code, by request id. */
  private readonly held = new Map<string, readonly (() => void)[]>()
  private readonly sources: AttemptLimiter
  private readonly windowlessSources: AttemptLimiter
  /** The clock, the random source and the home key. */
  private readonly options: ApprovalsOptions

  /**
   * @param options - the clock, the random source and the home key.
   */
  constructor(options: ApprovalsOptions) {
    this.options = options
    const budget = { limit: DEVICE_APPROVAL_LIMITS.approvalRequestsPerMinutePerSource, windowMs: MINUTE_MS, now: options.now }
    this.sources = new AttemptLimiter(budget)
    this.windowlessSources = new AttemptLimiter(budget)
  }

  /**
   * Open the approval window, or extend an open one to the configured length from now.
   * @returns when it closes, in milliseconds since the epoch.
   */
  openWindow(): number {
    this.windowClosesAt = this.options.now() + this.options.pairing().windowMs
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
   * Refuse a request that may not be accepted now; the route calls this before it reads the body. A request is
   * accepted while a window is open, or outside one when its identity may ask without a window.
   * @param identity - the Tailscale user the request's headers name.
   * @param computerUser - the Tailscale login of the user this computer is signed in as.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` when no window is open and the identity may not ask without one.
   */
  assertMayAsk(identity?: TailnetIdentity, computerUser?: string): void {
    if (this.windowOpenUntil() !== undefined) return
    if (mayAskWithoutWindow(this.options.pairing().mayAskWithoutWindow, identity, computerUser)) return
    throw new HomeAuthError('APPROVALS_CLOSED', `This home is not accepting new devices now. On the home's computer, choose Add a device in the studio's settings, or run delorun devices approve, then try again within ${String(this.options.pairing().windowMs / MINUTE_MS)} minutes`)
  }

  /**
   * Accept one approval request.
   * @param input - the request's fields.
   * @param where - the listener, its studio address, the source the limit counts and the identity it names.
   * @returns C5's `201` answer.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` outside a window for an identity that may not ask without one;
   *   `APPROVAL_RATE_LIMITED` past the source's limit; `APPROVAL_PENDING_LIMIT` when 5 requests are pending or the
   *   identity has its limit waiting, or 4 window-less requests are.
   */
  request(input: ApprovalRequestInput, where: RequestOrigin): ApprovalRequestAccepted {
    this.assertMayAsk(where.identity, where.computerUser)
    const windowless = this.windowOpenUntil() === undefined
    this.expire()
    const pending = [...this.requests.values()].filter(record => record.state === 'pending')
    // The per-identity limit comes first, so a request it refuses spends none of the source's budget and one
    // identity's repeated asks cannot make the home refuse every other request (a person's open window included).
    if (windowless && where.identity !== undefined) {
      const login = where.identity.login
      if (pending.filter(record => record.windowless && record.identity?.login === login).length >= this.options.pairing().pendingPerIdentity) {
        throw new HomeAuthError('APPROVAL_PENDING_LIMIT', 'This account already has a device request waiting at the home\'s computer. Finish or decline it there, then try again')
      }
    }
    // Window-less requests never take the last slot, so a request through a window the person opened always has room.
    if (windowless && pending.filter(record => record.windowless).length >= DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome - 1) {
      throw new HomeAuthError('APPROVAL_PENDING_LIMIT', 'Too many devices are asking to pair without an approval window. At the home\'s computer, run delorun devices approve to approve or cancel one, then try again')
    }
    // Window-less requests have their own budget per source: every reach request arrives from one address.
    if (!(windowless ? this.windowlessSources : this.sources).take(where.source)) {
      throw new HomeAuthError('APPROVAL_RATE_LIMITED', 'Too many device requests from this address in the last minute')
    }
    if (pending.length >= DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome) {
      throw new HomeAuthError('APPROVAL_PENDING_LIMIT', 'This home has 5 device requests waiting. At the home\'s computer, run delorun devices approve to approve one or cancel one, then try again')
    }
    const nonceBytes = DEVICE_APPROVAL_LIMITS.nonceBytes
    const id = brandString<ApprovalRequestId>(newSecret(nonceBytes, this.options.random))
    const secret = brandString<Base64Url>(newSecret(nonceBytes, this.options.random))
    const homeNonce = brandString<Base64Url>(newSecret(nonceBytes, this.options.random))
    const key = this.options.homeKey()
    const createdAt = this.options.now()
    const code = matchCode({ homePublicKey: key.publicKey, deviceId: input.deviceId, homeNonce, deviceNonce: input.deviceNonce, address: where.address })
    this.hold(id, secret, code)
    const expiresAt = createdAt + this.options.pairing().requestExpiryMs
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
      identity: where.identity,
      windowless,
      code,
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
        identity: record.identity ?? null,
        windowless: record.windowless,
        wrongCodes: record.wrongCodes,
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
   * Register a request's secret and its match code with the log's redactor. The code is 8 digits, the shortest value
   * the redactor matches, and is shown in two groups of four, so both spellings are registered.
   * @param id - the request id.
   * @param secret - the request secret.
   * @param code - the 8-digit match code.
   */
  private hold(id: string, secret: string, code: string): void {
    const sink = this.options.secrets
    if (sink === undefined) return
    this.held.set(id, [
      sink.register(secret, 'session-secret'),
      sink.register(code, 'pairing-code'),
      sink.register(formatMatchCode(code), 'pairing-code'),
      sink.register(`${code.slice(0, 4)}-${code.slice(4)}`, 'pairing-code'),
    ])
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
      if (record.expiresAt + this.options.pairing().requestExpiryMs <= at) {
        this.requests.delete(id)
        for (const release of this.held.get(id) ?? []) release()
        this.held.delete(id)
      }
    }
  }
}
