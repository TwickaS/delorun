import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETUP_DEFAULTS, type ModelProviderAnswer } from '@delorun/contract-setup-answers'
import { currentAnswers } from '../../src/setup/current.ts'
import { ANSWERS_FILENAME, readPromptsRows, setPatchRow, writePromptRows } from '@delorun/setup-apply'
import { readProviderAnswer, writeProviderRows } from '../../src/setup/providers.ts'
import { readUpdateCheckRow, writeUpdateCheckRow } from '../../src/setup/update-check.ts'
import { hasStoredCredential, storeCredential } from '../../src/setup/writes.ts'

let directory: string
let patch: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-current-')))
  patch = join(directory, 'cordis.patch.yml')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the readers that pair with the section writes', () => {
  it('reads the release check the write produced, and the bundle value when the patch sets none', () => {
    expect(readUpdateCheckRow(patch)).toBe(true)
    writeUpdateCheckRow(patch, false)
    expect(readUpdateCheckRow(patch)).toBe(false)
    writeUpdateCheckRow(patch, true)
    expect(readUpdateCheckRow(patch)).toBe(true)
  })

  it('reads each prompts answer back from its rows, and none from an empty patch', () => {
    expect(readPromptsRows(patch)).toBeUndefined()
    for (const answer of ['safer', 'stock', 'dangerous'] as const) {
      writePromptRows(patch, answer)
      expect(readPromptsRows(patch)).toBe(answer)
    }
  })

  it('reads a provider, model and endpoint back, keeping the recorded key choice for the same reference', () => {
    const recorded: ModelProviderAnswer = { id: 'openai-compatible', credential: { source: 'environment', name: 'OPENAI_COMPATIBLE_API_KEY' }, baseURL: 'https://models.example.test/v1', model: 'local-model' }
    expect(readProviderAnswer(patch, recorded)).toBe(recorded)
    writeProviderRows(patch, recorded)
    expect(readProviderAnswer(patch, null)).toEqual({ ...recorded, credential: { source: 'prompt' } })
    expect(readProviderAnswer(patch, recorded)).toEqual(recorded)
  })

  it('reads a DeepSeek default model as no model, and a chosen one as itself', () => {
    const answer: ModelProviderAnswer = { id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: null }
    writeProviderRows(patch, answer)
    expect(readProviderAnswer(patch, answer)).toBe(answer)
    writeProviderRows(patch, { ...answer, model: 'deepseek-pro' })
    expect(readProviderAnswer(patch, null)?.model).toBe('deepseek-pro')
  })

  it('tells a saved key from an absent one without returning it', async () => {
    expect(hasStoredCredential(directory, 'DEEPSEEK_API_KEY')).toBe(false)
    await storeCredential(directory, 'DEEPSEEK_API_KEY', 'a-key')
    expect(hasStoredCredential(directory, 'DEEPSEEK_API_KEY')).toBe(true)
    expect(hasStoredCredential(directory, 'OTHER_KEY')).toBe(false)
  })
})

describe('the answers a profile holds now', () => {
  it('falls back to the answers record where the configuration holds nothing', () => {
    writeFileSync(join(directory, ANSWERS_FILENAME), JSON.stringify({ version: 1, ...SETUP_DEFAULTS, useCase: 'remote', background: false, modelProvider: null }))
    const current = currentAnswers(directory)
    expect(current).toMatchObject({ useCase: 'remote', background: false, modelProvider: null, prompts: 'safer', updateCheck: true, profile: { port: null }, reach: { option: 'none' }, sections: [] })
  })

  // Removing the ignored-keys filter makes a record that still holds the removed `phonePowers` answer fall back to the defaults.
  it('reads a record that still holds the removed phonePowers answer, and ignores it', () => {
    writeFileSync(join(directory, ANSWERS_FILENAME), JSON.stringify({ version: 1, ...SETUP_DEFAULTS, schemaVersion: 4, useCase: 'remote', phonePowers: 'full' }))
    const current = currentAnswers(directory)
    expect(current).toMatchObject({ useCase: 'remote' })
    expect(current).not.toHaveProperty('phonePowers')
  })

  it('lets the live rows win over the record, including a studio port', () => {
    writeFileSync(join(directory, ANSWERS_FILENAME), JSON.stringify({ version: 1, ...SETUP_DEFAULTS }))
    writePromptRows(patch, 'stock')
    writeUpdateCheckRow(patch, false)
    setPatchRow(patch, { id: 'webserver', config: { host: '127.0.0.1', port: 4100 } })
    expect(currentAnswers(directory)).toMatchObject({ prompts: 'stock', updateCheck: false, profile: { port: 4100 } })
  })
})
