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
import { join } from 'node:path'
import type { DeviceId, ListenerId, StudioAddress } from '@delo/contract-admission'
import {
  DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION, HOME_AUTH_FILES, type DevicePublicKeyJwk,
} from '@delo/contract-device-approval'
import { isLoopbackHost, listenerOf, type StampedRequest } from './arrival.ts'
import { DeviceStore } from './devices.ts'
import { HomeAuthError } from './errors.ts'
import { readStoreFile, writeStoreFile } from './files.ts'
import { AttemptLimiter } from './rate-limit.ts'
import { OwnerCodeStore, type IssuedOwnerCode } from './owner-code.ts'
import { claimLabelOf, deviceIdOf, devicePublicKeyOf, ownerRecordOf, type DeviceRecord, type OwnerRecord } from './records.ts'
import { SESSIONS_FILE, SessionStore, type OpenSessionRequest, type OpenedSession, type SessionRecord } from './sessions.ts'
import type { RandomBytes } from './secret.ts'

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
  /** The device that claimed the home. */
  readonly firstDeviceId: DeviceId
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
  /** The device that approved it, or null for the device that claimed the home. */
  readonly approvedBy: DeviceId | null
  /** When it last signed in, or null before its first sign-in. */
  readonly lastSignInAt: number | null
}

/** Where a claim arrived: the two checks that say whether it is a loopback claim, and the source a limit counts. */
export interface ClaimArrival {
  /** The listener the request arrived on; a claim is accepted on `loopback` only. */
  readonly listener: ListenerId
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
  /** The tail of the queue that serialises a claim and a revocation against each other. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param options - the directory, the clock, the random source, the reach closer and the claim limit.
   */
  constructor(options: HomeAuthOptions) {
    this.directory = options.directory
    this.now = options.now ?? Date.now
    this.closeReachConnections = options.closeReachConnections
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
    return this.serial(() => this.claimSerially(request, label, publicKey))
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
    if (records.length > 0 && !records.some(record => record.id === owner.firstDeviceId)) {
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
    return this.serial(async () => {
      await this.assertOwner()
      const removed = await this.deviceStore.remove(deviceId)
      const sessions = await this.sessions.revokeDevice(deviceId)
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
    return this.serial(async () => {
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
   * Where a claim arrived, read from an HTTP request: the listener a dispatcher stamped, the `Host` header and the
   * socket peer.
   * @param request - the request, which may carry a reach listener's stamp.
   * @returns the arrival.
   */
  static arrivalOf(request: StampedRequest & {
    readonly headers: { readonly host?: string | undefined }
    readonly socket: { readonly remoteAddress?: string | undefined }
  }): ClaimArrival {
    return {
      listener: listenerOf(request),
      host: request.headers.host,
      source: request.socket.remoteAddress ?? 'unknown',
    }
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
      // fail, and the person print a new code.
      await this.deviceStore.write(records).catch(() => undefined)
      throw error
    }
    return { owner, device }
  }

  /**
   * Run a change after the changes queued before it, whatever those did, so one claim or revocation at a time decides
   * what the home holds.
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
