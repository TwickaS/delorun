/** How the release-log check's errors read as refusals: the refusing check, an unreachable or contradicting log, and Delo's own failure. */
import { describeFailure, type Refusal } from '@delo/home'
import { describe, expect, it } from 'vitest'
import { ReleaseLogRefusalError } from '../src/errors.ts'
import { LogContradictionError, LogUnreachableError, ReleaseLogInternalError } from '../src/online.ts'
import { RELEASE_VERIFY_DESCRIBERS } from '../src/refusal.ts'

const describeOne = (error: unknown): Refusal => describeFailure(error, RELEASE_VERIFY_DESCRIBERS)

describe('a release-log refusal', () => {
  it('names the check that refused, and each log failure', () => {
    expect(describeOne(new ReleaseLogRefusalError('checkpoint-rolled-back', 'tree 3 is smaller than 5'))).toEqual({ lead: 'Delo refused the release: its release-log check failed.', reason: 'checkpoint-rolled-back: tree 3 is smaller than 5', remedies: ['See every check: delorun verify'] })
    expect(describeOne(new LogUnreachableError('timed out'))).toEqual({ lead: 'Delo could not reach the release log.', reason: 'timed out', remedies: ['Check this computer\'s connection, then run the same command again.'] })
    expect(describeOne(new LogContradictionError('a tile of 31 bytes'))).toEqual({ lead: 'The release log answered with something Delo does not accept.', reason: 'a tile of 31 bytes', remedies: ['Report this if it repeats.'] })
    expect(describeOne(new ReleaseLogInternalError('a bug'))).toEqual({ lead: 'Delo\'s release-log check failed in Delo itself.', reason: 'a bug', remedies: ['Report this.'] })
  })
})
