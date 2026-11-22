/**
 * A home's owner claim and device list: the records of `~/.delorun/secrets/home-auth/` that name the owner and the trusted
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
 * - A reach session's open connections end when its token stops admitting: every session's at once when a rotation
 *   trigger fires, and one session's at its idle limit, its absolute limit or the end of a roll's grace, from a timer,
 *   whether or not a request arrives (C4, "Sessions").
 *
 * @module @delorun/home-auth
 */
import type { IncomingHttpHeaders } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { join } from 'node:path'
import { SESSION_LIMITS, SESSION_STORE_PERSIST_MS, type DeviceId, type ListenerId, type ReachListenerId, type SessionId, type StudioAddress } from '@delorun/contract-admission'
import {
  DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION, HOME_AUTH_FILES, LOCAL_APPROVER, type ApprovalRequestAccepted,
  type ApprovalRequestState, type DevicePublicKeyJwk,
} from '@delorun/contract-device-approval'
import { ELEVATION_LIMITS, TAILNET_MEMBERSHIP_OPTIONS, type ElevationState, type IdentityFactor } from '@delorun/contract-oidc-passkeys'
import { PinModeStore } from './pin-mode.ts'
import { GrantStore } from './grants.ts'
import { PASS_MINUTES_DEFAULT, PassSettingStore, type PassMinutes } from './pass-setting.ts'
import { PasskeyAuth } from './passkey-auth.ts'
import { PASSKEYS_FILE, PasskeyStore } from './passkeys.ts'
import { PinUnlocks, type PinEvent } from './pin-unlocks.ts'
import { Elevations, isElevationMinutes, type ElevationChange, type ElevationRecord, type PendingElevation } from './elevation.ts'
import { REACH_OPTION_LISTENERS } from '@delorun/contract-reach-providers'
import { Approvals, type ApprovalRequestInput, type PendingSummary } from './approvals.ts'
import { CHALLENGE_LIMIT_DEFAULTS, PAIRING_DEFAULTS, tailnetIdentityOf, type ChallengeLimits, type PairingSpec, type PairingView, type TailnetIdentity } from './pairing.ts'
import { isLoopbackHost, listenerOf, type LoopbackPort, type StampedRequest } from '@delorun/home'
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
import type { SecretSink } from '@delorun/contract-operational-logs'

/** The length of one claim attempt window: a minute, which is C5's owner claim limit. */
const CLAIM_WINDOW_MS = 60 * 1000

/** The longest delay `setTimeout` keeps; a longer one fires at once, so a deadline further out is checked again then. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** A session's armed expiry: the deadline its timer fires at. */
interface ArmedExpiry {
  readonly at: number
  readonly timer: ReturnType<typeof setTimeout>
}

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
  /** The minutes one elevation approved for a device on this listener lasts; C14's default when absent. */
  readonly elevationMinutes?: number
  /**
   * The Tailscale login of the user this computer is signed in as, which the `own-user` pairing mode compares a
   * request's identity with. Absent when the provider cannot read it, which lets no identity ask without a window.
   */
  readonly computerUser?: string
  /**
   * Whether the listener sits behind `tailscale serve`, which sets and overwrites the `Tailscale-User-*` headers. Any
   * other listener ignores those headers, since a client there can send whatever it likes. Absent means false.
   */
  readonly readsTailscaleIdentity?: boolean
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
  /** The absolute path of the secrets directory, `~/.delorun/secrets/home-auth`. */
  readonly directory: string
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The random source; the operating system's by default. */
  readonly random?: RandomBytes
  /** Where the secrets this home mints or loads are registered, so no log holds them; none registers nothing. */
  readonly secrets?: SecretSink | undefined
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
  /** The resolved pairing choices ({@link resolvePairing}), read at each use; {@link PAIRING_DEFAULTS} when absent. */
  readonly pairing?: () => PairingSpec
  /** How many sign-in challenges one source and one device may be issued a minute; {@link CHALLENGE_LIMIT_DEFAULTS} when absent. */
  readonly challengeLimits?: ChallengeLimits
  /**
   * The minutes after its approval during which a device's first sign-in starts an unlock (the approval grace), read at
   * each sign-in; the grace is also capped at the unlock minutes of the listener. 0 turns it off; absent is off.
   */
  readonly approvalGraceMinutes?: () => number
  /**
   * The most minutes a computer-approved unlock lasts from its start, however much it is used, read at each unlock;
   * a listener's unlock minutes must not exceed it. Absent, an unlock does not slide.
   */
  readonly unlockCapMinutes?: () => number
  /**
   * The deployment's default pass length ({@link PASS_MINUTES}), read whenever a Face ID verifies and the person has not
   * chosen one in Settings; absent, {@link PASS_MINUTES_DEFAULT}.
   */
  readonly passDefaultMinutes?: () => PassMinutes
  /**
   * Records one operational event of the passkey and grant machinery; the text holds no challenge, key or signature.
   * @param event - the event line.
   */
  readonly log?: (event: string) => void
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
  private readonly challengeSources: AttemptLimiter
  private readonly challengeDevices: AttemptLimiter
  private readonly now: () => number
  private readonly approvalGraceMinutes: () => number
  private readonly unlockCapMinutes: (() => number) | undefined
  private readonly closeReachConnections: HomeAuthOptions['closeReachConnections']
  private readonly loopbackPort: LoopbackPort
  private readonly random: RandomBytes
  private readonly secrets: SecretSink | undefined
  private readonly served = new Map<ReachListenerId, ServedListener>()
  private readonly challenges: Challenges
  /** The approval window and its requests. */
  readonly approvals: Approvals
  private readonly pairingSpec: () => PairingSpec
  private homeKey: HomeKey | undefined
  /** What `admit` reads; undefined until the stores were read, and after a read failed, so `admit` refuses. */
  private view: AdmissionView | undefined
  /** Last-use times `admit` saw that are not on file yet. */
  private readonly touched = new Map<string, number>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The expiry timer of every session that may hold an admitted reach connection, keyed by session id. An entry lives
   * until its timer fires, a rotation closes its connections or its device is removed, even after the session left the
   * in-memory copy, so the connections of a session `admit` deleted still close.
   */
  private readonly expiries = new Map<string, ArmedExpiry>()
  private readonly removalListeners = new Set<(deviceId: DeviceId) => void>()
  private readonly elevationListeners = new Set<(change: ElevationChange) => void>()
  /** The elevations of this home and the requests waiting for the person at the computer (C14, "Elevation"). */
  private readonly elevations: Elevations
  /** PIN mode: the PIN store and the page unlocks it mints (C14, "PIN mode"). */
  readonly pin: PinUnlocks
  private readonly pinStore: PinModeStore
  /** The passkeys enrolled on this home. */
  readonly passkeyStore: PasskeyStore
  /** The grants and holds a verified assertion or a correct PIN minted, in memory. */
  readonly grants: GrantStore
  /** Passkey enrolment and assertion. */
  readonly passkeys: PasskeyAuth
  /** The person's choice of the Face ID pass length. */
  readonly passSetting: PassSettingStore
  private readonly passDefaultMinutes: () => PassMinutes
  private readonly pinListeners = new Set<(event: PinEvent) => void>()
  /** Each rolled session id to the id that continues it, for the 30 seconds its predecessor still admits requests. */
  private readonly successors = new Map<string, string>()
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
    this.secrets = options.secrets
    this.challenges = new Challenges(this.now, this.random)
    this.pairingSpec = options.pairing ?? (() => PAIRING_DEFAULTS)
    this.approvals = new Approvals({ now: this.now, random: this.random, homeKey: () => this.key(), pairing: this.pairingSpec, secrets: options.secrets })
    const capMinutes = options.unlockCapMinutes
    this.elevations = new Elevations({
      now: this.now,
      ...capMinutes === undefined ? {} : { capMs: () => capMinutes() * 60_000 },
      random: this.random,
      secrets: options.secrets,
      changed: (change) => {
        // The Gateway decides a stream once, when it opens, so a terminal or another elevated stream opened under an
        // unlock would outlive it: the device's reach connections close when it ends, and the studio reconnects
        // without it.
        // A page unlock closes the connections of its session only: the device's other pages reconnect with their own
        // tokens, or locked.
        if (change.kind === 'ended') {
          if (change.elevation.page === true) this.closeSessionConnections(change.elevation.sessionId)
          else this.closeReachConnections?.({ deviceId: change.elevation.deviceId })
        }
        this.pin.elevationChanged(change)
        for (const listener of this.elevationListeners) listener(change)
      },
    })
    this.pinStore = new PinModeStore({ directory: options.directory, now: this.now, secrets: options.secrets })
    this.pin = new PinUnlocks({
      store: this.pinStore,
      elevations: this.elevations,
      now: this.now,
      random: this.random,
      secrets: options.secrets,
      removeDevice: deviceId => this.revokeDevice(deviceId),
      currentSession: presented => this.successors.get(presented) ?? presented,
      sameSession: (presented, bound) => presented === bound || this.successors.get(presented) === bound,
      stillAdmitted: asker => this.view?.sessions.get(asker.sessionId)?.listener === asker.listener
        && this.view.devices.has(asker.deviceId) && this.served.has(asker.listener),
      report: (event) => { for (const listener of this.pinListeners) listener(event) },
    })
    this.removalListeners.add((deviceId) => { void this.pinStore.forget(deviceId).catch(() => undefined) })
    this.passkeyStore = new PasskeyStore({ file: join(options.directory, PASSKEYS_FILE) })
    this.grants = new GrantStore({ now: this.now, random: this.random, ...options.log === undefined ? {} : { log: options.log } })
    this.passSetting = new PassSettingStore({ file: join(options.directory, HOME_AUTH_FILES.faceIdPass) })
    this.passDefaultMinutes = options.passDefaultMinutes ?? (() => PASS_MINUTES_DEFAULT)
    this.passkeys = new PasskeyAuth({
      store: this.passkeyStore,
      grants: this.grants,
      passMinutes: () => this.passMinutes(),
      pin: this.pin,
      now: this.now,
      random: this.random,
      sameSession: (presented, bound) => presented === bound || this.successors.get(presented) === bound,
      log: options.log ?? (() => undefined),
    })
    const path = (name: string): string => join(options.directory, name)
    this.ownerCodes = new OwnerCodeStore({ file: path(HOME_AUTH_FILES.ownerCode), secrets: options.secrets, ...timed(options) })
    this.deviceStore = new DeviceStore({ file: path(HOME_AUTH_FILES.devices) })
    this.sessions = new SessionStore({ file: path(SESSIONS_FILE), secrets: options.secrets, ...timed(options) })
    this.claims = new AttemptLimiter({
      limit: options.claimAttemptsPerMinute ?? DEVICE_APPROVAL_LIMITS.ownerClaimAttemptsPerMinutePerSource,
      windowMs: CLAIM_WINDOW_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.approvalGraceMinutes = options.approvalGraceMinutes ?? (() => 0)
    this.unlockCapMinutes = options.unlockCapMinutes
    const challengeLimits = options.challengeLimits ?? CHALLENGE_LIMIT_DEFAULTS
    this.challengeSources = new AttemptLimiter({ limit: challengeLimits.perSourcePerMinute, windowMs: CLAIM_WINDOW_MS, ...(options.now === undefined ? {} : { now: options.now }) })
    this.challengeDevices = new AttemptLimiter({ limit: challengeLimits.perDevicePerMinute, windowMs: CLAIM_WINDOW_MS, ...(options.now === undefined ? {} : { now: options.now }) })
  }

  /**
   * Create the secrets directory at mode 0700, as contract C1 requires of every directory under `secrets/`.
   * @throws the filesystem failure of `mkdir`.
   */
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.homeKey = await loadHomeKey(this.directory, this.secrets)
    await this.pinStore.load()
    await this.passkeyStore.load()
    await this.passSetting.load()
    await this.refresh()
  }

  /** @returns the Face ID pass length now in effect: the person's choice, else the deployment's default; 0 opens no pass. */
  passMinutes(): PassMinutes {
    return this.passSetting.get() ?? this.passDefaultMinutes()
  }

  /**
   * Write the last-use times `admit` recorded, stop the timer that writes them and every session's expiry timer, and
   * wait for the queued changes; the provider calls this when it stops, as C4 requires of the session store. The reach
   * listeners stop with the provider, which closes their connections.
   */
  async stop(): Promise<void> {
    this.elevations.endAll('home-stopped')
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    for (const armed of this.expiries.values()) clearTimeout(armed.timer)
    this.expiries.clear()
    await this.persistTouched()
    // Wait for the changes already queued, such as the removal of an expired session.
    await this.serial(() => Promise.resolve())
    // A device removal forgets its PIN tries in the background; the directory is not free until that write lands.
    await this.pinStore.settled()
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
   * A removal is also a rotation trigger (C4): every other session is marked rotated and its reach connections close,
   * so a device that kept a copy of the removed one's cookie gains nothing. The removed device's own connections are
   * closed by device before the rotation, so a rotation that cannot be written still leaves them closed.
   * @param deviceId - the device.
   * @returns what was removed, invalidated and closed; `connections` counts the removed device's only.
   * @throws {HomeAuthError} `NO_OWNER` for an unclaimed home, which closes no connection and removes nothing.
   */
  async revokeDevice(deviceId: DeviceId): Promise<RevocationResult> {
    return this.changing(async () => {
      await this.assertOwner()
      const removed = await this.deviceStore.remove(deviceId)
      const sessions = await this.sessions.revokeDevice(deviceId)
      this.elevations.endDevice(deviceId, 'device-removed')
      // The device's passkeys, grants and holds go in the same call that removes its record.
      await this.passkeys.forgetDevice(deviceId)
      this.forget(deviceId)
      for (const listener of this.removalListeners) listener(deviceId)
      const connections = this.closeReachConnections?.({ deviceId }) ?? 0
      await this.rotateAll()
      return { removed, sessions, connections }
    })
  }

  /**
   * Sign every paired device out and keep the device list: remove every session, so each token is refused from this
   * call on; end every Face ID pass, elevation, grant and hold; and close the reach connections the sessions admitted.
   * Turning device access off calls this, so turning it on again restores no session: a device signs in again. The
   * records of the devices, and their passkeys, stay.
   * @returns how many sessions were removed.
   */
  async signAllDevicesOut(): Promise<number> {
    return this.changing(async () => {
      const ids = Object.keys(await this.sessions.all())
      this.elevations.endAll('session-ended')
      this.grants.endAll()
      this.view?.sessions.clear()
      for (const armed of this.expiries.values()) clearTimeout(armed.timer)
      this.expiries.clear()
      for (const id of ids) this.closeReachConnections?.({ sessionId: id })
      await this.sessions.remove(ids)
      return ids.length
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
    if (served.elevationMinutes !== undefined && !isElevationMinutes(served.elevationMinutes)) {
      throw new HomeAuthError('BAD_REQUEST', `an elevation lasts a whole number of minutes from 1 to ${String(ELEVATION_LIMITS.maxMinutes)}, got ${String(served.elevationMinutes)}`)
    }
    const cap = this.unlockCapMinutes?.()
    if (cap !== undefined && (served.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes) > cap) {
      throw new HomeAuthError('BAD_REQUEST', `an unlock lasts ${String(served.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes)} minutes, more than the ${String(cap)}-minute cap on one unlock`)
    }
    this.served.set(served.listener, served)
    return () => {
      if (this.served.get(served.listener) !== served) return
      this.served.delete(served.listener)
      this.elevations.endListener(served.listener, 'listener-stopped')
    }
  }

  /**
   * Call a listener for each PIN mode event: a wrong try, a lockout, a pause or resume, a PIN set, the mode turned off.
   * @param listener - called with the event, which never carries the PIN.
   * @returns the disposer.
   */
  onPinEvent(listener: (event: PinEvent) => void): () => void {
    this.pinListeners.add(listener)
    return () => { this.pinListeners.delete(listener) }
  }

  /**
   * Call a listener for each elevation that starts or ends, after the change; the provider logs it and recomputes the
   * device's access.
   * @param listener - called with the change.
   * @returns the disposer.
   */
  onElevationChange(listener: (change: ElevationChange) => void): () => void {
    this.elevationListeners.add(listener)
    return () => { this.elevationListeners.delete(listener) }
  }

  /**
   * Record a signed-in device's request to elevate on the listener its session lives on, replacing its waiting one.
   * @param sessionId - the admitted session that asks.
   * @param session - its record.
   * @returns the device's state, with the code it shows.
   * @throws {HomeAuthError} `APPROVAL_PENDING_LIMIT` when the home holds its limit of requests.
   */
  requestElevation(sessionId: string, session: SessionRecord): ElevationState {
    // A request that rolled its session in flight still presents the old id; the elevation follows the current one.
    this.elevations.request({ deviceId: session.deviceId, listener: session.listener, sessionId: this.successors.get(sessionId) ?? sessionId })
    return this.stateWithMinutes(session.deviceId, session.listener)
  }

  /**
   * What one device's own studio shows about elevation on one listener.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the state.
   */
  elevationState(deviceId: string, listener: ReachListenerId): ElevationState {
    return this.stateWithMinutes(deviceId, listener)
  }

  /**
   * The device's state, with the minutes an unlock on its listener lasts where none runs yet.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the state; `none` and `pending` carry `unlockMinutes`.
   */
  private stateWithMinutes(deviceId: string, listener: ReachListenerId): ElevationState {
    const state = this.elevations.stateOf(deviceId, listener)
    if (state.kind === 'elevated' && this.elevationOf(deviceId, listener) !== undefined) return state
    if (state.kind === 'elevated') return { kind: 'none', unlockMinutes: this.served.get(listener)?.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes }
    return { ...state, unlockMinutes: this.served.get(listener)?.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes }
  }

  /**
   * The running elevation of one device on one listener, which the reach-device policy reads before each elevated action.
   * @param deviceId - the device.
   * @param listener - the listener its Peer sits on.
   * @returns the elevation, or undefined.
   */
  elevationOf(deviceId: string, listener: ReachListenerId): ElevationRecord | undefined {
    const record = this.elevations.of(deviceId, listener)
    // With a PIN or a passkey there is no approval grace: the first unlock-needing action asks for it.
    return record?.grace === true && this.unlockModeEnabled() ? undefined : record
  }

  /**
   * Renew a computer-approved unlock after an action that needed it, which the reach-device policy and the unlock-gated
   * routes call; reads and polling never do.
   * @param elevationId - the id of the unlock the action ran under.
   */
  touchUnlock(elevationId: string): void {
    this.elevations.touch(elevationId)
  }

  /**
   * Whether a locked device is refused where an unlock matters: a PIN is set or any passkey is enrolled. It is the only
   * reading that decides this, so a home that holds a passkey and no PIN refuses as a home with a PIN does.
   * @returns whether it is on.
   */
  unlockModeEnabled(): boolean {
    return this.pin.enabled() || this.passkeyStore.any()
  }

  /**
   * Renew the computer-approved unlock a device holds on a listener, if any, after the person typed in an attached
   * terminal. A grace and a page unlock do not slide.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  touchDeviceUnlock(deviceId: string, listener: ReachListenerId): void {
    const record = this.elevations.of(deviceId, listener)
    if (record !== undefined) this.elevations.touch(record.id)
  }

  /**
   * The running PIN mode page unlock one Peer was admitted under, which the reach-device policy reads.
   * @param unlockId - the id in the Peer's principal.
   * @returns the unlock, or undefined once it ended.
   */
  pageUnlockOf(unlockId: string): ElevationRecord | undefined {
    return this.pin.pageUnlock(unlockId)
  }

  /**
   * End a device's elevation on one listener and cancel its waiting request, from the device's own studio.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  lockElevation(deviceId: string, listener: ReachListenerId): void {
    this.elevations.endFor(deviceId, listener, 'locked-from-device')
  }

  /**
   * The requests to elevate waiting for the person and the running elevations, for the home's own computer.
   * @returns both, oldest first, without any code.
   */
  elevationsAtComputer(): { readonly pending: readonly PendingElevation[]; readonly running: readonly ElevationRecord[] } {
    return { pending: this.elevations.pending(), running: this.elevations.list() }
  }

  /**
   * Approve a request to elevate at the home's own computer with the code the person typed from the device. The
   * elevation lasts the minutes of the listener the request arrived on.
   * @param requestId - the request.
   * @param typedCode - the code.
   * @returns the elevation that started.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` for an unknown or expired request, or one whose listener is no longer
   *   served; `APPROVAL_CODE_MISMATCH` for a wrong code.
   */
  approveElevation(requestId: string, typedCode: string): ElevationRecord {
    const request = this.elevations.pending().find(pending => pending.requestId === requestId)
    const served = request === undefined ? undefined : this.served.get(request.listener)
    if (served === undefined) throw new HomeAuthError('APPROVAL_EXPIRED', 'That request to unlock expired or was answered. Ask again from the device')
    return this.elevations.approve(requestId, typedCode, served.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes)
  }

  /**
   * Decline a waiting request, or end a running elevation, at the home's own computer.
   * @param id - the request id or the elevation id.
   * @returns whether either was found.
   */
  revokeElevation(id: string): boolean {
    return this.elevations.decline(id) || this.elevations.endById(id, 'revoked-at-computer')
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
   * @param where - the listener, the source the limit counts and the Tailscale user the request's headers name.
   * @returns C5's `201` answer.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` outside a window for an identity that may not ask without one;
   *   `NO_OWNER`; `DEVICE_NOT_TRUSTED` for a listener no provider serves; the limits of {@link Approvals.request}.
   */
  async requestApproval(input: ApprovalRequestInput, where: { readonly listener: ReachListenerId; readonly source: string; readonly identity?: TailnetIdentity | undefined }): Promise<ApprovalRequestAccepted> {
    this.assertMayAsk(where.listener, where.identity)
    await this.assertOwner()
    const served = this.servedOrRefuse(where.listener)
    return this.approvals.request(input, { listener: where.listener, address: served.address, source: where.source, identity: where.identity, computerUser: served.computerUser })
  }

  /**
   * The Tailscale user a request's headers name, on a listener that reads them.
   * @param listener - the reach listener the request arrived on.
   * @param headers - the request's headers.
   * @returns the identity, or undefined on any other listener, which ignores the headers.
   */
  identityOf(listener: ReachListenerId, headers: IncomingHttpHeaders): TailnetIdentity | undefined {
    return this.served.get(listener)?.readsTailscaleIdentity === true ? tailnetIdentityOf(headers) : undefined
  }

  /**
   * Refuse a request that may not be accepted now, before its body is read.
   * @param listener - the reach listener it arrived on.
   * @param identity - the Tailscale user its headers name.
   * @throws {HomeAuthError} `APPROVALS_CLOSED` outside a window for an identity that may not ask without one.
   */
  assertMayAsk(listener: ReachListenerId, identity?: TailnetIdentity): void {
    this.approvals.assertMayAsk(identity, this.served.get(listener)?.computerUser)
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
   * The resolved pairing choices, which the loopback studio's notice and the commands read.
   * @returns who may ask without a window, how a request is shown and the window and expiry in minutes.
   */
  pairing(): PairingView {
    const { mayAskWithoutWindow, showRequest, windowMs, requestExpiryMs, pendingPerIdentity } = this.pairingSpec()
    return { mayAskWithoutWindow, showRequest, windowMinutes: windowMs / 60_000, requestExpiryMinutes: requestExpiryMs / 60_000, pendingPerIdentity }
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
      // The approval at the computer also lets this device enrol a passkey, once.
      this.passkeys.mintTicket(request.deviceId, request.listener)
      // C4: a device approval rotates every session of the home.
      await this.rotateAll()
      return device
    })
  }

  /**
   * Issue a sign-in challenge to a device trusted on a served listener's address.
   * @param deviceId - the device.
   * @param listener - the listener the request was admitted on.
   * @param source - the source the request's arrival names, which the source limit counts.
   * @returns the challenge.
   * @throws {HomeAuthError} `CHALLENGE_RATE_LIMITED` past the source's or the device's limit;
   *   `DEVICE_NOT_TRUSTED` when no record names the device at the listener's address.
   */
  async challenge(deviceId: DeviceId, listener: ReachListenerId, source: string): Promise<string> {
    const served = this.servedOrRefuse(listener)
    if (!this.challengeSources.take(source)) throw new HomeAuthError('CHALLENGE_RATE_LIMITED', 'Too many sign-in challenges were asked for from this address in the last minute. Wait a minute, then try again')
    const device = await this.deviceStore.find(deviceId)
    if (device?.address !== served.address) throw this.notTrusted(deviceId, served.address)
    // Only a trusted device's id keys a counter, so asking with made-up ids cannot grow the limiter without bound.
    if (!this.challengeDevices.take(deviceId)) throw new HomeAuthError('CHALLENGE_RATE_LIMITED', 'Too many sign-in challenges were asked for this device in the last minute. Wait a minute, then try again')
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
      this.startApprovalGrace(device, request, served, opened.sessionId)
      return opened
    })
  }

  /**
   * Start the approval grace for a device that has just signed in for the first time: an unlock that runs from the
   * approval for the grace minutes, at most the listener's unlock minutes, so a newly approved phone runs its first-run
   * setup without unlock prompts. It starts only on the first sign-in of a device whose record shows no earlier one,
   * never on a rotation, never while PIN mode is on, and not once the grace window since the approval has passed. It admits only what an unlock
   * admits: the computer-only table is refused during it as at any other time.
   * @param device - the device's record as read before this sign-in.
   * @param request - the sign-in request.
   * @param served - the listener it signed in on.
   * @param sessionId - the session the sign-in opened, which the unlock belongs to and which ends it.
   */
  private startApprovalGrace(device: DeviceRecord, request: SignInRequest, served: ServedListener, sessionId: SessionId): void {
    const minutes = this.approvalGraceMinutes()
    if (minutes <= 0 || device.lastSignInAt !== null || request.rotate !== undefined || this.unlockModeEnabled()) return
    const graceMs = Math.min(minutes, served.elevationMinutes ?? ELEVATION_LIMITS.defaultMinutes) * 60_000
    const endsAt = device.approvedAt + graceMs
    if (this.now() >= endsAt) return
    this.elevations.startGrace({ deviceId: request.deviceId, listener: request.listener, sessionId }, endsAt)
  }

  /**
   * End the approval grace of a device on one listener, which the device's own studio asks for once its first-run setup
   * finishes. Any other unlock the device holds stays.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  endApprovalGrace(deviceId: string, listener: ReachListenerId): void {
    this.elevations.endGraceFor(deviceId, listener)
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
      this.grants.endDevice(session.deviceId)
      this.elevations.endSession(sessionId, 'session-ended')
      void this.serial(() => this.sessions.remove([sessionId])).catch(() => undefined)
      return { kind: 'refused', code: 'SESSION_EXPIRED' }
    }
    if (session.rotated) return { kind: 'refused', code: 'ROTATION_REQUIRED' }
    if (session.graceUntil !== undefined && at >= session.graceUntil) {
      view.sessions.delete(sessionId)
      this.grants.endDevice(session.deviceId)
      this.elevations.endSession(sessionId, 'session-ended')
      void this.serial(() => this.sessions.remove([sessionId])).catch(() => undefined)
      return { kind: 'refused', code: 'NOT_SIGNED_IN' }
    }
    // A request admitted here is the session's use: the expiry timer reads this time when it fires and waits on. Bytes on
    // a connection admitted earlier never reach this method, so an open stream or WebSocket alone keeps nothing alive.
    const used = { ...session, lastUsedAt: at }
    view.sessions.set(sessionId, used)
    if (options.roll && session.graceUntil === undefined && at - session.lastRolledAt >= SESSION_LIMITS.reach.rollAfterMs) {
      return this.roll(view, sessionId, used, at)
    }
    this.touch(sessionId, at)
    // A request admitted here keeps the device's Face ID pass on this listener from its idle end (A499 review P2-1).
    this.grants.touchPass({ deviceId: session.deviceId, listener })
    return { kind: 'admitted', sessionId: brandString<SessionId>(sessionId), session: used }
  }

  /**
   * Close the reach connections of one session and of the sessions it rolled from.
   * @param sessionId - the session id.
   */
  private closeSessionConnections(sessionId: string): void {
    this.closeReachConnections?.({ sessionId })
    for (const [oldId, newId] of this.successors) {
      if (newId === sessionId) this.closeReachConnections?.({ sessionId: oldId })
    }
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
    this.sessions.sweep(view.sessions.keys())
    this.sessions.hold(token, newId)
    const graceUntil = at + SESSION_LIMITS.reach.rollGraceMs
    const record: SessionRecord = { ...used, lastRolledAt: at }
    const graced: SessionRecord = { ...used, graceUntil }
    view.sessions.set(oldId, graced)
    view.sessions.set(newId, record)
    // The new token continues the session, so its elevation and its waiting request follow it.
    this.elevations.moveSession(oldId, newId)
    this.successors.set(oldId, newId)
    setTimeout(() => { this.successors.delete(oldId) }, SESSION_LIMITS.reach.rollGraceMs).unref()
    // The old token's connections close when its grace ends; the new token's at its own limits.
    this.arm(oldId, deadlineOf(graced))
    this.arm(newId, deadlineOf(record))
    // Inside the change queue and refreshed after, like every write `admit` must see: a rotation that ran meanwhile has
    // marked the old record, and the store carries that mark to the new one.
    void this.changing(() => this.sessions.roll(oldId, graceUntil, newId, record)).catch(() => undefined)
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
   * Arm a session's expiry timer for a deadline, or move an armed one earlier. A later deadline, such as the one a use
   * makes, leaves the armed timer alone: it reads the session again when it fires and waits on until the new deadline.
   * @param sessionId - the session id.
   * @param at - when its token stops admitting, in milliseconds since the epoch.
   */
  private arm(sessionId: string, at: number): void {
    const armed = this.expiries.get(sessionId)
    if (armed !== undefined && armed.at <= at) return
    clearTimeout(armed?.timer)
    const timer = setTimeout(() => { this.expire(sessionId) }, Math.min(at - this.now(), MAX_TIMER_DELAY_MS))
    timer.unref()
    this.expiries.set(sessionId, { at, timer })
  }

  /**
   * Arm the expiry timer of every session in a fresh in-memory copy that may still admit a request. A rotated session's
   * connections closed at its rotation, and a session past its deadline either had them closed by its timer or was never
   * admitted while it could be, so neither is armed.
   * @param view - the in-memory copy.
   */
  private schedule(view: AdmissionView): void {
    const at = this.now()
    for (const [sessionId, session] of view.sessions) {
      const deadline = deadlineOf(session)
      if (!session.rotated && deadline > at) this.arm(sessionId, deadline)
    }
  }

  /**
   * A session's expiry timer fired: wait on when a request used the session since it was armed, otherwise close the
   * reach connections it admitted. A session the in-memory copy no longer holds, because `admit` deleted it past its
   * limit, a sign-in replaced it or the stores could not be read, has its connections closed too. The record itself is
   * left for `admit`, which refuses it with C4's code and deletes it.
   * @param sessionId - the session id.
   */
  private expire(sessionId: string): void {
    this.expiries.delete(sessionId)
    const session = this.view?.sessions.get(sessionId)
    if (session !== undefined && deadlineOf(session) > this.now()) {
      this.arm(sessionId, deadlineOf(session))
      return
    }
    this.elevations.endSession(sessionId, 'session-ended')
    // Face ID grants and holds live as long as the device's session; the device's next confirmation starts new ones.
    if (session !== undefined) this.grants.endDevice(session.deviceId)
    this.closeReachConnections?.({ sessionId })
  }

  /**
   * Rotate every session (C4, "Rotation and revocation"): mark each rotated in the in-memory copy, so `admit` refuses it
   * from here on, close the reach connections of every session whose expiry timer is armed, which is every session that
   * may hold one, and then write the marks. The connections close before the write, so a write that fails still leaves
   * them closed.
   */
  private async rotateAll(): Promise<void> {
    this.elevations.endAll('session-ended')
    this.grants.endAll()
    const view = this.view
    if (view !== undefined) {
      for (const [sessionId, session] of view.sessions) view.sessions.set(sessionId, { ...session, rotated: true })
    }
    for (const [sessionId, armed] of this.expiries) {
      clearTimeout(armed.timer)
      this.closeReachConnections?.({ sessionId })
    }
    this.expiries.clear()
    await this.sessions.rotateAll()
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
   * Drop a removed device's sessions from the in-memory copy at once, before the stores are read again, with their
   * expiry timers: the removal closes their connections by device.
   * @param deviceId - the device.
   */
  private forget(deviceId: DeviceId): void {
    const view = this.view
    if (view === undefined) return
    view.devices.delete(deviceId)
    for (const [id, session] of view.sessions) {
      if (session.deviceId !== deviceId) continue
      view.sessions.delete(id)
      clearTimeout(this.expiries.get(id)?.timer)
      this.expiries.delete(id)
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
      this.schedule(view)
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
 * When a reach session's token stops admitting: its idle limit after its last use, its absolute expiry, or the end of a
 * roll's grace for a token a roll replaced, whichever comes first. `admit` refuses the token from this time on.
 * @param session - the session record.
 * @returns the time, in milliseconds since the epoch.
 */
function deadlineOf(session: SessionRecord): number {
  return Math.min(session.lastUsedAt + SESSION_LIMITS.reach.idleMs, session.expiresAt, session.graceUntil ?? Infinity)
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
