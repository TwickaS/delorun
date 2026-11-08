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
import type { DeviceId, SessionId, StudioAddress } from '@delo/contract-admission'
import { SESSION_STORE_VERSION } from '@delo/contract-admission'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime, readStoreFile, writeStoreFile } from './files.ts'
import { SESSION_TOKEN_BYTES, hashSecret, newSecret, systemRandom, type RandomBytes } from './secret.ts'

/** The store file's name under `~/.delo/secrets/home-auth/`, mode 0600. */
export const SESSIONS_FILE = 'sessions.json'

/** One live session. */
export interface SessionRecord {
  /** The device the session speaks for. */
  readonly deviceId: DeviceId
  /** The studio address the session was created on; a session is used only there. */
  readonly address: StudioAddress
  /** When the token was minted, in milliseconds since the epoch. */
  readonly createdAt: number
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
}

/** What opening a session takes. */
export interface OpenSessionRequest {
  /** The device the session speaks for. */
  readonly deviceId: DeviceId
  /** The studio address the session is bound to. */
  readonly address: StudioAddress
  /** How long the token may be used, in milliseconds. */
  readonly lifetimeMs: number
}

/** What the session store reads and writes. */
export interface SessionStoreOptions {
  /** The absolute path of `sessions.json`. */
  readonly file: string
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The random source; the operating system's by default. */
  readonly random?: RandomBytes
}

/** The live sessions of a home. */
export class SessionStore {
  private readonly now: () => number
  private readonly random: RandomBytes

  /**
   * @param options - the file, the clock and the random source.
   */
  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? systemRandom
  }

  /**
   * Mint a session token, record the session under its digest, and hand the token back once.
   * @param request - the device, the address and the lifetime.
   * @returns the session id and the token.
   */
  async open(request: OpenSessionRequest): Promise<OpenedSession> {
    const token = newSecret(SESSION_TOKEN_BYTES, this.random)
    const sessionId = hashSecret(token)
    const at = this.now()
    const sessions = await this.read()
    sessions[sessionId] = {
      deviceId: request.deviceId,
      address: request.address,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: at + request.lifetimeMs,
    }
    await this.write(sessions)
    return { sessionId: brandString<SessionId>(sessionId), token }
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
  const { deviceId, address, createdAt, lastUsedAt, expiresAt } = value
  if (typeof deviceId !== 'string' || deviceId === '') throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no device')
  if (typeof address !== 'string' || address === '') throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session with no address')
  if (!isTime(createdAt) || !isTime(lastUsedAt) || !isTime(expiresAt)) {
    throw new HomeAuthError('STORE_INVALID', 'sessions.json holds a session without its times')
  }
  return {
    deviceId: brandString<DeviceId>(deviceId),
    address: brandString<StudioAddress>(address),
    createdAt,
    lastUsedAt,
    expiresAt,
  }
}
