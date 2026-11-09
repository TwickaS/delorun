/**
 * The typed refusal the pre-update report raises: a target release that failed one of its checks has no report, a
 * version that is not a semantic version is refused before anything is read, and a report whose context was disposed
 * is not returned. Each code names a decision contract C3 (`delo/docs/contracts/c03-update-report.md`) gives the
 * report, so a caller tells a refused report from a failed one without reading the sentence.
 *
 * @module @delo/update/errors
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
  /**
   * @param code - the refusal's code.
   * @param detail - the refused value or the reason, for the person reading the failure.
   */
  constructor(readonly code: UpdateReportErrorCode, readonly detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'UpdateReportError'
  }
}
