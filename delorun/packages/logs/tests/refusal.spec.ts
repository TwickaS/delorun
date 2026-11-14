/** How a log failure reads as a refusal: what Delorun did with the log, the code, and the report naming the path. */
import { describeFailure } from '@delorun/home'
import { describe, expect, it } from 'vitest'
import { LogsError, logsDescriber } from '../src/index.ts'

describe('a log refusal', () => {
  it('names the log it could not write, or the refused profile name', () => {
    expect(describeFailure(new LogsError('LOG_WRITE_FAILED', 'cannot write /h/logs/home.log', '/h/logs/home.log'), [logsDescriber])).toEqual({ lead: 'Delorun could not write or change the log /h/logs/home.log.', reason: 'LOG_WRITE_FAILED: cannot write /h/logs/home.log', remedies: [] })
    expect(describeFailure(new LogsError('LOG_WRITE_FAILED', 'cannot write'), [logsDescriber]).lead).toBe('Delorun could not write or change the log.')
    expect(describeFailure(new LogsError('PROFILE_INVALID', 'a/b is not a profile name'), [logsDescriber])).toEqual({ lead: 'Delorun refused the profile name for its logs.', reason: 'PROFILE_INVALID: a/b is not a profile name', remedies: [] })
  })
})
