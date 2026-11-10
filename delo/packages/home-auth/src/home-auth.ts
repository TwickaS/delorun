/**
 * A home's owner claim and device list: the records of `~/.delo/secrets/home-auth/` that name the owner and the trusted
 * devices, the owner-only operations over them, and the revocation that ends a device's live sessions.
 *
 * Contract C5's rules this class enforces:
 *
 * - Owner claim is accepted only on the loopback listener; a request that arrived anywhere else is refused with
 *   `OWNER_CLAIM_LOOPBACK_ONLY` before its body is read or its code compared.
 * - One home, one owner. A second claim is refused with `ALREADY_OWNED`, and the owner check and the records' writes
 *   happen under one queue, so two claims racing cannot both win the owner seat.
 * - An owner code is single-use and expires; a wrong, used or expired code receives `OWNER_CODE_INVALID`.
 * - Every owner-only operation refuses with `NO_OWNER` on a home nobody has claimed, rather than acting on an empty
 *   list, and refuses with `STORE_INVALID` when `owner.json` and `devices.json` disagree about which home they describe.
 * - A session is minted only for a recorded device at the address it is trusted on, and stays live only while that record
 *   is there, so a revoked device's token answers nothing even if its session record survives.
 * - Revoking a device removes its record, invalidates every live session of its tokens and closes the reach connections
 *   those sessions admitted, before the call returns.
 *
 * @module @delo/home-auth
 */
import { mkdir } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { join } from 'node:path'
import { SESSION_LIMITS, SESSION_STORE_PERSIST_MS, type DeviceId, type ListenerId, type ReachListenerId, type SessionId, type StudioAddress } from '@delo/contract-admission'
import {
  DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION, HOME_AUTH_FILES, LOCAL_APPROVER, type ApprovalRequestAccepted,
  type ApprovalRequestState, type DevicePublicKeyJwk,
} from '@delo/contract-device-approval'
import { TAILNET_MEMBERSHIP_OPTIONS, type IdentityFactor } from '@delo/contract-oidc-passkeys'
import { REACH_OPTION_LISTENERS } from '@delo/contract-reach-providers'
import { Approvals, type ApprovalRequestInput, type PendingSummary } from './approvals.ts'
import { isLoopbackHost, listenerOf, type LoopbackPort, type StampedRequest } from './arrival.ts'
import { DeviceStore } from './devices.ts'
import { HomeAuthError } from './errors.ts'
import { readStoreFile, writeStoreFile } from './files.ts'
import { AttemptLimiter } from './rate-limit.ts'
import { OwnerCodeStore, type IssuedOwnerCode } from './owner-code.ts'
import { claimLabelOf, deviceIdOf, devicePublicKeyOf, ownerRecordOf, type DeviceRecord, type OwnerRecord } from './records.ts'
import { SESSIONS_FILE, SessionStore, type OpenSessionRequest, type OpenedSession, type SessionRecord } from './sessions.ts'
import { SESSION_TOKEN_BYTES, hashSecret, newSecret, systemRandom, type RandomBytes } from './secret.ts'
import { loadHomeKey, type HomeKey } from './home-key.ts'
import { Challenges, signInVerifies } from './sign-in.ts'

/** The length of one claim attempt window: a minute, which is C5's owner claim limit. */
const CLAIM_WINDOW_MS = 60 * 1000

/** The device list a studio shows. */
export interface DevicesListing {
  /** Who owns the home and when they claimed it. */
  readonly owner: OwnerSummary
  /** The trusted devices, in the order they became trusted. */
  readonly devices: readonly DeviceSummary[]
}

/** The public half of the owner record. */
export interface OwnerSummary {
  /** When the home was claimed, in milliseconds since the epoch. */
  readonly claimedAt: number
  /** The device that claimed the home, or `local` for a local claim. */
  readonly firstDeviceId: OwnerRecord['firstDeviceId']
}

/** One row of the device list: a device's record without its public key. */
export interface DeviceSummary {
  /** The device id. */
  readonly id: DeviceId
  /** The name the person gave the device. */
  readonly label: string
  /** The browser and operating system the page read; empty for a claim. */
  readonly platform: string
  /** The studio address the device is trusted on. */
  readonly address: StudioAddress
  /** When the device became trusted, in milliseconds since the epoch. */
  readonly approvedAt: number
  /** The device that approved it, `local` for an approval at the home's own computer, or null for the claiming device. */
  readonly approvedBy: DeviceRecord['approvedBy']
  /** When it last signed in, or null before its first sign-in. */
  readonly lastSignInAt: number | null
}

/** Where a claim arrived: the two checks that say whether it is a loopback claim, and the source a limit counts. */
export interface ClaimArrival {
  /** The listener the request arrived on, or `undefined` for an unstamped request; a claim is accepted on `loopback` only. */
  readonly listener: ListenerId | undefined
  /** The request's `Host` header, which must name loopback too. */
  readonly host: string | undefined
  /** The source the per-source limit counts, such as the socket peer address. */
  readonly source: string
}

/** One owner claim: C5's `POST /auth/owner/claim` body, and where the request arrived. */
export interface ClaimRequest extends ClaimArrival {
  /** The code the person read in their terminal, in either case and with spaces or hyphens. */
  readonly ownerCode: string
  /** The claiming device's public key. */
  readonly devicePublicKey: DevicePublicKeyJwk
  /** The name the person gives the device. */
  readonly label: string
  /** The studio address the claiming device is bound to. */
  readonly address: StudioAddress
}

/** A claimed home: the records the claim wrote. */
export interface ClaimResult {
  /** The owner record now on disk. */
  readonly owner: OwnerRecord
  /** The claiming device's record, now the home's first trusted device. */
  readonly device: DeviceRecord
}

/** What revoking a device did. */
export interface RevocationResult {
  /** Whether the device had a record, which was removed. */
  readonly removed: boolean
  /** How many live sessions of the device were invalidated. */
  readonly sessions: number
  /** How many reach connections those sessions admitted were closed. */
  readonly connections: number
}

/**
 * A reach listener a reach provider asked this home to serve: its id, its studio address and the identity factor the
 * provider declares for it (contract C7, "Provider Service Definition").
 */
export interface ServedListener {
  readonly listener: ReachListenerId
  readonly address: StudioAddress
  /** The factor a session created on this listener records. */
  readonly factor: IdentityFactor
}

/** What `admit` reads for one session token: the admitted session, or the refusal C4 names. */
export type TokenAdmission =
  | {
    readonly kind: 'admitted'
    readonly sessionId: SessionId
    readonly session: SessionRecord
    /** The new token a roll minted, for the dispatcher's `Set-Cookie`. */
    readonly rolled?: { readonly token: string; readonly expiresAt: number }
  }
  | { readonly kind: 'refused'; readonly code: 'NOT_SIGNED_IN' | 'SESSION_EXPIRED' | 'ROTATION_REQUIRED' }

/** A session sign-in created, with the absolute expiry its cookie needs. */
export type SignedIn = OpenedSession

/** One `POST /auth/session` after its fields were read. */
export interface SignInRequest {
  readonly deviceId: DeviceId
  readonly challenge: string
  readonly signature: string
  /** The listener the request was admitted on. */
  readonly listener: ReachListenerId
  /** The session token the request's cookie carries, which the new session replaces when it is this device's here. */
  readonly rotate?: string
}

/** The in-memory copy of the stores that the synchronous `admit` reads. */
interface AdmissionView {
  readonly sessions: Map<string, SessionRecord>
  readonly devices: Map<string, DeviceRecord>
}

/** What a home-auth instance reads and writes. */
export interface HomeAuthOptions {
  /** The absolute path of the secrets directory, `~/.delo/secrets/home-auth`. */
  readonly directory: string
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The random source; the operating system's by default. */
  readonly random?: RandomBytes
  /**
   * Ends the reach connections a session or a device admitted. The provider passes Connection's
   * `closeReachConnections`; a home with no reach listener passes nothing.
   */
  readonly closeReachConnections?: (match: { readonly deviceId?: string; readonly sessionId?: string }) => number
  /** The owner claim attempts one source may make a minute; C5's limit by default. */
  readonly claimAttemptsPerMinute?: number
  /**
   * The loopback listener's bound port, which identifies an unstamped request as a loopback one. Without it no request is
   * a loopback request.
   */
  readonly loopbackPort?: LoopbackPort
}

/**
 * The owner claim and device list of one home.
 *
 * The instance holds no state of its own besides the claim limit: every answer is read from the protected files of
 * {@link HomeAuthOptions.directory}, so two callers in one process never disagree and a restart keeps the answer.
 */
export class HomeAuth {
  /** The absolute path of the secrets directory. */
  readonly directory: string
  private readonly ownerCodes: OwnerCodeStore
  private readonly deviceStore: DeviceStore
  private readonly sessions: SessionStore
  private readonly claims: AttemptLimiter
  private readonly now: () => number
  private readonly closeReachConnections: HomeAuthOptions['closeReachConnections']
  private readonly loopbackPort: LoopbackPort
  private readonly random: RandomBytes
  private readonly served = new Map<ReachListenerId, ServedListener>()
  private readonly challenges: Challenges
  /** The approval window and its requests. */
  readonly approvals: Approvals
  private homeKey: HomeKey | undefined
  /** What `admit` reads; undefined until the stores were read, and after a read failed, so `admit` refuses. */
  private view: AdmissionView | undefined
  /** Last-use times `admit` saw that are not on file yet. */
  private readonly touched = new Map<string, number>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private readonly removalListeners = new Set<(deviceId: DeviceId) => void>()
  /** The tail of the queue that serialises a claim and a revocation against each other. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param options - the directory, the clock, the random source, the reach closer and the claim limit.
   */
  constructor(options: HomeAuthOptions) {
    this.directory = options.directory
    this.now = options.now ?? Date.now
    this.closeReachConnections = options.closeReachConnections
    this.loopbackPort = options.loopbackPort ?? (() => undefined)
    this.random = options.random ?? systemRandom
    this.challenges = new Challenges(this.now, this.random)
    this.approvals = new Approvals({ now: this.now, random: this.random, homeKey: () => this.key() })
    const path = (name: string): string => join(options.directory, name)
    this.ownerCodes = new OwnerCodeStore({ file: path(HOME_AUTH_FILES.ownerCode), ...timed(options) })
    this.deviceStore = new DeviceStore({ file: path(HOME_AUTH_FILES.devices) })
    this.sessions = new SessionStore({ file: path(SESSIONS_FILE), ...timed(options) })
    this.claims = new AttemptLimiter({
      limit: options.claimAttemptsPerMinute ?? DEVICE_APPROVAL_LIMITS.ownerClaimAttemptsPerMinutePerSource,
      windowMs: CLAIM_WINDOW_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  /**
   * Create the secrets directory at mode 0700, as contract C1 requires of every directory under `secrets/`.
   * @throws the filesystem failure of `mkdir`.
   */
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.homeKey = await loadHomeKey(this.directory)
    await this.refresh()
  }

  /**
   * Write the last-use times `admit` recorded, stop the timer that writes them and wait for the queued changes; the
   * provider calls this when it stops, as C4 requires of the session store.
   */
  async stop(): Promise<void> {
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    await this.persistTouched()
    // Wait for the changes already queued, such as the removal of an expired session.
    await this.serial(() => Promise.resolve())
  }

  /**
   * Print a new owner code, replacing the one that was outstanding. The caller prints the code once and registers it as
   * a secret with the operational log's redactor; no store keeps it.
   * @returns the code and its expiry.
   */
  async issueOwnerCode(): Promise<IssuedOwnerCode> {
    return this.ownerCodes.issue()
  }

  /**
   * Whether an owner code is outstanding and unexpired.
   * @returns whether a claim has a code to compare against.
   */
  async ownerCodeOutstanding(): Promise<boolean> {
    return this.ownerCodes.outstanding()
  }

  /**
   * Claim the home for a device, as C5's owner claim does.
   *
   * The order of the refusals is the contract's: the arrival first, so a reach request learns nothing and is answered
   * without its body; then the per-source limit; then the message; then the owner that would be displaced; then the
   * code, which is consumed only when it matches.
   * @param request - the claim message and where it arrived.
   * @returns the owner and device records the claim wrote.
   * @throws {HomeAuthError} `OWNER_CLAIM_LOOPBACK_ONLY` for any arrival other than loopback, including a request whose
   *   `Host` names a reach address; `OWNER_CLAIM_RATE_LIMITED` past the per-source limit; `BAD_REQUEST` for a
   *   malformed message; `ALREADY_OWNED` for a home that has an owner; `OWNER_CODE_INVALID` for a wrong, used or
   *   expired code.
   */
  async claim(request: ClaimRequest): Promise<ClaimResult> {
    if (request.listener !== 'loopback' || !isLoopbackHost(request.host)) {
      throw new HomeAuthError('OWNER_CLAIM_LOOPBACK_ONLY', 'Claim the home on its own computer, at the loopback listener, or through SSH port forwarding to it; a reach address cannot claim a home')
    }
    if (!this.claims.take(request.source)) {
      throw new HomeAuthError('OWNER_CLAIM_RATE_LIMITED', 'Too many claim attempts from this address in the last minute')
    }
    const label = claimLabelOf(request.label)
    const publicKey = devicePublicKeyOf(request.devicePublicKey, 'BAD_REQUEST')
    return this.changing(() => this.claimSerially(request, label, publicKey))
  }

  /**
   * The owner record, or undefined for a home nobody has claimed.
   * @returns the record.
   * @throws {HomeAuthError} `STORE_INVALID` when owner.json is not a version 1 owner record.
   */
  async owner(): Promise<OwnerRecord | undefined> {
    return ownerRecordOf(await readStoreFile(join(this.directory, HOME_AUTH_FILES.owner)))
  }

  /**
   * The owner record, refusing a home that nobody has claimed.
   *
   * The owner record and the device list are cross-checked here too, so every owner-only operation that starts with this
   * call refuses records that describe different homes: a copied `owner.json` naming a first device this home does not
   * record is a `STORE_INVALID` failure rather than an owner, and no listing, session or removal acts for it. A home
   * whose devices were all removed is consistent, because a removed device leaves no record to disagree with.
   * @returns the record.
   * @throws {HomeAuthError} `NO_OWNER` when the home has no owner: the refusal every owner-only operation starts with,
   *   so an unclaimed home never answers as if it had an empty owner and an empty device list.
   * @throws {HomeAuthError} `STORE_INVALID` when `owner.json` names a first device that `devices.json` does not record.
   */
  async assertOwner(): Promise<OwnerRecord> {
    const owner = await this.owner()
    if (owner === undefined) {
      throw new HomeAuthError('NO_OWNER', 'This home has no owner yet. Claim it on the home\'s own computer with the owner code that `delorun setup` printed')
    }
    const records = await this.deviceStore.list()
    if (owner.firstDeviceId !== LOCAL_APPROVER && records.length > 0 && !records.some(record => record.id === owner.firstDeviceId)) {
      throw new HomeAuthError('STORE_INVALID', 'owner.json names a first device that devices.json does not record')
    }
    return owner
  }

  /**
   * The device list the studio shows: the owner and every trusted device.
   * @returns the listing.
   * @throws {HomeAuthError} `NO_OWNER` for an unclaimed home; `STORE_INVALID` for a store file that is not this
   *   package's JSON.
   */
  async devices(): Promise<DevicesListing> {
    const owner = await this.assertOwner()
    const records = await this.deviceStore.list()
    return {
      owner: { claimedAt: owner.claimedAt, firstDeviceId: owner.firstDeviceId },
      devices: records.map(summaryOf),
    }
  }

  /**
   * Revoke a device: remove its record, invalidate every live session of its tokens, and close the reach connections
   * those sessions admitted. A device that has no record changes nothing but still has its sessions ended.
   *
   * The sessions of every other device are left live: C5's "Removal" also rotates them, and this home does not rotate a
   * session yet (see the README's note on rotation), so a removal ends exactly the removed device's sessions and
   * invalidates no other credential. Until rotation exists, a removal is the one operation whose blast radius is the
   * device it names.
   * @param deviceId - the device.
   * @returns what was removed, invalidated and closed.
   * @throws {HomeAuthError} `NO_OWNER` for an unclaimed home, which closes no connection and removes nothing.
   */
  async revokeDevice(deviceId: DeviceId): Promise<RevocationResult> {
    return this.changing(async () => {
      await this.assertOwner()
      const removed = await this.deviceStore.remove(deviceId)
      const sessions = await this.sessions.revokeDevice(deviceId)
      // C4: a removal rotates every other session, so a device that kept a copy of the removed one's cookie gains nothing.
      await this.sessions.rotateAll()
      this.forget(deviceId)
      for (const listener of this.removalListeners) listener(deviceId)
      const connections = this.closeReachConnections?.({ deviceId }) ?? 0
      return { removed, sessions, connections }
    })
  }

  /**
   * Mint a session token for a device and record the session under its digest.
   *
   * A session speaks for a trusted device at the address it is trusted on and nothing else, so the home refuses to mint
   * one for an id it does not record, for a device recorded at another address, and for a home with no owner at all. The
   * check runs in the same queue as a revocation, so a removal that has started cannot be outrun by a mint that read the
   * device a moment earlier.
   * @param request - the device, the address and the lifetime.
   * @returns the session id and the token, which no store keeps.
   * @throws {HomeAuthError} `NO_OWNER` for an unclaimed home; `STORE_INVALID` for a store file that is not this
   *   package's JSON; `DEVICE_NOT_TRUSTED` when no record names this device for this address.
   */
  async openSession(request: OpenSessionRequest): Promise<OpenedSession> {
    return this.changing(async () => {
      await this.assertOwner()
      const device = await this.deviceStore.find(request.deviceId)
      if (device === undefined || device.address !== request.address) {
        throw new HomeAuthError(
          'DEVICE_NOT_TRUSTED',
          'This home does not trust that device on that address. Approve the device on the address it signs in on',
          { deviceId: request.deviceId, address: request.address },
        )
      }
      return this.sessions.open(request)
    })
  }

  /**
   * The live session a token names.
   *
   * A session is live while its token is unexpired and its device is still recorded at the session's address. The device
   * record is what a revocation deletes, so a token minted for a device the home no longer trusts stops answering even
   * when its record survived — a session store that was written by hand, or one whose record the fast path of a removal
   * missed, still answers with no session.
   * @param token - the token as presented.
   * @returns the record, or undefined for an unknown or expired token, or for a device that is no longer trusted at the
   *   session's address.
   */
  async sessionOf(token: string): Promise<SessionRecord | undefined> {
    const session = await this.sessions.authenticate(token)
    if (session === undefined) return undefined
    const device = await this.deviceStore.find(session.deviceId)
    if (device === undefined || device.address !== session.address) return undefined
    return session
  }

  /**
   * Where a request arrived, read from an HTTP request: the listener that admitted it, failing closed, the `Host` header
   * and the socket peer.
   * @param request - the request, which may carry a reach listener's stamp.
   * @returns the arrival.
   */
  arrivalOf(request: StampedRequest & {
    readonly headers: { readonly host?: string | undefined }
    readonly socket: { readonly remoteAddress?: string | undefined; readonly localAddress?: string | undefined; readonly localPort?: number | undefined }
  }): ClaimArrival {
    return {
      listener: listenerOf(request, this.loopbackPort),
      host: request.headers.host,
      source: request.socket.remoteAddress ?? 'unknown',
    }
  }


  // Reach: served listeners, the approval window, sign-in and admission

  /**
   * Call a listener for each removed device, after its sessions are gone and before the removal returns; the provider
   * disposes the device's Peers with it.
   * @param listener - called with the removed device's id.
   * @returns the disposer.
   */
  onDeviceRemoved(listener: (deviceId: DeviceId) => void): () => void {
    this.removalListeners.add(listener)
    return () => { this.removalListeners.delete(listener) }
  }

  /**
   * Serve one reach listener for a reach provider, with the identity factor the provider declares for it.
   * @param served - the listener, its address and the declared factor.
   * @returns the disposer, which stops serving it.
   * @throws {HomeAuthError} `TAILNET_IDENTITY_UNAVAILABLE` when the factor is `tailnet-membership` and the listener is not
   *   one whose option C14 allows it for, or the address is not a `ts.net` address; `BAD_REQUEST` for any other factor,
   *   because this home builds no passkey or OpenID Connect sign-in; `BAD_REQUEST` when the listener is served already.
   */
  serve(served: ServedListener): () => void {
    if (served.factor !== 'tailnet-membership') {
      throw new HomeAuthError('BAD_REQUEST', `this home signs in on a reach address only with tailnet-membership; ${served.factor} is not built`)
    }
    const allowed = TAILNET_MEMBERSHIP_OPTIONS.some(option => REACH_OPTION_LISTENERS[option] === served.listener)
    const host = URL.parse(served.address)?.hostname ?? ''
    if (!allowed || !host.endsWith('.ts.net')) {
      throw new HomeAuthError('TAILNET_IDENTITY_UNAVAILABLE', 'Tailnet membership signs a device in only on the Tailscale private address; a Funnel or own-domain address needs a passkey or OpenID Connect sign-in')
    }
    if (this.served.has(served.listener)) throw new HomeAuthError('BAD_REQUEST', `${served.listener} is served already`)
    this.served.set(served.listener, served)
    return () => {
      if (this.served.get(served.listener) === served) this.served.delete(served.listener)
    }
  }

  /**
   * The reach listener a provider asked this home to serve.
   * @param listener - the listener id.
   * @returns its address and factor, or undefined when no provider serves it.
   */
  servedListener(listener: string): ServedListener | undefined {
    return this.served.get(listener as ReachListenerId)
  }

  /**
   * Open the approval window, claiming the home for the local person when it has no owner yet (C5's local claim). Only
   * the home's own computer calls this: the loopback studio's routes and the home socket's `devices.approve`.
   * @returns when the window closes.
   * @throws {HomeAuthError} `STORE_INVALID` when the home records devices but no owner.
   */
  async openApprovalWindow(): Promise<number> {
    await this.serial(() => this.claimLocally())
    return this.approvals.openWindow()
  }

  /**
   * Accept one approval request on a served reach listener.
   * @param input - the request's fields.
   * @param where - the listener and the source the limit counts.
   * @returns C5's `201` answer.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` outside a window; `NO_OWNER`; `DEVICE_NOT_TRUSTED` for a listener no
   *   provider serves; the limits of {@link Approvals.request}.
   */
  async requestApproval(input: ApprovalRequestInput, where: { readonly listener: ReachListenerId; readonly source: string }): Promise<ApprovalRequestAccepted> {
    this.approvals.assertWindowOpen()
    await this.assertOwner()
    const served = this.servedOrRefuse(where.listener)
    return this.approvals.request(input, { listener: where.listener, address: served.address, source: where.source })
  }

  /**
   * The state of one approval request.
   * @param id - the request id.
   * @param secret - its request secret.
   * @returns the state.
   */
  approvalState(id: string, secret: string): ApprovalRequestState {
    return this.approvals.state(id, secret)
  }

  /**
   * The pending requests the local approval form shows.
   * @returns their summaries.
   */
  pendingApprovals(): readonly PendingSummary[] {
    return this.approvals.pending()
  }

  /**
   * C5's local approval: record the requesting device with the approver `local`, rotate every session and close the
   * window. Only the home's own computer calls this.
   * @param requestId - the request.
   * @param typedCode - the match code the person typed.
   * @returns the new device's record.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED`, `APPROVAL_CODE_MISMATCH`, `NO_OWNER`, `DEVICE_LIMIT_REACHED`.
   */
  async approveLocally(requestId: string, typedCode: string): Promise<DeviceRecord> {
    return this.changing(async () => {
      await this.assertOwner()
      const request = this.approvals.check(requestId, typedCode)
      const device: DeviceRecord = {
        v: DEVICE_APPROVAL_VERSION,
        id: request.deviceId,
        publicKey: request.devicePublicKey,
        address: request.address,
        label: request.label,
        platform: request.platform,
        approvedAt: this.now(),
        approvedBy: LOCAL_APPROVER,
        lastSignInAt: null,
      }
      await this.deviceStore.add(device)
      this.approvals.approved(request)
      // C4: a device approval rotates every session of the home.
      await this.sessions.rotateAll()
      return device
    })
  }

  /**
   * Issue a sign-in challenge to a device trusted on a served listener's address.
   * @param deviceId - the device.
   * @param listener - the listener the request was admitted on.
   * @returns the challenge.
   * @throws {HomeAuthError} `DEVICE_NOT_TRUSTED` when no record names the device at the listener's address.
   */
  async challenge(deviceId: DeviceId, listener: ReachListenerId): Promise<string> {
    const served = this.servedOrRefuse(listener)
    const device = await this.deviceStore.find(deviceId)
    if (device?.address !== served.address) throw this.notTrusted(deviceId, served.address)
    await this.assertOwner()
    return this.challenges.issue(deviceId)
  }

  /**
   * Create a session from a device-key signature over a fresh challenge (C5, "Sign-in"), or rotate one (C4). On a
   * `tailnet-membership` listener the signature of an approved device alone creates a full session with that factor.
   * @param request - the signed request and the listener it was admitted on.
   * @returns the session and its absolute expiry.
   * @throws {HomeAuthError} `DEVICE_NOT_TRUSTED` for a device with no record at the listener's address;
   *   `CHALLENGE_INVALID` for a reused, expired or foreign challenge or a signature that does not verify.
   */
  async signIn(request: SignInRequest): Promise<SignedIn> {
    const served = this.servedOrRefuse(request.listener)
    return this.changing(async () => {
      const device = await this.deviceStore.find(request.deviceId)
      if (device?.address !== served.address) throw this.notTrusted(request.deviceId, served.address)
      await this.assertOwner()
      // The challenge is used up whether or not the signature verifies, so a failed attempt cannot be replayed.
      const fresh = this.challenges.consume(request.deviceId, request.challenge)
      if (!fresh || !signInVerifies(device.publicKey, served.address, request.challenge, request.signature)) {
        throw new HomeAuthError('CHALLENGE_INVALID', 'That sign-in challenge is used, expired or not signed by this device. Ask for a new one')
      }
      // A rotation replaces the session the cookie names when it is this device's on this listener; any other cookie,
      // such as one of a removed or expired session, is left alone and the signature creates a fresh session.
      let replaces: SessionId | undefined
      if (request.rotate !== undefined) {
        const old = await this.sessions.authenticate(request.rotate)
        if (old?.deviceId === request.deviceId && old.listener === request.listener) replaces = brandString<SessionId>(hashSecret(request.rotate))
      }
      const opened = await this.sessions.open({
        deviceId: request.deviceId,
        listener: request.listener,
        address: served.address,
        factor: served.factor,
        lifetimeMs: SESSION_LIMITS.reach.absoluteMs,
        ...(replaces === undefined ? {} : { replaces }),
      })
      await this.deviceStore.write((await this.deviceStore.list()).map(record => record.id === device.id ? { ...record, lastSignInAt: this.now() } : record))
      return opened
    })
  }

  /**
   * Admit one session token on one reach listener, synchronously over the in-memory copy of the stores (C4's `admit`).
   * A session is admitted only on the listener it was created on, while its device is recorded at its address, before
   * its idle limit of 12 hours and its absolute limit, and while no rotation trigger fired since it was minted.
   * @param token - the token from the session cookie.
   * @param listener - the listener the request arrived on.
   * @returns the admitted session, or the refusal.
   */
  admitToken(token: string, listener: ReachListenerId, options: { readonly roll: boolean } = { roll: false }): TokenAdmission {
    const view = this.view
    if (view === undefined) return { kind: 'refused', code: 'NOT_SIGNED_IN' }
    const sessionId = hashSecret(token)
    const session = view.sessions.get(sessionId)
    if (session?.listener !== listener) return { kind: 'refused', code: 'NOT_SIGNED_IN' }
    const device = view.devices.get(session.deviceId)
    if (device?.address !== session.address) return { kind: 'refused', code: 'NOT_SIGNED_IN' }
    const at = this.now()
    if (at >= session.expiresAt || at - session.lastUsedAt >= SESSION_LIMITS.reach.idleMs) {
      view.sessions.delete(sessionId)
      void this.serial(() => this.sessions.remove([sessionId])).catch(() => undefined)
      return { kind: 'refused', code: 'SESSION_EXPIRED' }
    }
    if (session.rotated) return { kind: 'refused', code: 'ROTATION_REQUIRED' }
    if (session.graceUntil !== undefined && at >= session.graceUntil) {
      view.sessions.delete(sessionId)
      void this.serial(() => this.sessions.remove([sessionId])).catch(() => undefined)
      return { kind: 'refused', code: 'NOT_SIGNED_IN' }
    }
    const used = { ...session, lastUsedAt: at }
    view.sessions.set(sessionId, used)
    if (options.roll && session.graceUntil === undefined && at - session.lastRolledAt >= SESSION_LIMITS.reach.rollAfterMs) {
      return this.roll(view, sessionId, used, at)
    }
    this.touch(sessionId, at)
    return { kind: 'admitted', sessionId: brandString<SessionId>(sessionId), session: used }
  }

  /**
   * Roll a session (C4, "Sessions"): mint a new token with the same creation time and absolute expiry, keep the old one
   * for 30 seconds for requests in flight, and write both within the store's persistence delay.
   * @param view - the in-memory copy.
   * @param oldId - the session id being rolled.
   * @param used - its record as this request used it.
   * @param at - the time.
   * @returns the admission, carrying the new token.
   */
  private roll(view: AdmissionView, oldId: string, used: SessionRecord, at: number): TokenAdmission {
    const token = newSecret(SESSION_TOKEN_BYTES, this.random)
    const newId = hashSecret(token)
    const graceUntil = at + SESSION_LIMITS.reach.rollGraceMs
    const record: SessionRecord = { ...used, lastRolledAt: at }
    view.sessions.set(oldId, { ...used, graceUntil })
    view.sessions.set(newId, record)
    void this.serial(() => this.sessions.roll(oldId, graceUntil, newId, record)).catch(() => undefined)
    return { kind: 'admitted', sessionId: brandString<SessionId>(newId), session: record, rolled: { token, expiresAt: record.expiresAt } }
  }

  /**
   * Record a session's last use and write it within the store's persistence delay.
   * @param sessionId - the session id.
   * @param at - the time.
   */
  private touch(sessionId: string, at: number): void {
    this.touched.set(sessionId, at)
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = undefined
      void this.persistTouched().catch(() => undefined)
    }, SESSION_STORE_PERSIST_MS)
    this.persistTimer.unref()
  }

  /**
   * Write the claim of the local person, when the home has no owner. A home that has one keeps it.
   * @throws {HomeAuthError} `STORE_INVALID` when the home records devices but no owner.
   */
  private async claimLocally(): Promise<void> {
    if (await this.owner() !== undefined) return
    if ((await this.deviceStore.list()).length > 0) {
      throw new HomeAuthError('STORE_INVALID', 'devices.json records trusted devices for a home that owner.json says has no owner')
    }
    const owner: OwnerRecord = { v: DEVICE_APPROVAL_VERSION, claimedAt: this.now(), firstDeviceId: LOCAL_APPROVER, identities: [] }
    await writeStoreFile(join(this.directory, HOME_AUTH_FILES.owner), owner)
  }

  /**
   * The served listener a reach request arrived on.
   * @param listener - the listener id.
   * @returns its declaration.
   * @throws {HomeAuthError} `DEVICE_NOT_TRUSTED` when no provider serves it, which no admitted request can reach.
   */
  private servedOrRefuse(listener: ReachListenerId): ServedListener {
    const served = this.served.get(listener)
    if (served === undefined) throw new HomeAuthError('DEVICE_NOT_TRUSTED', 'This address is not served by this home')
    return served
  }

  /**
   * The refusal of a device the home does not trust at an address.
   * @param deviceId - the device.
   * @param address - the address.
   * @returns the error.
   */
  private notTrusted(deviceId: DeviceId, address: StudioAddress): HomeAuthError {
    return new HomeAuthError('DEVICE_NOT_TRUSTED', 'This home does not trust that device on this address. Ask for approval at the home\'s computer', { deviceId, address })
  }

  /**
   * Drop a removed device's sessions from the in-memory copy at once, before the stores are read again.
   * @param deviceId - the device.
   */
  private forget(deviceId: DeviceId): void {
    const view = this.view
    if (view === undefined) return
    view.devices.delete(deviceId)
    for (const [id, session] of view.sessions) {
      if (session.deviceId === deviceId) view.sessions.delete(id)
    }
  }

  /** The loaded home key. */
  private key(): HomeKey {
    if (this.homeKey === undefined) throw new HomeAuthError('STORE_INVALID', 'the home key is not loaded; the home has not started')
    return this.homeKey
  }

  /** Read the stores into the in-memory copy `admit` reads; a failed read leaves no copy, so `admit` refuses. */
  private async refresh(): Promise<void> {
    try {
      const [sessions, devices] = await Promise.all([this.sessions.all(), this.deviceStore.list()])
      const view: AdmissionView = { sessions: new Map(Object.entries(sessions)), devices: new Map(devices.map(device => [device.id, device])) }
      for (const [id, at] of this.touched) {
        const session = view.sessions.get(id)
        if (session !== undefined && session.lastUsedAt < at) view.sessions.set(id, { ...session, lastUsedAt: at })
      }
      this.view = view
    } catch (error) {
      this.view = undefined
      throw error
    }
  }

  /** Write the recorded last-use times. */
  private async persistTouched(): Promise<void> {
    if (this.touched.size === 0) return
    const used = new Map(this.touched)
    this.touched.clear()
    await this.serial(() => this.sessions.touch(used))
  }

  /**
   * Run a change in the queue, then read the stores into the in-memory copy whatever the change did, so `admit` sees
   * it before the change returns.
   * @param change - the change.
   * @returns the change's result.
   */
  private changing<T>(change: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      try {
        return await change()
      } finally {
        await this.refresh().catch(() => undefined)
      }
    })
  }

  /**
   * Write the owner and device records of a validated claim, inside the queue.
   * @param request - the claim.
   * @param label - the validated label.
   * @param publicKey - the validated device public key.
   * @returns the records written.
   * @throws {HomeAuthError} `ALREADY_OWNED` for a home that has an owner; `STORE_INVALID` when the home records trusted
   *   devices but no owner, which no claim may append to; `OWNER_CODE_INVALID` for a wrong, used or expired code.
   */
  private async claimSerially(request: ClaimRequest, label: string, publicKey: DevicePublicKeyJwk): Promise<ClaimResult> {
    const existing = await this.owner()
    if (existing !== undefined) {
      throw new HomeAuthError('ALREADY_OWNED', 'This home has an owner already', { firstDeviceId: existing.firstDeviceId })
    }
    // A home with no owner records no device: a device list that is not empty belongs to an owner whose record is gone,
    // and appending to it would make this claim the owner of devices the person never approved here.
    const records = await this.deviceStore.list()
    if (records.length > 0) {
      throw new HomeAuthError('STORE_INVALID', 'devices.json records trusted devices for a home that owner.json says has no owner')
    }
    const device: DeviceRecord = {
      v: DEVICE_APPROVAL_VERSION,
      id: deviceIdOf(publicKey),
      publicKey,
      address: request.address,
      label,
      platform: '',
      approvedAt: this.now(),
      approvedBy: null,
      lastSignInAt: null,
    }
    // The code is consumed before anything is written: a code that claimed a home never claims a second one, even when
    // the write that follows fails.
    if (!(await this.ownerCodes.consume(request.ownerCode))) {
      throw new HomeAuthError('OWNER_CODE_INVALID', 'That owner code is wrong, was used already or expired. Run `delorun devices code` in a terminal for a new one')
    }
    const owner: OwnerRecord = {
      v: DEVICE_APPROVAL_VERSION,
      claimedAt: device.approvedAt,
      firstDeviceId: device.id,
      identities: [],
    }
    await this.deviceStore.write([device])
    try {
      await writeStoreFile(join(this.directory, HOME_AUTH_FILES.owner), owner)
    } catch (error) {
      // The home must not read as owned by a device it did not record: put the device list back and let the claim
      // fail, and the person print a new code. A restore that fails too is the failure the claim reports.
      await this.deviceStore.write(records)
      throw error
    }
    return { owner, device }
  }

  /**
   * Run a change after the changes queued before it, whatever those did, so one claim or revocation at a time decides
   * what the home holds. Use {@link changing} for a change `admit` must see.
   * @param change - the change.
   * @returns the change's result.
   */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change)
    this.queue = next
    return next
  }
}

/**
 * The public row of a device record.
 * @param record - the record.
 * @returns its fields, without the public key.
 */
function summaryOf(record: DeviceRecord): DeviceSummary {
  return {
    id: record.id,
    label: record.label,
    platform: record.platform,
    address: record.address,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    lastSignInAt: record.lastSignInAt,
  }
}

/**
 * The clock and the random source of an instance, as the stores take them.
 * @param options - the instance's options.
 * @returns the two overrides the options set.
 */
function timed(options: HomeAuthOptions): { readonly now?: () => number; readonly random?: RandomBytes } {
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
  }
}
