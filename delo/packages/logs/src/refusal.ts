/**
 * How a {@link LogsError} reads in `@delo/home`'s refusal format. A log directory or file C1 refuses is a
 * `HomeLayoutError`, which `@delo/home`'s own describer reads.
 *
 * @module @delo/logs/refusal
 */
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delo/home'
import { LogsError } from './errors.ts'

/** How a {@link LogsError} reads: what Delo did with the log, its code and the report naming the path. */
export const logsDescriber: RefusalDescriber<LogsError> = refusalDescriber(LogsError, (error) => {
  switch (error.code) {
    case 'PROFILE_INVALID':
      return { lead: 'Delorun refused the profile name for its logs.', reason: codedReason(error.code, error.message), remedies: [] }
    case 'LOG_WRITE_FAILED':
      return { lead: `Delorun could not write or change the log${error.path === undefined ? '' : ` ${error.path}`}.`, reason: codedReason(error.code, error.message), remedies: [] }
  }
})
