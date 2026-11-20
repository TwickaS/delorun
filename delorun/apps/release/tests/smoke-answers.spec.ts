import { describe, expect, it } from 'vitest'
import { SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS, SETUP_ANSWERS_SCHEMA_VERSION } from '../../../packages/contract-setup-answers/src/index.ts'
import { parseAnswers } from '../../cli/src/setup/answers.ts'
import { PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, SMOKE_ANSWERS_SCHEMA_VERSION, smokeAnswers } from '../src/installed-smoke/answers.ts'

describe('the installed smoke\'s setup answers', () => {
  it('give the release under test the version its setup writes, which it reads', () => {
    expect(SMOKE_ANSWERS_SCHEMA_VERSION).toBe(SETUP_ANSWERS_SCHEMA_VERSION)
    expect(parseAnswers(JSON.parse(smokeAnswers(SMOKE_ANSWERS_SCHEMA_VERSION, 4321))).success).toBe(true)
  })

  it('give the previous release version 4, the highest a release before version 5 reads, with no phonePowers', () => {
    // Step 6 once fed the previous release this release's version-5 document, which a version-4 setup refuses.
    const previous: unknown = JSON.parse(smokeAnswers(PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, 4321))
    expect(previous).toMatchObject({ schemaVersion: 4 })
    expect(previous).not.toHaveProperty('phonePowers')
    // A later previous release reads it as an earlier document.
    expect(SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS).toContain(PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION)
    expect(parseAnswers(previous).success).toBe(true)
  })

  it('differ only in the schema version', () => {
    const current: unknown = JSON.parse(smokeAnswers(SMOKE_ANSWERS_SCHEMA_VERSION, 4321))
    const previous: unknown = JSON.parse(smokeAnswers(PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, 4321))
    expect({ ...(previous as object), schemaVersion: SMOKE_ANSWERS_SCHEMA_VERSION }).toEqual(current)
  })
})
