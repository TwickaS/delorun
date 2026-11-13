import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { requiredModelKey } from '../src/model-key.ts'
import { profileDirectory } from '../src/profile.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-model-key-'))
  mkdirSync(profileDirectory(home, 'headless'), { recursive: true })
})

afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/**
 * Write the headless profile's patch list.
 * @param rows - the rows.
 */
function patch(rows: readonly unknown[]): void {
  writeFileSync(join(profileDirectory(home, 'headless'), 'cordis.patch.yml'), stringify(rows))
}

describe('the key a profile\'s model needs', () => {
  it('is DeepSeek\'s when the profile selects no model', () => {
    expect(requiredModelKey(home, 'headless', 'delorun headless')).toEqual({ label: 'DeepSeek', variable: 'DEEPSEEK_API_KEY' })
  })

  it('is the selected provider\'s own variable, not DeepSeek\'s', () => {
    patch([{ id: 'agent-default-model', config: { provider: 'openai', model: 'gpt-6.1-sol' } }])
    expect(requiredModelKey(home, 'headless', 'delorun headless')).toEqual({ label: 'OpenAI', variable: 'OPENAI_API_KEY' })
  })

  it('is the variable the route\'s row names', () => {
    patch([{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, { id: 'llm-deepseek', config: { apiKeyEnv: 'WORK_DEEPSEEK_KEY' } }])
    expect(requiredModelKey(home, 'headless', 'delorun headless')).toEqual({ label: 'DeepSeek', variable: 'WORK_DEEPSEEK_KEY' })
  })

  it('is nothing for a route that names no key variable, such as a mock or recorded-session route', () => {
    patch([{ id: 'agent-default-model', config: { provider: 'mock', model: 'recorded' } }])
    expect(requiredModelKey(home, 'headless', 'delorun headless')).toBeUndefined()
  })
})
