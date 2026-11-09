/**
 * The device store: `~/.delo/secrets/home-auth/devices.json`, mode 0600, holding one record per trusted device — its id,
 * public key, studio address, label, platform, approval time, approving device and last sign-in time (C5's "Keys and
 * storage").
 *
 * A record holds no credential. What proves a device's sessions is a token whose digest the session store keys on, so a
 * copy of this file names every device without letting anyone act as one.
 *
 * @module @delo/home-auth/devices
 */
import type { DeviceId } from '@delo/contract-admission'
import { DEVICE_APPROVAL_VERSION } from '@delo/contract-device-approval'
import { HomeAuthError } from './errors.ts'
import { readStoreFile, writeStoreFile } from './files.ts'
import { deviceRecordsOf, type DeviceRecord } from './records.ts'

/**
 * The most devices one home trusts: 32, which is more than a person's own computers, phones and browsers and few enough
 * that the store and the sessions it carries stay small. C5 bounds a home's pending requests and a device's unused
 * challenges; this is the same kind of bound over the records a home keeps for good.
 */
export const MAX_TRUSTED_DEVICES = 32

/** The one list of trusted devices of a home. */
export class DeviceStore {
  /**
   * @param options - the absolute path of `devices.json`.
   */
  constructor(private readonly options: { readonly file: string }) {}

  /**
   * Every trusted device, in file order.
   * @returns the records.
   * @throws {HomeAuthError} `STORE_INVALID` when the file is not a version 1 device list.
   */
  async list(): Promise<readonly DeviceRecord[]> {
    return deviceRecordsOf(await readStoreFile(this.options.file))
  }

  /**
   * One device's record.
   * @param id - the device id.
   * @returns the record, or undefined when no record names that id.
   */
  async find(id: DeviceId): Promise<DeviceRecord | undefined> {
    return (await this.list()).find(record => record.id === id)
  }

  /**
   * Add one device record, refusing a second record for the same id and a list that is full.
   *
   * The bound is a bound on the file rather than on trust: every record is a key the home must keep and, with C5's
   * sessions, a device whose sessions stay live, so an unbounded list is an unbounded store that a run of approvals can
   * fill. A person with more devices than the bound removes one first.
   * @param record - the record to add.
   * @throws {HomeAuthError} `DEVICE_NOT_TRUSTED` when the id is already recorded, which no caller may reach: a claim
   *   refuses a home that has an owner, and an approval refuses a request for a known device.
   * @throws {HomeAuthError} `DEVICE_LIMIT_REACHED` when this home already trusts {@link MAX_TRUSTED_DEVICES} devices.
   */
  async add(record: DeviceRecord): Promise<void> {
    const records = await this.list()
    if (records.some(candidate => candidate.id === record.id)) {
      throw new HomeAuthError('DEVICE_NOT_TRUSTED', 'a device with this key is recorded already', { deviceId: record.id })
    }
    if (records.length >= MAX_TRUSTED_DEVICES) {
      throw new HomeAuthError(
        'DEVICE_LIMIT_REACHED',
        `A home trusts at most ${String(MAX_TRUSTED_DEVICES)} devices. Remove one on the home's own computer before approving another`,
        { limit: MAX_TRUSTED_DEVICES },
      )
    }
    await this.write([...records, record])
  }

  /**
   * Remove one device's record.
   * @param id - the device id.
   * @returns whether a record was removed; removing an unknown device changes nothing.
   */
  async remove(id: DeviceId): Promise<boolean> {
    const records = await this.list()
    const kept = records.filter(record => record.id !== id)
    if (kept.length === records.length) return false
    await this.write(kept)
    return true
  }

  /**
   * Replace the recorded device list.
   * @param records - the records to write, in the order a reader shows them.
   */
  async write(records: readonly DeviceRecord[]): Promise<void> {
    await writeStoreFile(this.options.file, { v: DEVICE_APPROVAL_VERSION, devices: records })
  }
}
