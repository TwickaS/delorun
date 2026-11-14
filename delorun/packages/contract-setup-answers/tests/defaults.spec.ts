import { describe, expect, it } from 'vitest'
import { PROMPTS_OPTIONS, REMOVED_ANSWER_KEYS, SECTION_STATUSES, SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS, SETUP_ANSWERS_SCHEMA_VERSION, SETUP_DEFAULTS, SETUP_DEFAULT_PORT, SETUP_DEFAULT_PROVIDER_ID, SETUP_PROVIDER_IDS, SETUP_UPDATE_CHECK_ROW } from '../src/index.ts'

describe('setup answers defaults', () => {
  it('holds none of the removed keys, and defaults the prompts to the safer option', () => {
    for (const key of REMOVED_ANSWER_KEYS) expect(SETUP_DEFAULTS).not.toHaveProperty(key)
    expect(SETUP_DEFAULTS.prompts).toBe('safer')
    expect(PROMPTS_OPTIONS).toEqual(['safer', 'stock', 'dangerous'])
    expect(SECTION_STATUSES).toEqual(['seen', 'answered', 'skipped'])
    expect(SETUP_DEFAULT_PORT).toBe(3080)
  })

  it('defaults the release check on, at schema version 4, reading versions 2 and 3 too, and names the row it writes', () => {
    expect(SETUP_DEFAULTS.updateCheck).toBe(true)
    expect(SETUP_DEFAULTS.schemaVersion).toBe(SETUP_ANSWERS_SCHEMA_VERSION)
    expect(SETUP_ANSWERS_SCHEMA_VERSION).toBe(4)
    expect(SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS).toEqual([2, 3])
    expect(SETUP_UPDATE_CHECK_ROW).toBe('delorun-update-check')
  })

  it('starts the provider question on DeepSeek, one of the providers it lists, which are sorted by id', () => {
    expect(SETUP_DEFAULTS.modelProvider).toEqual({ id: SETUP_DEFAULT_PROVIDER_ID, credential: { source: 'prompt' }, baseURL: null, model: null })
    expect(SETUP_PROVIDER_IDS).toContain(SETUP_DEFAULT_PROVIDER_ID)
    expect([...SETUP_PROVIDER_IDS].sort()).toEqual(SETUP_PROVIDER_IDS)
  })

  it('leaves the changes protection setting as it is', () => {
    expect(SETUP_DEFAULTS.protectChanges).toBe(false)
  })
})
