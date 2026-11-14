/**
 * How the release-log check's errors read in `@delorun/home`'s refusal format: a verifiable refusal
 * ({@link ReleaseLogRefusalError}), a log that does not answer or answers wrongly, and a failure of this client's own
 * check.
 *
 * @module @delorun/release-verify/refusal
 */
// The refusal helpers alone: this module takes none of @delorun/home's file access.
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delorun/home/refusal'
import { ReleaseLogRefusalError } from './errors.ts'
import { LogContradictionError, LogUnreachableError, ReleaseLogInternalError } from './online.ts'

/** How a {@link ReleaseLogRefusalError} reads: Delorun refused the release, with the check that refused and what it saw. */
export const releaseLogRefusalDescriber: RefusalDescriber<ReleaseLogRefusalError> = refusalDescriber(ReleaseLogRefusalError, error => ({
  lead: 'Delorun refused the release: its release-log check failed.',
  reason: codedReason(error.refusal, error.detail),
  remedies: ['See every check: delorun verify'],
}))

/** How a {@link LogUnreachableError} reads: the release log did not answer. */
export const logUnreachableDescriber: RefusalDescriber<LogUnreachableError> = refusalDescriber(LogUnreachableError, error => ({
  lead: 'Delorun could not reach the release log.',
  reason: error.message,
  remedies: ['Check this computer\'s connection, then run the same command again.'],
}))

/** How a {@link LogContradictionError} reads: the release log answered with something Delorun does not accept. */
export const logContradictionDescriber: RefusalDescriber<LogContradictionError> = refusalDescriber(LogContradictionError, error => ({
  lead: 'The release log answered with something Delorun does not accept.',
  reason: error.message,
  remedies: ['Report this if it repeats.'],
}))

/** How a {@link ReleaseLogInternalError} reads: Delorun's own release-log check failed, which no log answer explains. */
export const releaseLogInternalDescriber: RefusalDescriber<ReleaseLogInternalError> = refusalDescriber(ReleaseLogInternalError, error => ({
  lead: 'Delorun\'s release-log check failed in Delorun itself.',
  reason: error.message,
  remedies: ['Report this.'],
}))

/** Every describer of this package, for a program that reads all of them. */
export const RELEASE_VERIFY_DESCRIBERS: readonly RefusalDescriber[] = [releaseLogRefusalDescriber, logUnreachableDescriber, logContradictionDescriber, releaseLogInternalDescriber]
