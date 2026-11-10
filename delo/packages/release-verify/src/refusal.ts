/**
 * How the release-log check's errors read in `@delo/home`'s refusal format: a verifiable refusal
 * ({@link ReleaseLogRefusalError}), a log that does not answer or answers wrongly, and a failure of this client's own
 * check.
 *
 * @module @delo/release-verify/refusal
 */
// The refusal helpers alone: this module takes none of @delo/home's file access.
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delo/home/refusal'
import { ReleaseLogRefusalError } from './errors.ts'
import { LogContradictionError, LogUnreachableError, ReleaseLogInternalError } from './online.ts'

/** How a {@link ReleaseLogRefusalError} reads: Delo refused the release, with the check that refused and what it saw. */
export const releaseLogRefusalDescriber: RefusalDescriber<ReleaseLogRefusalError> = refusalDescriber(ReleaseLogRefusalError, error => ({
  lead: 'Delo refused the release: its release-log check failed.',
  reason: codedReason(error.refusal, error.detail),
  remedies: ['See every check: delorun verify'],
}))

/** How a {@link LogUnreachableError} reads: the release log did not answer. */
export const logUnreachableDescriber: RefusalDescriber<LogUnreachableError> = refusalDescriber(LogUnreachableError, error => ({
  lead: 'Delo could not reach the release log.',
  reason: error.message,
  remedies: ['Check this computer\'s connection, then run the same command again.'],
}))

/** How a {@link LogContradictionError} reads: the release log answered with something Delo does not accept. */
export const logContradictionDescriber: RefusalDescriber<LogContradictionError> = refusalDescriber(LogContradictionError, error => ({
  lead: 'The release log answered with something Delo does not accept.',
  reason: error.message,
  remedies: ['Report this if it repeats.'],
}))

/** How a {@link ReleaseLogInternalError} reads: Delo's own release-log check failed, which no log answer explains. */
export const releaseLogInternalDescriber: RefusalDescriber<ReleaseLogInternalError> = refusalDescriber(ReleaseLogInternalError, error => ({
  lead: 'Delo\'s release-log check failed in Delo itself.',
  reason: error.message,
  remedies: ['Report this.'],
}))

/** Every describer of this package, for a program that reads all of them. */
export const RELEASE_VERIFY_DESCRIBERS: readonly RefusalDescriber[] = [releaseLogRefusalDescriber, logUnreachableDescriber, logContradictionDescriber, releaseLogInternalDescriber]
