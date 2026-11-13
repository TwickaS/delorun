/**
 * How every contract C19 error code reads as a refusal: a lead naming what Delorun did, the code with its detail, and the
 * commands that show or change where the profile stands, for the profile the command named.
 */
import type { HomeProcessErrorCode } from '@delo/contract-home-process'
import { describeFailure } from '@delo/home'
import { describe, expect, it } from 'vitest'
import { HomeProcessError, homeProcessDescriber } from '../src/index.ts'

const CODES: readonly HomeProcessErrorCode[] = [
  'UNAUTHENTICATED', 'SCHEMA_VIOLATION', 'REQUEST_TIMEOUT', 'REQUEST_TOO_LARGE', 'BUSY', 'UPDATE_IN_PROGRESS', 'REPORT_EXPIRED',
  'UPDATE_PENDING', 'CHATS_RUNNING', 'DRAIN_TIMEOUT', 'HEALTH_CHECK_FAILED', 'VERIFY_FAILED', 'CHANNEL_UNREACHABLE', 'GIT_UNAVAILABLE', 'HARNESS_CHANGES_PENDING', 'HARNESS_COPY_UNREADABLE', 'HARNESS_REPORT_STALE', 'NO_PREVIOUS', 'NO_UPDATE_RECORD',
  'DATA_COPY_NO_SPACE', 'ROLLBACK_NEEDS_DATA_COPY', 'ROLLBACK_TARGET_UNUSABLE', 'HOST_STOP_FAILED', 'NO_RUNTIME_STORE',
  'LOOPBACK_REQUIRED', 'APPROVAL_FAILED', 'APPROVALS_UNAVAILABLE', 'REMOVAL_FAILED', 'ELEVATION_FAILED', 'CONSENT_UNAVAILABLE', 'STALE_REVIEW', 'CONSENT_FAILED', 'REACH_UNAVAILABLE', 'STUDIO_UNAVAILABLE',
]

describe('a home-process refusal', () => {
  it.each(CODES)('leads with what Delorun did for %s, and keeps the code and detail', (code) => {
    const refusal = describeFailure(new HomeProcessError(code, 'the detail'), [homeProcessDescriber], { profile: 'work' })
    expect(refusal.lead).toMatch(/^(Delorun|The home process|The new release) .+\.$/u)
    expect(refusal.reason).toBe(`${code}: the detail`)
    for (const remedy of refusal.remedies) expect(remedy).not.toContain('--profile default')
  })

  it('reads a code without a detail as the code alone', () => {
    expect(describeFailure(new HomeProcessError('UNAUTHENTICATED'), [homeProcessDescriber]).reason).toBe('UNAUTHENTICATED')
  })

  it('offers the profile-only rollback and safe mode when going back needs a data copy', () => {
    expect(describeFailure(new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', 'no copy'), [homeProcessDescriber], { profile: 'work' }).remedies).toEqual([
      'Restore the profile and keep this release: delorun recover rollback --profile-only --profile work',
      'Start in safe mode: delorun recover safe-mode --profile work',
    ])
    expect(describeFailure(new HomeProcessError('NO_UPDATE_RECORD'), [homeProcessDescriber]).remedies).toEqual(['See where the profile stands: delorun recover status'])
  })
})
