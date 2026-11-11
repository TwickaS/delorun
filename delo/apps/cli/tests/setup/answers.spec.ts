import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOVED_ANSWER_KEYS } from '@delo/contract-setup-answers'
import { readAnswersDocument, yesAnswers } from '../../src/setup/answers.ts'
import { CliError, EXIT } from '../../src/exit.ts'

const BASE = {
  schemaVersion: 3,
  modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } },
  prompts: 'safer',
  background: true,
  profile: { name: null, port: null },
  reach: { option: 'none', identityFactor: null },
  importStockHome: false,
}

let directory: string

/**
 * Write an answers document.
 * @param name - the file name.
 * @param document - its content.
 * @returns the path.
 */
function write(name: string, document: unknown): string {
  const path = join(directory, name)
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document))
  return path
}

/**
 * @param path - an answers document.
 * @returns the refusal message, or the empty string when the document was accepted.
 */
function refusal(path: string): string {
  try {
    readAnswersDocument(path)
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exit).toBe(EXIT.failed)
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-answers-')))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the answers document', () => {
  it('accepts a document with every field, sections absent', () => {
    const answers = readAnswersDocument(write('ok.json', BASE))
    expect(answers.prompts).toBe('safer')
    expect(answers.sections).toEqual([])
  })

  it('reads the release-check answer, on when the document leaves it out', () => {
    expect(readAnswersDocument(write('absent.json', BASE)).updateCheck).toBe(true)
    expect(readAnswersDocument(write('off.json', { ...BASE, updateCheck: false })).updateCheck).toBe(false)
    expect(refusal(write('text.json', { ...BASE, updateCheck: 'no' }))).toContain('updateCheck is not a value the answers document accepts')
  })

  it('reads a version-2 document as version 3 with the check on, and refuses the release-check answer in one', () => {
    const version2 = { ...BASE, schemaVersion: 2 }
    expect(readAnswersDocument(write('version-2.json', version2))).toMatchObject({ schemaVersion: 3, updateCheck: true, prompts: 'safer' })
    expect(refusal(write('version-2-off.json', { ...version2, updateCheck: false }))).toBe('delorun setup --config: updateCheck needs schemaVersion 3')
    expect(refusal(write('version-2-unknown.json', { ...version2, apiKey: 'sk-SECRET-VALUE-81' }))).toContain('the document holds a field the answers document does not define')
  })

  it('refuses a document that carries a removed question, naming the removed keys and no value', () => {
    for (const key of REMOVED_ANSWER_KEYS) {
      const message = refusal(write(`${key}.json`, { ...BASE, [key]: 'sk-SECRET-VALUE-77' }))
      expect(message).toContain(`holds ${key}, which setup no longer asks`)
      expect(message).not.toContain('sk-SECRET-VALUE-77')
    }
    const several = refusal(write('several.json', { schemaVersion: 1, studioAdditions: true, runtime: { kind: 'native' }, desktopAnalytics: false }))
    expect(several).toContain('holds studioAdditions, runtime, desktopAnalytics, which setup no longer asks; remove them from the document')
  })

  it('refuses an unknown key nested in a section without echoing it', () => {
    const nested = refusal(write('nested.json', { ...BASE, profile: { name: null, port: null, token: 'sk-SECRET-VALUE-80' } }))
    expect(nested).toContain('profile holds a field the answers document does not define')
    expect(nested).not.toContain('sk-SECRET-VALUE-80')
  })

  it('refuses an unknown key without echoing it, and any other schema version', () => {
    const unknown = refusal(write('unknown.json', { ...BASE, apiKey: 'sk-SECRET-VALUE-78' }))
    expect(unknown).toContain('holds a field the answers document does not define')
    expect(unknown).not.toContain('sk-SECRET-VALUE-78')
    expect(refusal(write('version.json', { ...BASE, schemaVersion: 1 }))).toContain('schemaVersion must be 3, or 2 for an earlier document; setup refuses any other version')
    expect(refusal(write('future.json', { ...BASE, schemaVersion: 4 }))).toContain('schemaVersion must be 3')
  })

  it('refuses reach, a prompted key, a sections record, a bad profile name and a port out of range', () => {
    expect(refusal(write('reach.json', { ...BASE, reach: { option: 'tailscale-private', identityFactor: 'passkey' } }))).toContain('reach.option must be "none"')
    expect(refusal(write('factor.json', { ...BASE, reach: { option: 'none', identityFactor: 'passkey' } }))).toContain('reach.identityFactor must be null')
    expect(refusal(write('prompt.json', { ...BASE, modelProvider: { id: 'deepseek-official', credential: { source: 'prompt' } } }))).toContain('modelProvider.credential.source must be "environment"')
    expect(refusal(write('sections.json', { ...BASE, sections: [{ id: 'key', status: 'answered' }] }))).toContain('sections is written by setup')
    expect(refusal(write('name.json', { ...BASE, profile: { name: 'desktop', port: null } }))).toContain('profile.name is not a profile name setup accepts')
    expect(refusal(write('port.json', { ...BASE, profile: { name: null, port: 80 } }))).toContain('profile.port is not a value')
    expect(refusal(write('prompts.json', { ...BASE, prompts: 'lax' }))).toContain('prompts is not a value')
  })

  it('refuses a document that asks for the stock-home import, which shows its preview in a terminal first', () => {
    expect(refusal(write('import.json', { ...BASE, importStockHome: true }))).toContain('importStockHome must be false in --config')
  })

  it('refuses a document that turns changes protection on, which only a terminal changes, and reads an absent answer as no', () => {
    expect(refusal(write('protect.json', { ...BASE, protectChanges: true }))).toBe('delorun setup --config: protectChanges must be false in --config: changes protection is turned on only at a terminal, so run delorun changes protection on in one')
    expect(readAnswersDocument(write('kept.json', { ...BASE, protectChanges: false })).protectChanges).toBe(false)
    expect(readAnswersDocument(write('absent.json', BASE)).protectChanges).toBe(false)
    expect(refusal(write('word.json', { ...BASE, protectChanges: 'on' }))).toContain('protectChanges is not a value')
  })

  it('refuses a credential value given as a name, a file that is not JSON and a file that is missing', () => {
    const secret = 'sk-SECRET-VALUE-79'
    const named = refusal(write('named.json', { ...BASE, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: secret } } }))
    expect(named).toContain('credential')
    expect(named).not.toContain(secret)
    expect(refusal(write('text.json', 'not json'))).toContain('is not a JSON document')
    expect(refusal(join(directory, 'missing.json'))).toContain('cannot read')
    expect(refusal(write('array.json', '[]'))).toContain('is not a value the answers document accepts')
    expect(refusal(write('null.json', 'null'))).toContain('is not a value the answers document accepts')
  })

  it('--yes answers take every default and the key from the environment, and stop naming the variable when it is unset', () => {
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k' }).prompts).toBe('safer')
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k' }).reach).toEqual({ option: 'none', identityFactor: null })
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k' }).protectChanges).toBe(false)
    expect(() => yesAnswers({})).toThrow('DEEPSEEK_API_KEY is not set')
    expect(() => yesAnswers({ DEEPSEEK_API_KEY: '' })).toThrow('DEEPSEEK_API_KEY is not set')
  })
})
