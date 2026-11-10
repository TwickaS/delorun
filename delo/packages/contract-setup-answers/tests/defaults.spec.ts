import { describe, expect, it } from 'vitest'
import { PROMPTS_OPTIONS, REMOVED_ANSWER_KEYS, SECTION_STATUSES, SETUP_DEFAULTS, SETUP_DEFAULT_PORT } from '../src/index.ts'

describe('setup answers defaults', () => {
  it('holds none of the removed keys, and defaults the prompts to the safer option', () => {
    for (const key of REMOVED_ANSWER_KEYS) expect(SETUP_DEFAULTS).not.toHaveProperty(key)
    expect(SETUP_DEFAULTS.prompts).toBe('safer')
    expect(PROMPTS_OPTIONS).toEqual(['safer', 'stock'])
    expect(SECTION_STATUSES).toEqual(['seen', 'answered', 'skipped'])
    expect(SETUP_DEFAULT_PORT).toBe(3080)
  })
})
