/**
 * The passkey store: `~/.delorun/secrets/home-auth/passkeys.json`, mode 0600, one record per enrolled passkey, and the
 * synchronous view of it the policy reads. A record holds public material and counters only: the credential id, the
 * COSE public key, the sign count, the backup flags, the transports, the creation time, the address, the relying-party
 * id and the enrolling device's id. A copy of the file names no secret and signs nothing.
 *
 * The file is read once when the home starts and every change is written before the view changes, in one queue, so a
 * failed write leaves the view and the file as they were. A passkey is bound to the device that enrolled it: only that
 * device's session may assert it ({@link PasskeyStore.forDevice}).
 *
 * @module @delorun/home-auth/passkeys
 */
import type { DeviceId, StudioAddress } from '@delorun/contract-admission'
import { HOME_AUTH_FILES } from '@delorun/contract-device-approval'
import { HomeAuthError } from './errors.ts'
import { isRecord, isTime, readStoreFile, writeStoreFile } from './files.ts'

/** The format version of `passkeys.json`. */
export const PASSKEY_STORE_VERSION = 1

/** The file's name in the home-auth directory. */
export const PASSKEYS_FILE = HOME_AUTH_FILES.passkeys

/** The most passkeys one device keeps. */
export const MAX_PASSKEYS_PER_DEVICE = 4

/** The most passkeys a home keeps. */
export const MAX_PASSKEYS = 64

/** One enrolled passkey. */
export interface PasskeyRecord {
  /** The credential id, base64url. */
  readonly credentialId: string
  /** The COSE public key, base64url. */
  readonly publicKey: string
  /** The signature counter last seen; 0 for an authenticator that does not count. */
  readonly counter: number
  /** The authenticator's backup-eligible flag at enrolment: a synced passkey sets it. */
  readonly backupEligible: boolean
  /** The backup-state flag at the last assertion. */
  readonly backupState: boolean
  /** The transports the authenticator reported at enrolment. */
  readonly transports: readonly string[]
  /** When it was enrolled, in milliseconds since the epoch. */
  readonly createdAt: number
  /** When it last asserted, or null before its first assertion. */
  readonly lastUsedAt: number | null
  /** The studio address it was enrolled on. */
  readonly address: StudioAddress
  /** The relying-party id it is bound to: the address's host. */
  readonly rpId: string
  /** The device that enrolled it, which alone may assert it. */
  readonly deviceId: DeviceId
}

/**
 * Read the passkey records of a parsed `passkeys.json`.
 * @param value - the parsed file, or undefined for a missing file.
 * @returns the records.
 * @throws {HomeAuthError} `STORE_INVALID` when the file is not a version 1 passkey list.
 */
export function passkeyRecordsOf(value: unknown): readonly PasskeyRecord[] {
  if (value === undefined) return []
  if (!isRecord(value) || value.v !== PASSKEY_STORE_VERSION || !Array.isArray(value.passkeys)) throw new HomeAuthError('STORE_INVALID', `${PASSKEYS_FILE} is not a version ${String(PASSKEY_STORE_VERSION)} passkey list`)
  return value.passkeys.map((item: unknown): PasskeyRecord => {
    if (!isRecord(item)) throw new HomeAuthError('STORE_INVALID', `${PASSKEYS_FILE} holds an entry that is not a passkey`)
    const { credentialId, publicKey, counter, backupEligible, backupState, transports, createdAt, lastUsedAt, address, rpId, deviceId } = item
    const valid = typeof credentialId === 'string' && credentialId !== '' && typeof publicKey === 'string' && publicKey !== ''
      && typeof counter === 'number' && Number.isSafeInteger(counter) && counter >= 0
      && typeof backupEligible === 'boolean' && typeof backupState === 'boolean'
      && Array.isArray(transports) && transports.every(transport => typeof transport === 'string')
      && isTime(createdAt) && (lastUsedAt === null || isTime(lastUsedAt))
      && typeof address === 'string' && typeof rpId === 'string' && typeof deviceId === 'string'
    if (!valid) throw new HomeAuthError('STORE_INVALID', `${PASSKEYS_FILE} holds a passkey with a missing or wrong field`)
    return { credentialId, publicKey, counter, backupEligible, backupState, transports: [...transports] as string[], createdAt, lastUsedAt, address: address as StudioAddress, rpId, deviceId: deviceId as DeviceId }
  })
}

/** The passkeys of one home. */
export class PasskeyStore {
  private readonly file: string
  private records: readonly PasskeyRecord[] = []
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param options - where the file is.
   * @param options.file - the absolute path of `passkeys.json`.
   */
  constructor(options: { readonly file: string }) {
    this.file = options.file
  }

  /**
   * Read the file into the view.
   * @throws {HomeAuthError} `STORE_INVALID` for a file that is not this package's JSON.
   */
  async load(): Promise<void> {
    this.records = passkeyRecordsOf(await readStoreFile(this.file))
  }

  /**
   * Whether any passkey is enrolled.
   * @returns whether one is.
   */
  any(): boolean {
    return this.records.length > 0
  }

  /**
   * Every passkey, in enrolment order.
   * @returns the records.
   */
  list(): readonly PasskeyRecord[] {
    return this.records
  }

  /**
   * The passkeys one device enrolled.
   * @param deviceId - the device.
   * @returns its records.
   */
  forDevice(deviceId: string): readonly PasskeyRecord[] {
    return this.records.filter(record => record.deviceId === deviceId)
  }

  /**
   * One passkey by credential id.
   * @param credentialId - the credential id.
   * @returns the record, or undefined.
   */
  find(credentialId: string): PasskeyRecord | undefined {
    return this.records.find(record => record.credentialId === credentialId)
  }

  /**
   * Add a passkey.
   * @param record - the record.
   * @throws {HomeAuthError} `BAD_REQUEST` for a credential id already enrolled or a full device or home; `STORE_INVALID` for a failed write.
   */
  async add(record: PasskeyRecord): Promise<void> {
    await this.change((records) => {
      if (records.some(existing => existing.credentialId === record.credentialId)) throw new HomeAuthError('BAD_REQUEST', 'this passkey is enrolled already')
      if (records.length >= MAX_PASSKEYS || records.filter(existing => existing.deviceId === record.deviceId).length >= MAX_PASSKEYS_PER_DEVICE) {
        throw new HomeAuthError('BAD_REQUEST', `A device keeps at most ${String(MAX_PASSKEYS_PER_DEVICE)} passkeys. Remove one first`)
      }
      return [...records, record]
    })
  }

  /**
   * Replace the counters of a passkey after an assertion.
   * @param credentialId - the credential id.
   * @param next - the new counter, backup state and use time.
   */
  async recordUse(credentialId: string, next: { readonly counter: number; readonly backupState: boolean; readonly lastUsedAt: number }): Promise<void> {
    await this.change(records => records.map(record => (record.credentialId === credentialId ? { ...record, ...next } : record)))
  }

  /**
   * Remove one passkey.
   * @param credentialId - the credential id.
   * @returns whether a record was removed.
   */
  async remove(credentialId: string): Promise<boolean> {
    const before = this.records.length
    await this.change(records => records.filter(record => record.credentialId !== credentialId))
    return this.records.length !== before
  }

  /**
   * Remove every passkey of a device, as the device's removal does.
   * @param deviceId - the device.
   * @returns how many were removed.
   */
  async removeDevice(deviceId: string): Promise<number> {
    const before = this.records.length
    await this.change(records => records.filter(record => record.deviceId !== deviceId))
    return before - this.records.length
  }

  /**
   * Remove every passkey enrolled on an address other than the one given, as a change of the reach address does.
   * @param address - the address now in force.
   * @returns how many were removed.
   */
  async removeOtherAddresses(address: string): Promise<number> {
    const before = this.records.length
    await this.change(records => records.filter(record => record.address === address))
    return before - this.records.length
  }

  /**
   * Write a changed list, then switch the view to it.
   * @param change - computes the new list from the current one; it may throw to refuse.
   */
  private async change(change: (records: readonly PasskeyRecord[]) => readonly PasskeyRecord[]): Promise<void> {
    const run = this.queue.then(async () => {
      const next = change(this.records)
      if (next === this.records || (next.length === this.records.length && next.every((record, at) => record === this.records[at]))) return
      await writeStoreFile(this.file, { v: PASSKEY_STORE_VERSION, passkeys: next })
      this.records = next
    })
    this.queue = run.catch(() => undefined)
    await run
  }
}
