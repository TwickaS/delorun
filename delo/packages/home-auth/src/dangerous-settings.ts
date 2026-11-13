/**
 * The settings a device loosened while dangerous mode held (C14, "Elevation"): the permission new chats start in, and
 * a computer-only consent switch `DANGEROUS_LIFTABLE_SWITCHES` lists. The reach policy records each such write before
 * it proceeds; when the mode ends the home writes the recorded previous value back through the settings service,
 * unless the person changed the field at the computer since.
 *
 * The record is `~/.delo/secrets/home-auth/reach-dangerous-settings.json`, mode 0600. A lift is held in memory at once
 * and written to the file right after, so a restart still reverts it.
 *
 * @module @delo/home-auth/dangerous-settings
 */
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
}

/** A recorded lift: the value before the first device write and the value the latest one set. */
interface RecordedLift {
  readonly ns: string
  readonly field: string
  /** Absent when the field was unset before the write. */
  readonly previous?: unknown
  /** Absent when the write's value is unknown; the field then reverts whenever it differs from {@link previous}. */
  readonly set?: unknown
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
   */
  record(lifts: readonly SettingsLift[], previousOf: (ns: string, field: string) => unknown): void {
    for (const lift of lifts) {
      const index = this.lifts.findIndex(entry => entry.ns === lift.ns && entry.field === lift.field)
      const previous = index >= 0 ? this.lifts[index]!.previous : previousOf(lift.ns, lift.field)
      const entry: RecordedLift = {
        ns: lift.ns, field: lift.field, ...previous === undefined ? {} : { previous }, ...lift.written === undefined ? {} : { set: lift.written },
      }
      this.lifts = index >= 0 ? this.lifts.map((old, at) => (at === index ? entry : old)) : [...this.lifts, entry]
    }
    this.persist()
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
      const deviceOwned = 'set' in lift ? isDeepStrictEqual(current, lift.set) : !isDeepStrictEqual(current, lift.previous)
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
    const record = { v: DANGEROUS_SETTINGS_VERSION, lifts: this.lifts }
    this.saving = this.saving.then(() => writeStoreFile(this.file, record)).catch((_unwritable: unknown) => {
      // The lift stays in memory and the next change writes the file again.
    })
  }
}
