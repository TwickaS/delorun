/**
 * The settings a device loosened while dangerous mode held (C14, "Elevation"): the permission new chats start in, and
 * a computer-only consent switch `DANGEROUS_LIFTABLE_SWITCHES` lists. The reach policy records each such write before
 * it proceeds; when the mode ends the home writes the recorded previous value back through the settings service,
 * unless the person changed the field at the computer since.
 *
 * The record is `~/.delorun/secrets/home-auth/reach-dangerous-settings.json`, mode 0600. A lift is saved to the file
 * before {@link DangerousSettingsLedger.record} returns, so a restart still reverts it and a device's write that could
 * not be recorded is refused.
 *
 * @module @delorun/home-auth/dangerous-settings
 */
import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { readStoreFile, writeStoreFile, isRecord } from './files.ts'

/** Format version of the record. */
export const DANGEROUS_SETTINGS_VERSION = 1 as const

/** One settings field a device wrote while dangerous mode held. */
export interface SettingsLift {
  /** The settings namespace. */
  readonly ns: string
  /** The field the write loosened. */
  readonly field: string
  /** The value the write set, or undefined when the call's arguments do not name one. */
  readonly written: unknown
  /** Whether the call removes the field, so that it reads as unset afterwards. */
  readonly unset?: true
}

/** A recorded lift: the value before the first device write and the value the latest one set. */
interface RecordedLift {
  readonly ns: string
  readonly field: string
  /** Absent when the field was unset before the write. */
  readonly previous?: unknown
  /** Absent when the write's value is unknown; the field then reverts whenever it differs from {@link previous}. */
  readonly set?: unknown
  /** Set when the device's write left the field unset: the field reverts only while it is still unset. */
  readonly unset?: true
}

/** How the ledger reads and writes a settings field. */
export interface SettingsFieldAccess {
  /**
   * @param ns - the settings namespace.
   * @param field - the field.
   * @returns the live value, or undefined when it is unset or the namespace is not configurable now.
   */
  read(ns: string, field: string): unknown
  /**
   * @param ns - the settings namespace.
   * @param field - the field.
   * @param value - the value to write; undefined unsets the field.
   * @returns when the settings service has applied it.
   */
  write(ns: string, field: string, value: unknown): Promise<void>
}

/** The lifts of one home. */
export class DangerousSettingsLedger {
  private readonly file: string
  private lifts: RecordedLift[] = []
  private saving: Promise<void> = Promise.resolve()
  private reverting: Promise<void> | undefined

  /**
   * @param file - the absolute path of `reach-dangerous-settings.json`.
   */
  constructor(file: string) {
    this.file = file
  }

  /**
   * Read the record the last run left.
   * @throws {HomeAuthError} `STORE_INVALID` when the file is refused or is not this package's JSON.
   */
  async load(): Promise<void> {
    const value = await readStoreFile(this.file)
    if (value === undefined) return
    const lifts = isRecord(value) && value.v === DANGEROUS_SETTINGS_VERSION && Array.isArray(value.lifts) ? value.lifts as unknown[] : undefined
    if (lifts === undefined || !lifts.every(lift => isRecord(lift) && typeof lift.ns === 'string' && typeof lift.field === 'string')) {
      throw new Error(`${this.file} does not hold this version's record of dangerous-mode settings`)
    }
    this.lifts = lifts as RecordedLift[]
  }

  /**
   * Whether a recorded lift waits for the mode to end.
   * @returns whether any does.
   */
  pending(): boolean {
    return this.lifts.length > 0
  }

  /**
   * Record the writes a device is about to make. A field already recorded keeps its first previous value.
   * @param lifts - the writes.
   * @param previousOf - the field's live value before the write.
   * @throws the filesystem failure when the record cannot be saved; the lifts are then not recorded.
   */
  record(lifts: readonly SettingsLift[], previousOf: (ns: string, field: string) => unknown): void {
    const before = this.lifts
    for (const lift of lifts) {
      const index = this.lifts.findIndex(entry => entry.ns === lift.ns && entry.field === lift.field)
      const previous = index >= 0 ? this.lifts[index]!.previous : previousOf(lift.ns, lift.field)
      const entry: RecordedLift = {
        ns: lift.ns, field: lift.field, ...previous === undefined ? {} : { previous }, ...lift.written === undefined ? {} : { set: lift.written },
        ...lift.unset === true ? { unset: true as const } : {},
      }
      this.lifts = index >= 0 ? this.lifts.map((old, at) => (at === index ? entry : old)) : [...this.lifts, entry]
    }
    try {
      this.saveNow()
    } catch (error) {
      this.lifts = before
      throw error
    }
  }

  /** Write the record synchronously, so a caller returns only once it is on disk. */
  private saveNow(): void {
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ v: DANGEROUS_SETTINGS_VERSION, lifts: this.lifts }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  /**
   * Write every recorded previous value back once dangerous mode no longer holds, except a field the person changed
   * since the device wrote it. A failed write keeps its lift, so the next call retries it.
   * @param access - the settings fields.
   * @param dangerous - whether dangerous mode holds now.
   * @returns when the pass is done.
   */
  revert(access: SettingsFieldAccess, dangerous: () => boolean): Promise<void> {
    this.reverting ??= this.revertAll(access, dangerous).finally(() => { this.reverting = undefined })
    return this.reverting
  }

  private async revertAll(access: SettingsFieldAccess, dangerous: () => boolean): Promise<void> {
    for (const lift of [...this.lifts]) {
      if (dangerous()) return
      const current = access.read(lift.ns, lift.field)
      const deviceOwned = lift.unset === true ? current === undefined : 'set' in lift ? isDeepStrictEqual(current, lift.set) : !isDeepStrictEqual(current, lift.previous)
      try {
        if (deviceOwned) await access.write(lift.ns, lift.field, lift.previous)
      } catch (_unwritable: unknown) {
        // The field keeps the device's value and its lift, and the next read of the mode retries the write.
        continue
      }
      this.lifts = this.lifts.filter(entry => entry !== lift)
      this.persist()
    }
    await this.saving
  }

  private persist(): void {
    // Read at write time, so a queued write never replaces a newer record saved by `record`.
    this.saving = this.saving.then(() => writeStoreFile(this.file, { v: DANGEROUS_SETTINGS_VERSION, lifts: this.lifts })).catch((_unwritable: unknown) => {
      // The lift stays in memory and the next change writes the file again.
    })
  }
}
