/**
 * The typed refusal the pre-update report raises: a target release that failed one of its checks has no report, a
 * version that is not a semantic version is refused before anything is read, and a report whose context was disposed
 * is not returned. Each code names a decision contract C3 (`delorun/docs/contracts/c03-update-report.md`) gives the
 * report, so a caller tells a refused report from a failed one without reading the sentence.
 *
 * @module @delorun/update/errors
 */

/** Why a report was refused. */
export type UpdateReportErrorCode =
  /** The target failed its signature, freshness or log check; R2: no report exists for it. */
  | 'REPORT_TARGET_UNVERIFIED'
  /** The requested version is not a semantic version, so no installed release can be named by it. */
  | 'REPORT_VERSION_INVALID'
  /** The context that owns the build was disposed before the report was returned. */
  | 'REPORT_DISPOSED'

/** A refused report. */
export class UpdateReportError extends Error {
  /** The refusal's code. */
  readonly code: UpdateReportErrorCode
  /** The refused value or the reason, for the person reading the failure. */
  readonly detail?: string | undefined

  /**
   * @param code - the refusal's code.
   * @param detail - the refused value or the reason, for the person reading the failure.
   */
  constructor(code: UpdateReportErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.code = code
    this.detail = detail
    this.name = 'UpdateReportError'
  }
}

/** Why a session-data copy, a restore or a rollback was refused. */
export type DataSafetyErrorCode =
  /** The copy would not fit on the home's filesystem (C3, "Data formats"). */
  | 'DATA_COPY_NO_SPACE'
  /** The data differs, the target started and no copy exists: going back would hand newer data to an older release. */
  | 'ROLLBACK_NEEDS_DATA_COPY'
  /** A restore's journal, or the directories it names, are not in a state a restore leaves. */
  | 'DATA_RESTORE_INCONSISTENT'
  /** A path named for removal is not a copy or set-aside directory of the home. */
  | 'NOT_KEPT_DATA'
  /** The home's `sessions/` or `storages/` is a symbolic link or not a directory, so no copy is taken of it. */
  | 'DATA_NOT_A_DIRECTORY'
  /** A restore or a rollback is in progress, or an update record refers to the copy, so it is not removed or replaced. */
  | 'DATA_IN_USE'

/** A refused session-data copy, restore or rollback; nothing has changed when it is thrown before a step ran. */
export class DataSafetyError extends Error {
  /** The refusal's code. */
  readonly code: DataSafetyErrorCode
  /** The reason, for the person reading the failure. */
  readonly detail: string

  /**
   * @param code - the refusal's code.
   * @param detail - the reason, for the person reading the failure.
   * @param options - the cause.
   */
  constructor(code: DataSafetyErrorCode, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options)
    this.code = code
    this.detail = detail
    this.name = 'DataSafetyError'
  }
}

/**
 * Whether an error is a {@link DataSafetyError}, with one code when a code is given.
 * @param error - the error.
 * @param code - the code, or `undefined` for any.
 * @returns true when it is.
 */
export function isDataSafetyError(error: unknown, code?: DataSafetyErrorCode): error is DataSafetyError {
  return error instanceof DataSafetyError && (code === undefined || error.code === code)
}
