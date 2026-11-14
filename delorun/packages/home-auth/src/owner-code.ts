/**
 * The owner code store: `~/.delorun/secrets/home-auth/owner-code.json`, mode 0600, holding the digest of the one owner
 * code that is outstanding, when it was printed and when it expires.
 *
 * C5 makes a code single-use and 10 minutes long, and keeps only its SHA-256 digest, so a copy of the secrets directory
 * holds no usable code. A new code replaces the previous one. Consuming a code removes the file, and a wrong code
 * leaves the outstanding one in place, so a mistyped digit does not cost the person the code.
 *
 * @module @delorun/home-auth/owner-code
 */
import { unlink } from 'node:fs/promises'
import { DEVICE_APPROVAL_LIMITS, DEVICE_APPROVAL_VERSION } from '@delorun/contract-device-approval'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime, readStoreFile, writeStoreFile } from './files.ts'
import { newOwnerCode, normaliseOwnerCode, hashSecret, secretMatches, systemRandom, type RandomBytes } from './secret.ts'
import type { SecretSink } from '@delorun/contract-operational-logs'

/** The record `owner-code.json` holds. */
export interface OwnerCodeRecord {
  /** The format version, C5's `v`. */
  readonly v: typeof DEVICE_APPROVAL_VERSION
  /** The SHA-256 digest of the code, base64url without padding. The code itself is never stored. */
  readonly hash: string
  /** When the code was printed, in milliseconds since the epoch. */
  readonly issuedAt: number
  /** When it stops being accepted, in milliseconds since the epoch. */
  readonly expiresAt: number
}

/** A code as it is handed to the person who prints it. */
export interface IssuedOwnerCode {
  /** The 26 base32 characters to print once; no store holds them. */
  readonly code: string
  /** When the code stops being accepted, in milliseconds since the epoch. */
  readonly expiresAt: number
}

/** What the owner code store reads and writes. */
export interface OwnerCodeStoreOptions {
  /** The absolute path of `owner-code.json`. */
  readonly file: string
  /** The clock, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The random source; the operating system's by default. */
  readonly random?: RandomBytes
  /** Where an issued code is registered, so no log holds it; none registers nothing. */
  readonly secrets?: SecretSink | undefined
}

/** The one outstanding owner code of a home. */
export class OwnerCodeStore {
  private readonly now: () => number
  private readonly random: RandomBytes

  /** The file, the clock and the random source. */
  private readonly options: OwnerCodeStoreOptions

  /**
   * @param options - the file, the clock and the random source.
   */
  constructor(options: OwnerCodeStoreOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.random = options.random ?? systemRandom
  }

  /**
   * Print a new owner code, replacing any code that was outstanding.
   * @returns the code and its expiry, for the caller to print once.
   */
  async issue(): Promise<IssuedOwnerCode> {
    const issuedAt = this.now()
    const code = newOwnerCode(this.random)
    // A replaced code stays registered: it can still be pasted into a log by the person who held it.
    this.options.secrets?.register(code, 'owner-code')
    const record: OwnerCodeRecord = {
      v: DEVICE_APPROVAL_VERSION,
      hash: hashSecret(code),
      issuedAt,
      expiresAt: issuedAt + DEVICE_APPROVAL_LIMITS.ownerCodeExpiryMs,
    }
    await writeStoreFile(this.options.file, record)
    return { code, expiresAt: record.expiresAt }
  }

  /**
   * Whether a code is outstanding and unexpired, without consuming it.
   * @returns whether a claim would have a code to compare against.
   */
  async outstanding(): Promise<boolean> {
    return (await this.read()) !== undefined
  }

  /**
   * Compare a presented code with the outstanding one and consume it when it matches.
   *
   * A wrong, expired or absent code consumes nothing. An expired code is removed, because keeping it could only ever
   * refuse.
   * @param presented - the code as the person typed it, in either case and with spaces or hyphens.
   * @returns whether the code was the outstanding one; a `true` means it can never be used again.
   */
  async consume(presented: string): Promise<boolean> {
    const record = await this.read()
    if (record === undefined) return false
    const code = normaliseOwnerCode(presented)
    if (code === undefined) return false
    if (!secretMatches(code, record.hash)) return false
    // Consume before answering, so a second presentation of the same code never matches.
    await unlink(this.options.file)
    return true
  }

  /** Remove any outstanding code, as a home's reset does. */
  async clear(): Promise<void> {
    await unlink(this.options.file).catch((error: unknown) => {
      // ENOENT: no code was outstanding.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  /**
   * The outstanding record, or undefined when no code is outstanding or the one that is has expired.
   * @returns the record.
   * @throws {HomeAuthError} `STORE_INVALID` when the file is not a version 1 owner-code record.
   */
  private async read(): Promise<OwnerCodeRecord | undefined> {
    const value = await readStoreFile(this.options.file)
    if (value === undefined) return undefined
    if (!isRecord(value) || value.v !== DEVICE_APPROVAL_VERSION) {
      throw new HomeAuthError('STORE_INVALID', 'owner-code.json is not a version 1 owner code record')
    }
    const { hash, issuedAt, expiresAt } = value
    if (typeof hash !== 'string' || hash === '' || !isTime(issuedAt) || !isTime(expiresAt)) {
      throw new HomeAuthError('STORE_INVALID', 'owner-code.json holds no digest or expiry')
    }
    if (expiresAt <= this.now()) {
      await this.clear()
      return undefined
    }
    return { v: DEVICE_APPROVAL_VERSION, hash, issuedAt, expiresAt }
  }
}
