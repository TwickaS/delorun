/**
 * The store of PIN mode (C14, "PIN mode"): whether the mode is on, the salted scrypt hash of the PIN or passcode, and
 * the wrong tries that keep a stolen device from guessing it.
 *
 * - **The secret.** An all-digit secret is a PIN of 6 to 128 digits that is not a repeat, a run or a common PIN; any
 *   other secret is a passcode of 10 to 128 characters. Both are normalised to NFC before they are hashed or compared.
 *   The store keeps `scrypt` parameters beside each hash so they can rise, a per-record salt, and compares in constant
 *   time. The secret is never logged: it is handed to the redactor while it is handled and appears in no error text.
 * - **Wrong tries.** A try is counted and written *before* the secret is compared, under a per-device queue, so
 *   parallel guesses cannot outrun the count and a crash during the comparison counts as a miss. A success clears the
 *   device's count and gives back the home-wide try it took. The {@link PIN_MODE_LIMITS.deviceWrongTries}th miss of a
 *   device returns `lockout`; {@link PIN_MODE_LIMITS.homeWrongTries} misses across the home within 24 hours pause PIN
 *   unlocks until {@link PinModeStore.resume}. Both counts survive a restart.
 *
 * @module @delo/home-auth/pin-mode
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { HOME_AUTH_FILES } from '@delo/contract-device-approval'
import { PIN_MODE_LIMITS, type PinKind } from '@delo/contract-oidc-passkeys'
import type { SecretSink } from '@delo/contract-operational-logs'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime, readStoreFile, writeStoreFile } from './files.ts'

/** The version of both files. */
const PIN_FILE_VERSION = 1

/** The scrypt parameters and outputs a record stores, so a later version may raise the cost. */
interface ScryptHash {
  readonly alg: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: string
  readonly dk: string
}

/** `pin-mode.json`. */
interface PinModeRecord {
  readonly v: typeof PIN_FILE_VERSION
  readonly enabled: boolean
  readonly kind: PinKind
  readonly hash: ScryptHash
  readonly setAt: number
  readonly setBy: 'computer'
  readonly idleMinutes: number
  readonly lockWhenHidden: boolean
}

/** `pin-attempts.json`. */
interface PinAttempts {
  readonly v: typeof PIN_FILE_VERSION
  /** Misses since the device's last success. */
  readonly devices: Readonly<Record<string, number>>
  /** The times of the misses (and in-flight tries) across the home within the window. */
  readonly home: readonly number[]
  readonly paused: boolean
}

/** What the store reports of PIN mode. */
export interface PinModeSummary {
  readonly enabled: boolean
  readonly kind: PinKind | undefined
  readonly idleMinutes: number
  readonly lockWhenHidden: boolean
  readonly paused: boolean
}

/** The outcome of a try. */
export type PinCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'wrong'; readonly triesLeft: number }
  | { readonly kind: 'lockout' }
  | { readonly kind: 'paused' }

/** PINs refused for being common; repeats and runs are refused by their shape. */
const COMMON_PINS = new Set(['123456', '1234567', '12345678', '123123', '121212', '112233', '654321', '696969', '000000', '123321', '159753', '147258', '142536', '102030', '121314'])

/**
 * Normalise a presented secret.
 * @param secret - the text a person typed.
 * @returns the NFC form.
 */
function normalised(secret: string): string {
  return secret.normalize('NFC')
}

/**
 * What kind of secret a text is.
 * @param secret - the normalised secret.
 * @returns `pin` for digits only, else `passcode`.
 */
function kindOf(secret: string): PinKind {
  return /^[0-9]+$/.test(secret) ? 'pin' : 'passcode'
}

/**
 * Whether a digit string is a run, such as `345678` or `987654`.
 * @param digits - the digits.
 * @returns whether every step is +1 or every step is -1.
 */
function isRun(digits: string): boolean {
  const steps = new Set<number>()
  for (let at = 1; at < digits.length; at += 1) steps.add(Number(digits[at]) - Number(digits[at - 1]))
  return steps.size === 1 && (steps.has(1) || steps.has(-1))
}

/**
 * Whether a digit string is one block of one to three digits repeated, such as `111111` or `123123`.
 * @param digits - the digits.
 * @returns whether it is.
 */
function isRepeat(digits: string): boolean {
  for (let size = 1; size <= 3; size += 1) {
    if (digits.length % size === 0 && digits === digits.slice(0, size).repeat(digits.length / size)) return true
  }
  return false
}

/**
 * Check a new secret against the rules and name its kind.
 * @param presented - what the person typed.
 * @returns the normalised secret and its kind.
 * @throws {HomeAuthError} `PIN_WEAK` when it breaks a rule; the message names the rule, never the secret.
 */
export function checkNewSecret(presented: string): { readonly secret: string; readonly kind: PinKind } {
  const secret = normalised(presented)
  const kind = kindOf(secret)
  const length = [...secret].length
  if (length > PIN_MODE_LIMITS.maxSecretChars) throw new HomeAuthError('PIN_WEAK', `A PIN or passcode has at most ${String(PIN_MODE_LIMITS.maxSecretChars)} characters`)
  if (kind === 'passcode') {
    if (length < PIN_MODE_LIMITS.minPasscodeChars) {
      throw new HomeAuthError('PIN_WEAK', `A passcode has at least ${String(PIN_MODE_LIMITS.minPasscodeChars)} characters; a PIN is digits only, at least ${String(PIN_MODE_LIMITS.minPinDigits)}`)
    }
    if (new Set(secret).size === 1) throw new HomeAuthError('PIN_WEAK', 'A passcode is not one character repeated')
    return { secret, kind }
  }
  if (length < PIN_MODE_LIMITS.minPinDigits) throw new HomeAuthError('PIN_WEAK', `A PIN has at least ${String(PIN_MODE_LIMITS.minPinDigits)} digits`)
  if (isRepeat(secret) || isRun(secret) || COMMON_PINS.has(secret)) throw new HomeAuthError('PIN_WEAK', 'That PIN is a repeat, a run or a common PIN. Choose another')
  return { secret, kind }
}

/**
 * Whether a value is a stored hash.
 * @param value - the value read from the file.
 * @returns whether it is.
 */
function isHash(value: unknown): value is ScryptHash {
  return isRecord(value) && value.alg === 'scrypt' && [value.N, value.r, value.p].every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)
    && typeof value.salt === 'string' && typeof value.dk === 'string'
}

/** The store of PIN mode. */
export class PinModeStore {
  private readonly modeFile: string
  private readonly attemptsFile: string
  private readonly now: () => number
  private readonly secrets: SecretSink | undefined
  private record: PinModeRecord | undefined
  private attempts: PinAttempts = { v: PIN_FILE_VERSION, devices: {}, home: [], paused: false }
  /** The tail of the writes, so two files never interleave. */
  private writes: Promise<unknown> = Promise.resolve()
  /** The tail of each device's tries. */
  private readonly tries = new Map<string, Promise<unknown>>()
  private hashing = 0
  private readonly waiting: (() => void)[] = []

  /**
   * @param options - the directory of `~/.delo/secrets/home-auth`, the clock and the secret sink.
   */
  constructor(options: { readonly directory: string; readonly now: () => number; readonly secrets?: SecretSink | undefined }) {
    this.modeFile = join(options.directory, HOME_AUTH_FILES.pinMode)
    this.attemptsFile = join(options.directory, HOME_AUTH_FILES.pinAttempts)
    this.now = options.now
    this.secrets = options.secrets
  }

  /**
   * Read both files; a missing file is a mode that is off with no tries.
   * @throws {HomeAuthError} `STORE_INVALID` for a file that is exposed, not JSON or not this store's record.
   */
  async load(): Promise<void> {
    const mode = await readStoreFile(this.modeFile)
    if (isRecord(mode) && mode.v === PIN_FILE_VERSION && mode.enabled === false) {
      this.record = undefined
    } else if (mode !== undefined) {
      if (!isRecord(mode) || mode.v !== PIN_FILE_VERSION || typeof mode.enabled !== 'boolean' || !isHash(mode.hash)
        || (mode.kind !== 'pin' && mode.kind !== 'passcode') || !isTime(mode.setAt) || typeof mode.idleMinutes !== 'number'
        || typeof mode.lockWhenHidden !== 'boolean') {
        throw new HomeAuthError('STORE_INVALID', `${HOME_AUTH_FILES.pinMode} is not a PIN mode record`)
      }
      this.record = { v: PIN_FILE_VERSION, enabled: mode.enabled, kind: mode.kind, hash: mode.hash, setAt: mode.setAt, setBy: 'computer', idleMinutes: mode.idleMinutes, lockWhenHidden: mode.lockWhenHidden }
    }
    const attempts = await readStoreFile(this.attemptsFile)
    if (attempts !== undefined) {
      if (!isRecord(attempts) || attempts.v !== PIN_FILE_VERSION || !isRecord(attempts.devices) || !Array.isArray(attempts.home)
        || !attempts.home.every(isTime) || typeof attempts.paused !== 'boolean') {
        throw new HomeAuthError('STORE_INVALID', `${HOME_AUTH_FILES.pinAttempts} is not a PIN attempts record`)
      }
      const devices: Record<string, number> = {}
      for (const [id, count] of Object.entries(attempts.devices)) {
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new HomeAuthError('STORE_INVALID', `${HOME_AUTH_FILES.pinAttempts} is not a PIN attempts record`)
        devices[id] = count
      }
      this.attempts = { v: PIN_FILE_VERSION, devices, home: attempts.home, paused: attempts.paused }
    }
  }

  /**
   * What PIN mode is now.
   * @returns whether it is on, the kind, the idle minutes and whether PIN unlocks are paused.
   */
  summary(): PinModeSummary {
    const record = this.record
    return {
      enabled: record?.enabled === true,
      kind: record?.enabled === true ? record.kind : undefined,
      idleMinutes: record?.idleMinutes ?? PIN_MODE_LIMITS.defaultIdleMinutes,
      lockWhenHidden: record?.lockWhenHidden ?? false,
      paused: this.attempts.paused,
    }
  }

  /**
   * Set or replace the secret and turn the mode on.
   * @param presented - the PIN or passcode.
   * @param options - the idle minutes (1 to the maximum) and whether the page locks when hidden.
   * @returns the kind of the secret.
   * @throws {HomeAuthError} `PIN_WEAK` for a secret that breaks a rule; `BAD_REQUEST` for idle minutes out of range.
   */
  async set(presented: string, options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined } = {}): Promise<PinKind> {
    const idleMinutes = options.idleMinutes ?? this.record?.idleMinutes ?? PIN_MODE_LIMITS.defaultIdleMinutes
    if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > PIN_MODE_LIMITS.maxIdleMinutes) {
      throw new HomeAuthError('BAD_REQUEST', `an unlock idles out after a whole number of minutes from 1 to ${String(PIN_MODE_LIMITS.maxIdleMinutes)}, got ${String(idleMinutes)}`)
    }
    const { secret, kind } = checkNewSecret(presented)
    const release = this.secrets?.register(secret, 'session-secret')
    try {
      const salt = randomBytes(PIN_MODE_LIMITS.scrypt.saltBytes)
      const { N, r, p } = PIN_MODE_LIMITS.scrypt
      const derived = await this.derive(secret, salt, { N, r, p })
      this.record = {
        v: PIN_FILE_VERSION, enabled: true, kind, setAt: this.now(), setBy: 'computer', idleMinutes,
        lockWhenHidden: options.lockWhenHidden ?? this.record?.lockWhenHidden ?? false,
        hash: { alg: 'scrypt', N, r, p, salt: salt.toString('base64url'), dk: derived.toString('base64url') },
      }
      this.attempts = { v: PIN_FILE_VERSION, devices: {}, home: [], paused: false }
      await this.persist()
      return kind
    } finally {
      release?.()
    }
  }

  /**
   * Turn the mode off and drop the hash and the tries.
   */
  async off(): Promise<void> {
    this.record = undefined
    this.attempts = { v: PIN_FILE_VERSION, devices: {}, home: [], paused: false }
    await this.persist()
  }

  /**
   * Resume PIN unlocks after a home-wide pause, at the computer.
   */
  async resume(): Promise<void> {
    this.attempts = { ...this.attempts, home: [], paused: false }
    await this.persist()
  }

  /**
   * Drop a removed device's count.
   * @param deviceId - the device.
   */
  async forget(deviceId: string): Promise<void> {
    if (!(deviceId in this.attempts.devices)) return
    const { [deviceId]: _gone, ...rest } = this.attempts.devices
    this.attempts = { ...this.attempts, devices: rest }
    await this.persist()
  }

  /**
   * Try a secret for a device: count the try, write the count, then compare.
   * @param deviceId - the device that tries.
   * @param presented - what it sent.
   * @returns the outcome.
   * @throws {HomeAuthError} `PIN_MODE_OFF` when the mode is off.
   */
  check(deviceId: string, presented: string): Promise<PinCheck> {
    const previous = this.tries.get(deviceId) ?? Promise.resolve()
    const run = previous.then(() => this.tryOnce(deviceId, presented))
    const tail = run.catch(() => undefined)
    this.tries.set(deviceId, tail)
    void tail.then(() => { if (this.tries.get(deviceId) === tail) this.tries.delete(deviceId) })
    return run
  }

  /**
   * One try, run alone for its device.
   * @param deviceId - the device.
   * @param presented - the secret as sent.
   * @returns the outcome.
   */
  private async tryOnce(deviceId: string, presented: string): Promise<PinCheck> {
    const record = this.record
    if (record === undefined) throw new HomeAuthError('PIN_MODE_OFF', 'PIN mode is off. Turn it on at your computer')
    if (this.attempts.paused) return { kind: 'paused' }
    const before = this.attempts.devices[deviceId] ?? 0
    if (before >= PIN_MODE_LIMITS.deviceWrongTries) return { kind: 'lockout' }
    const at = this.now()
    const kept = this.attempts.home.filter(time => at - time < PIN_MODE_LIMITS.homeWindowMs)
    this.attempts = { ...this.attempts, devices: { ...this.attempts.devices, [deviceId]: before + 1 }, home: [...kept, at] }
    await this.persist()
    const secret = normalised(presented)
    const release = this.secrets?.register(secret, 'session-secret')
    let matches = false
    try {
      const salt = Buffer.from(record.hash.salt, 'base64url')
      const expected = Buffer.from(record.hash.dk, 'base64url')
      const derived = await this.derive(secret, salt, record.hash, expected.length)
      matches = derived.length === expected.length && timingSafeEqual(derived, expected)
    } finally {
      release?.()
    }
    if (matches) {
      const { [deviceId]: _cleared, ...rest } = this.attempts.devices
      const home = [...this.attempts.home]
      const mine = home.lastIndexOf(at)
      if (mine !== -1) home.splice(mine, 1)
      this.attempts = { ...this.attempts, devices: rest, home }
      await this.persist()
      return { kind: 'ok' }
    }
    const count = this.attempts.devices[deviceId] ?? before + 1
    if (count >= PIN_MODE_LIMITS.deviceWrongTries) return { kind: 'lockout' }
    if (this.attempts.home.length >= PIN_MODE_LIMITS.homeWrongTries) {
      this.attempts = { ...this.attempts, paused: true }
      await this.persist()
    }
    return { kind: 'wrong', triesLeft: PIN_MODE_LIMITS.deviceWrongTries - count }
  }

  /**
   * Derive a key with at most {@link PIN_MODE_LIMITS.concurrentHashes} derivations running.
   * @param secret - the normalised secret.
   * @param salt - the record's salt.
   * @param parameters - the scrypt cost parameters.
   * @param keyBytes - the output length.
   * @returns the derived key.
   */
  private async derive(secret: string, salt: Buffer, parameters: { readonly N: number; readonly r: number; readonly p: number }, keyBytes: number = PIN_MODE_LIMITS.scrypt.keyBytes): Promise<Buffer> {
    while (this.hashing >= PIN_MODE_LIMITS.concurrentHashes) await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    this.hashing += 1
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(secret, salt, keyBytes, { ...parameters, maxmem: PIN_MODE_LIMITS.scrypt.maxmemBytes }, (error, key) => {
          if (error === null) resolve(key)
          else reject(new HomeAuthError('STORE_INVALID', 'the PIN could not be hashed'))
        })
      })
    } finally {
      this.hashing -= 1
      this.waiting.shift()?.()
    }
  }

  /**
   * Write both files after the writes already queued, with the state as it is when this write runs.
   */
  private persist(): Promise<void> {
    const next = this.writes.then(async () => {
      if (this.record === undefined) await writeStoreFile(this.modeFile, { v: PIN_FILE_VERSION, enabled: false })
      else await writeStoreFile(this.modeFile, this.record)
      await writeStoreFile(this.attemptsFile, this.attempts)
    })
    this.writes = next.catch(() => undefined)
    return next
  }
}
