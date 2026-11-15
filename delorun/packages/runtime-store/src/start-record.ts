/**
 * What a start check of the runtime's files did, and the record of it the launcher hands to the runtime it starts in
 * `DELORUN_START_CHECK` (contract C1's launch protocol 1). The runtime reports the record, so a studio shows the start's
 * result without hashing again. The record crosses a process boundary and any program running as the person can set
 * it, so {@link parseStartCheckHandoff} validates it, and nothing reads it as a reason to skip a check.
 *
 * @module @delorun/runtime-store/start-record
 */

/** The record's schema name and major version. */
export const START_CHECK_SCHEMA = 'delorun.start-check/1'

/** What one start check of an installation's files did. */
export interface StartCheckSummary {
  /** Whether it hashed every listed file. */
  readonly full: boolean
  /** How many files it hashed. */
  readonly hashed: number
  /** How many files the signed file list names. */
  readonly files: number
  /**
   * When the last pass that hashed every file started, in milliseconds since the epoch: this check's own time when it
   * was one, otherwise the identity record's; `null` when neither is known.
   */
  readonly fullCheckAt: number | null
}

/** The record the launcher hands to the runtime it starts. */
export interface StartCheckHandoff extends StartCheckSummary {
  readonly schema: typeof START_CHECK_SCHEMA
  /** The version that passed the check and is started. */
  readonly release: string
  /** When the check ran, in milliseconds since the epoch. */
  readonly at: number
  /** The launcher that ran it: its package version, `null` when it does not read, and its package directory. */
  readonly launcher: { readonly version: string | null, readonly path: string }
  /**
   * `runtime` when the runtime made the record from a start check of its own files, because the process that started it
   * could not hand one over; absent in the launcher's record, which never writes this key.
   */
  readonly checkedBy?: 'runtime'
}

/**
 * The record's text for the environment variable.
 * @param handoff - the record.
 * @returns its JSON text.
 */
export function startCheckHandoffText(handoff: StartCheckHandoff): string {
  const { schema, release, at, full, hashed, files, fullCheckAt, launcher, checkedBy } = handoff
  return JSON.stringify({ schema, release, at, full, hashed, files, fullCheckAt, launcher: { version: launcher.version, path: launcher.path }, ...checkedBy === undefined ? {} : { checkedBy } })
}

/**
 * Whether a value is a non-negative safe integer.
 * @param value - the value.
 * @returns true when it is.
 */
function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Read the record from the environment variable's text, refusing anything that is not exactly one.
 * @param text - the variable's value, or `undefined` when it is unset.
 * @returns the record, or `undefined` when the variable is unset, not JSON or not a record.
 */
export function parseStartCheckHandoff(text: string | undefined): StartCheckHandoff | undefined {
  if (text === undefined || text === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON: the start check is reported as unknown.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'at,files,full,fullCheckAt,hashed,launcher,release,schema' && keys !== 'at,checkedBy,files,full,fullCheckAt,hashed,launcher,release,schema') return undefined
  const { schema, release, at, full, hashed, files, fullCheckAt, launcher, checkedBy } = record
  if (checkedBy !== undefined && checkedBy !== 'runtime') return undefined
  if (schema !== START_CHECK_SCHEMA || typeof release !== 'string' || typeof full !== 'boolean') return undefined
  if (!isWhole(at) || !isWhole(hashed) || !isWhole(files) || (fullCheckAt !== null && !isWhole(fullCheckAt))) return undefined
  if (hashed > files) return undefined
  if (typeof launcher !== 'object' || launcher === null || Array.isArray(launcher)) return undefined
  const { version, path } = launcher as Record<string, unknown>
  if (Object.keys(launcher).sort().join(',') !== 'path,version' || (version !== null && typeof version !== 'string') || typeof path !== 'string') return undefined
  return { schema, release, at, full, hashed, files, fullCheckAt, launcher: { version, path }, ...checkedBy === undefined ? {} : { checkedBy } }
}
