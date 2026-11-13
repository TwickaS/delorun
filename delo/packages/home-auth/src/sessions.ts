/**
 * The session store: `~/.delo/secrets/home-auth/sessions.json`, mode 0600, holding one record per live session in a map
 * keyed by the session id.
 *
 * A session id is the SHA-256 digest of the session's token (C4's `SessionId`), and the token is the device's
 * credential: the home mints it, hands it out once, and keeps only the key. A copy of the file therefore lets nobody
 * sign in, and revoking a device removes the records keyed by the digests of its tokens, which invalidates every live
 * session it holds.
 *
 * @module @delo/home-auth/sessions
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, ReachListenerId, SessionId, StudioAddress } from '@delo/contract-admission'
import { LISTENER_IDS, SESSION_STORE_VERSION } from '@delo/contract-admission'
import { IDENTITY_FACTORS, type IdentityFactor } from '@delo/contract-oidc-passkeys'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime, readStoreFile, writeStoreFile } from './files.ts'
import { SESSION_TOKEN_BYTES, hashSecret, newSecret, systemRandom, type RandomBytes } from './secret.ts'
import type { SecretSink } from '@delo/contract-operational-logs'

/** The store file's name under `~/.delo/secrets/home-auth/`, mode 0600. */
export const SESSIONS_FILE = 'sessions.json'

/**
 * The most live sessions one device may hold: 16, more than the browsers and tabs a person signs in from and few enough
 * that one leaked device key cannot fill the store. C5 bounds a device's unused challenges at 5 and a home's pending
 * requests at 5; this is the same kind of bound over the sessions a device mints by signing in.
 */
export const MAX_LIVE_SESSIONS_PER_DEVICE = 16

/** One live session. */
export interface SessionRecord {
  /** The device the session speaks for. */
  readonly deviceId: DeviceId
  /** The reach listener the session was created on; a session is admitted only there. */
  readonly listener: ReachListenerId
  /** The studio address the session was created on; a session is used only there. */
  readonly address: StudioAddress
  /**
   * The identity factor the session was created with. The home reads it wherever it grants an action C14 reserves for
   * the home's own computer: a `tailnet-membership` session is refused those with `LOOPBACK_REQUIRED`.
   */
  readonly factor: IdentityFactor
  /** Whether a rotation trigger fired since the token was minted; its next request is refused with `ROTATION_REQUIRED`. */
  readonly rotated: boolean
  /** When the session was created, in milliseconds since the epoch; a roll or a rotation keeps it. */
  readonly createdAt: number
  /** When the current token was minted by a sign-in, a rotation or a roll, in milliseconds since the epoch. */
  readonly lastRolledAt: number
  /**
   * For a token a roll replaced: the time until which it is still admitted for requests already in flight. Absent on a
   * current token.
   */
  readonly graceUntil?: number
  /** When the session last presented its token, in milliseconds since the epoch. */
  readonly lastUsedAt: number
  /** When the token stops being accepted, in milliseconds since the epoch. */
  readonly expiresAt: number
}

/** A session as it is handed to the device that holds it. */
export interface OpenedSession {
  /** The digest of {@link token}, which keys the store. */
  readonly sessionId: SessionId
  /** The credential itself, which no store holds. */
  readonly token: string
  /** When the token stops being accepted, in milliseconds since the epoch, for the cookie's `Max-Age`. */
  readonly expiresAt: number
}

/** What opening a session takes. */
export interface OpenSessionRequest {
  /** The device the session speaks for. */
  readonly deviceId: DeviceId
  /** The reach listener the session is bound to. */
  readonly listener: ReachListenerId
  /** The studio address the session is bound to. */
  readonly address: StudioAddress
  /** The identity factor the session is created with. */
  readonly factor: IdentityFactor
  /** How long the token may be used, in milliseconds. */
  readonly lifetimeMs: number
  /** For a rotation: the session the new token replaces, whose absolute expiry it keeps and whose record it deletes. */
  readonly replaces?: SessionId
}

/** What the session store reads and writes. */
export interface SessionStoreOptions {
  /** The absolute path of `sessions.json`. */
  readonly file: string
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The random source; the operating system's by default. */
  readonly random?: RandomBytes
  /** Where a minted session token is registered while its session lives; none registers nothing. */
  readonly secrets?: SecretSink | undefined
}

/** The live sessions of a home. */
export class SessionStore {
  private readonly now: () => number
  private readonly random: RandomBytes
  /** The disposer of each live session's registered token, by session id. */
  private readonly held = new Map<string, () => void>()

  /** The file, the clock and the random source. */
  private readonly options: SessionStoreOptions

  /**
   * @param options - the file, the clock and the random source.
   */
  constructor(options: SessionStoreOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.random = options.random ?? systemRandom
  }

  /**
   * Register a minted token with the log's redactor for as long as its session lives.
   * @param token - the token handed to the device.
   * @param id - the session id, the digest of the token.
   */
  hold(token: string, id: string): void {
    const sink = this.options.secrets
    if (sink !== undefined) this.held.set(id, sink.register(token, 'session-secret'))
  }

  /**
   * Drop the registration of every token whose session is gone.
   * @param live - the ids of the sessions that still exist.
   */
  sweep(live: Iterable<string>): void {
    const keep = new Set(live)
    for (const [id, release] of this.held) {
      if (keep.has(id)) continue
      release()
      this.held.delete(id)
    }
  }

  /**
   * Mint a session token, record the session under its digest, and hand the token back once.
   *
   * Records whose lifetime has passed are dropped before the bound is counted, so a device that signs in again after its
   * sessions expired is never refused by them, and the file does not keep a dead record for every sign-in ever made.
   * @param request - the device, the address and the lifetime.
   * @returns the session id and the token.
   * @throws {HomeAuthError} `SESSION_LIMIT_REACHED` when the device already holds
   *   {@link MAX_LIVE_SESSIONS_PER_DEVICE} live sessions.
   */
  async open(request: OpenSessionRequest): Promise<OpenedSession> {
    const token = newSecret(SESSION_TOKEN_BYTES, this.random)
    const sessionId = hashSecret(token)
    this.hold(token, sessionId)
    const at = this.now()
    const sessions = await this.read()
    for (const [id, record] of Object.entries(sessions)) {
      if (record.expiresAt <= at) delete sessions[id]
    }
    this.sweep([...Object.keys(sessions), sessionId])
    const replaced = request.replaces === undefined ? undefined : sessions[request.replaces]
    if (request.replaces !== undefined) delete sessions[request.replaces]
    const live = Object.values(sessions).filter(record => record.deviceId === request.deviceId).length
    if (live >= MAX_LIVE_SESSIONS_PER_DEVICE) {
      throw new HomeAuthError(
        'SESSION_LIMIT_REACHED',
        `A device holds at most ${String(MAX_LIVE_SESSIONS_PER_DEVICE)} sessions at once. Close a browser tab or sign out on that device before signing in again`,
        { limit: MAX_LIVE_SESSIONS_PER_DEVICE, deviceId: request.deviceId },
      )
    }
    // A rotation never extends the absolute limit.
    const expiresAt = replaced?.expiresAt ?? at + request.lifetimeMs
    sessions[sessionId] = {
      deviceId: request.deviceId,
      listener: request.listener,
      address: request.address,
      factor: request.factor,
      rotated: false,
      createdAt: replaced?.createdAt ?? at,
      lastRolledAt: at,
      lastUsedAt: at,
      expiresAt,
    }
    await this.write(sessions)
    return { sessionId: brandString<SessionId>(sessionId), token, expiresAt }
  }

  /**
   * The live session a token names.
   * @param token - the token as presented.
   * @returns the record, or undefined for a token no live session names, including an expired one.
   */
  async authenticate(token: string): Promise<SessionRecord | undefined> {
    const record = (await this.read())[hashSecret(token)]
    if (record === undefined) return undefined
    if (record.expiresAt <= this.now()) return undefined
    return record
  }

  /**
   * The sessions one device holds.
   * @param deviceId - the device.
   * @returns their ids.
   */
  async idsOf(deviceId: DeviceId): Promise<readonly SessionId[]> {
    return Object.entries(await this.read())
      .filter(([, record]) => record.deviceId === deviceId)
      .map(([sessionId]) => brandString<SessionId>(sessionId))
  }

  /**
   * Remove every session of one device, which invalidates each of its tokens before this returns.
   * @param deviceId - the device.
   * @returns how many sessions were invalidated.
   */
  async revokeDevice(deviceId: DeviceId): Promise<number> {
    const sessions = await this.read()
    const remaining = Object.entries(sessions).filter(([, record]) => record.deviceId !== deviceId)
    const removed = Object.keys(sessions).length - remaining.length
    if (removed === 0) return 0
    // A record is keyed by the digest of its token, so dropping the key drops the credential.
    await this.write(Object.fromEntries(remaining))
    return removed
  }

  /**
   * Every session record, keyed by session id, for the provider's in-memory copy that `admit` reads.
   * @returns the map.
   */
  async all(): Promise<Readonly<Record<string, SessionRecord>>> {
    return this.read()
  }

  /**
   * Mark every session rotated, as a rotation trigger requires (C4, "Rotation and revocation").
   * @returns how many sessions were marked.
   */
  async rotateAll(): Promise<number> {
    const sessions = await this.read()
    const ids = Object.keys(sessions)
    if (ids.length === 0) return 0
    await this.write(Object.fromEntries(Object.entries(sessions).map(([id, record]) => [id, { ...record, rotated: true }])))
    return ids.length
  }

  /**
   * Remove the given sessions, which invalidates their tokens before this returns.
   * @param ids - the session ids.
   * @returns how many were removed.
   */
  async remove(ids: readonly string[]): Promise<number> {
    const sessions = await this.read()
    const remaining = Object.entries(sessions).filter(([id]) => !ids.includes(id))
    const removed = Object.keys(sessions).length - remaining.length
    if (removed > 0) await this.write(Object.fromEntries(remaining))
    return removed
  }

  /**
   * Record a roll: the old token is kept until its grace ends, and the new token's record is added.
   * @param oldId - the rolled session id.
   * @param graceUntil - when the old token stops being admitted.
   * @param newId - the new token's session id.
   * @param record - the new token's record.
   */
  async roll(oldId: string, graceUntil: number, newId: string, record: SessionRecord): Promise<void> {
    const sessions = await this.read()
    const old = sessions[oldId]
    if (old !== undefined) sessions[oldId] = { ...old, graceUntil }
    sessions[newId] = record
    await this.write(sessions)
  }

  /**
   * Record the last use of sessions that `admit` saw, keeping a later time already on file.
   * @param used - the last-use time of each session id.
   */
  async touch(used: ReadonlyMap<string, number>): Promise<void> {
    const sessions = await this.read()
    let changed = false
    for (const [id, at] of used) {
      const record = sessions[id]
      if (record === undefined || record.lastUsedAt >= at) continue
      sessions[id] = { ...record, lastUsedAt: at }
      changed = true
    }
    if (changed) await this.write(sessions)
  }

  /**
   * Read the session map.
   * @returns the map, keyed by session id.
   * @throws {HomeAuthError} `STORE_INVALID` when the file is not a version 1 session store.
   */
  private async read(): Promise<Record<string, SessionRecord>> {
    const value = await readStoreFile(this.options.file)
    if (value === undefined) return {}
    if (!isRecord(value) || value.v !== SESSION_STORE_VERSION || !isRecord(value.sessions)) {
      throw new HomeAuthError('STORE_INVALID', 'sessions.json is not a version 1 session store')
    }
    const sessions: Record<string, SessionRecord> = {}
    for (const [sessionId, entry] of Object.entries(value.sessions)) {
      sessions[sessionId] = sessionRecordOf(entry)
    }
    return sessions
  }

  /**
   * Write the session map.
   * @param sessions - the map, keyed by session id.
   */
  private async write(sessions: Readonly<Record<string, SessionRecord>>): Promise<void> {
    await writeStoreFile(this.options.file, { v: SESSION_STORE_VERSION, sessions })
  }
}

/**
 * Read one session record.
 * @param value - the value from the session map.
 * @returns the record.
 * @throws {HomeAuthError} `STORE_INVALID` when the value is not a session record.
 */
function sessionRecordOf(value: unknown): SessionRecord {
  if (!isRecord(value)) throw new HomeAuthError('STORE_INVALID', 'sessions.json holds an entry that is not a session')
  const { deviceId, listener, address, factor, rotated, createdAt, lastRolledAt, lastUsedAt, expiresAt, graceUntil } = value
  if (typeof deviceId !== 'string' || deviceId === '') throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no device')
  if (typeof address !== 'string' || address === '') throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no address')
  if (!isReachListener(listener)) throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no reach listener')
  // A record without its factor would leave the home unable to tell which actions the session may be granted.
  if (!isFactor(factor)) throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no identity factor')
  if (typeof rotated !== 'boolean') throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session without its rotation mark')
  if (!isTime(createdAt) || !isTime(lastRolledAt) || !isTime(lastUsedAt) || !isTime(expiresAt) || (graceUntil !== undefined && !isTime(graceUntil))) {
    throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session without its times')
  }
  return {
    deviceId: brandString<DeviceId>(deviceId),
    listener,
    address: brandString<StudioAddress>(address),
    factor,
    rotated,
    createdAt,
    lastRolledAt,
    ...(graceUntil === undefined ? {} : { graceUntil }),
    lastUsedAt,
    expiresAt,
  }
}

/**
 * Whether a stored value names a reach listener.
 * @param value - the stored value.
 * @returns whether it is a listener id other than `loopback`.
 */
function isReachListener(value: unknown): value is ReachListenerId {
  return value !== 'loopback' && LISTENER_IDS.some(id => id === value)
}

/**
 * Whether a stored value names an identity factor.
 * @param value - the stored value.
 * @returns whether it is one of C14's factors.
 */
function isFactor(value: unknown): value is IdentityFactor {
  return IDENTITY_FACTORS.some(factor => factor === value)
}
