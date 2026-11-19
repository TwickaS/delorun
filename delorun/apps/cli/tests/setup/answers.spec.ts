import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOVED_ANSWER_KEYS, SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { baseURLWarning, checkCatalogModel, chosenProvider, readAnswersDocument, yesAnswers, type ProviderChoice } from '../../src/setup/answers.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { installedCatalog } from '../../src/setup/providers.ts'

const DEEPSEEK = { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null }

const BASE = {
  schemaVersion: 4,
  modelProvider: DEEPSEEK,
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

  it('reads a version-2 document as version 4 with the check on, and refuses the release-check answer in one', () => {
    const version2 = { ...BASE, schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: DEEPSEEK.credential } }
    expect(readAnswersDocument(write('version-2.json', version2))).toMatchObject({ schemaVersion: 4, updateCheck: true, prompts: 'safer', modelProvider: DEEPSEEK })
    expect(refusal(write('version-2-off.json', { ...version2, updateCheck: false }))).toBe('delorun setup --config: updateCheck needs schemaVersion 4')
    expect(refusal(write('version-2-unknown.json', { ...version2, apiKey: 'sk-SECRET-VALUE-81' }))).toContain('the document holds a field the answers document does not define')
  })

  it('reads a version-3 document\'s provider as DeepSeek with the profile\'s default model, as setup of that version applied it', () => {
    const version3 = { ...BASE, schemaVersion: 3, updateCheck: false, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'OTHER_KEY' } } }
    expect(readAnswersDocument(write('version-3.json', version3))).toMatchObject({ schemaVersion: 4, updateCheck: false, modelProvider: { ...DEEPSEEK, credential: { source: 'environment', name: 'OTHER_KEY' } } })
    expect(refusal(write('version-3-model.json', { ...version3, modelProvider: { ...version3.modelProvider, model: 'x' } }))).toBe('delorun setup --config: modelProvider needs schemaVersion 4 to name a base URL or a model')
  })

  it('refuses a version-2 or version-3 document that names another provider, which only version 4 sets up', () => {
    for (const schemaVersion of [2, 3]) {
      const earlier = { ...BASE, schemaVersion, modelProvider: { id: 'anthropic', credential: { source: 'environment', name: 'ANTHROPIC_API_KEY' } } }
      expect(refusal(write(`version-${String(schemaVersion)}-other.json`, earlier))).toBe('delorun setup --config: modelProvider.id needs schemaVersion 4 to name a provider other than deepseek-official')
    }
  })

  it('refuses a base URL with a user name, password, query or fragment, and a model that is not an id, without echoing either', () => {
    const custom = { id: 'openai-compatible', credential: { source: 'environment', name: 'LOCAL_KEY' }, baseURL: 'http://127.0.0.1:8000/v1', model: 'local' }
    for (const baseURL of ['https://user:sk-SECRET-VALUE-91@gw.example/v1', 'https://@gw.example/v1', 'https://gw.example/v1?key=sk-SECRET-VALUE-91', 'https://gw.example/v1#sk-SECRET-VALUE-91', 'https://gw.example/v1?', 'https://gw.example/ v1']) {
      const message = refusal(write('url.json', { ...BASE, modelProvider: { ...custom, baseURL } }))
      expect(message).toBe('delorun setup --config: modelProvider.baseURL must be an http or https URL without a user name, password, query or fragment')
    }
    for (const model of ['sk SECRET-VALUE-92', '"sk-SECRET-VALUE-92"', '', 'a'.repeat(201)]) {
      const message = refusal(write('model.json', { ...BASE, modelProvider: { ...custom, model } }))
      expect(message).toBe('delorun setup --config: modelProvider.model must be a model id: letters, digits and . _ : / @ ~ + -')
    }
  })

  it('warns about a base URL that reaches another computer over plain http, and not about https or this computer', () => {
    expect(baseURLWarning('http://192.0.2.20:8000/v1')).toBe('http://192.0.2.20:8000 is reached over plain http, so the key and every prompt cross the network unencrypted; use https unless the network to it is your own.')
    expect(baseURLWarning('http://gw.example/v1')).toContain('plain http')
    for (const quiet of ['https://gw.example/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://127.4.5.6/v1', 'http://[::1]:8000/v1']) expect(baseURLWarning(quiet)).toBeUndefined()
  })

  it('reads every provider setup offers, with the fields each needs, and refuses one it does not offer', () => {
    const anthropic = { id: 'anthropic', credential: { source: 'environment', name: 'ANTHROPIC_API_KEY' }, baseURL: null, model: 'claude-sonnet-5' }
    expect(readAnswersDocument(write('anthropic.json', { ...BASE, modelProvider: anthropic })).modelProvider).toEqual(anthropic)
    const custom = { id: 'openai-compatible', credential: { source: 'environment', name: 'LOCAL_KEY' }, baseURL: 'http://127.0.0.1:8000/v1', model: 'local' }
    expect(readAnswersDocument(write('custom.json', { ...BASE, modelProvider: custom })).modelProvider).toEqual(custom)
    expect(readAnswersDocument(write('none.json', { ...BASE, modelProvider: null })).modelProvider).toBeNull()
    expect(refusal(write('unknown.json', { ...BASE, modelProvider: { ...anthropic, id: 'acme' } }))).toContain('modelProvider.id must be one of anthropic, deepseek-official, google')
    expect(refusal(write('no-model.json', { ...BASE, modelProvider: { ...anthropic, model: null } }))).toBe('delorun setup --config: modelProvider.model is needed for anthropic')
    expect(refusal(write('no-url.json', { ...BASE, modelProvider: { ...custom, baseURL: null } }))).toBe('delorun setup --config: modelProvider.baseURL is needed for openai-compatible')
    expect(refusal(write('stray-url.json', { ...BASE, modelProvider: { ...anthropic, baseURL: 'https://x.example' } }))).toBe('delorun setup --config: modelProvider.baseURL is set for openai-compatible only')
    expect(refusal(write('bad-url.json', { ...BASE, modelProvider: { ...custom, baseURL: 'ftp://x.example' } }))).toBe('delorun setup --config: modelProvider.baseURL must be an http or https URL without a user name, password, query or fragment')
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

  // Removing the ignored-keys filter, or its log line, refuses a document an earlier version wrote or loads it without saying the answer is gone.
  it('reads a document that still holds the removed phonePowers answer, ignores it and says so', () => {
    const lines: string[] = []
    const path = write('phone-powers.json', { ...BASE, phonePowers: 'full' })
    const answers = readAnswersDocument(path, (line) => { lines.push(line) })
    expect(answers).not.toHaveProperty('phonePowers')
    expect(lines).toEqual([`delorun setup --config: ${path} holds phonePowers, which Delorun no longer has; it is ignored`])
    const quiet: string[] = []
    readAnswersDocument(write('plain.json', BASE), (line) => { quiet.push(line) })
    expect(quiet).toEqual([])
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
    expect(refusal(write('version.json', { ...BASE, schemaVersion: 1 }))).toContain('schemaVersion must be 4, or 2 or 3 for an earlier document; setup refuses any other version')
    expect(refusal(write('future.json', { ...BASE, schemaVersion: 5 }))).toContain('schemaVersion must be 4')
  })

  it('refuses reach, a prompted key, a sections record, a bad profile name and a port out of range', () => {
    expect(refusal(write('reach.json', { ...BASE, reach: { option: 'tailscale-private', identityFactor: 'passkey' } }))).toContain('reach.option must be "none"')
    expect(refusal(write('factor.json', { ...BASE, reach: { option: 'none', identityFactor: 'passkey' } }))).toContain('reach.identityFactor must be null')
    expect(refusal(write('prompt.json', { ...BASE, modelProvider: { ...DEEPSEEK, credential: { source: 'prompt' } } }))).toContain('modelProvider.credential.source must be "environment"')
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
    const named = refusal(write('named.json', { ...BASE, modelProvider: { ...DEEPSEEK, credential: { source: 'environment', name: secret } } }))
    expect(named).toContain('credential')
    expect(named).not.toContain(secret)
    expect(refusal(write('text.json', 'not json'))).toContain('is not a JSON document')
    expect(refusal(join(directory, 'missing.json'))).toContain('cannot read')
    expect(refusal(write('array.json', '[]'))).toContain('is not a value the answers document accepts')
    expect(refusal(write('null.json', 'null'))).toContain('is not a value the answers document accepts')
  })

  it('--yes answers take every default and no provider unless --provider names one, whatever keys the environment holds', () => {
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toEqual({ ...SETUP_DEFAULTS, modelProvider: null })
    expect(yesAnswers({}).reach).toEqual({ option: 'none', identityFactor: null })
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k' }, { id: 'deepseek-official', model: undefined, baseURL: undefined, keyEnv: undefined }).protectChanges).toBe(false)
  })

  it('--yes --provider reads the provider\'s key from its variable or --key-env, and stops naming the variable when it is unset', () => {
    const choice: ProviderChoice = { id: 'anthropic', model: 'claude-sonnet-5', baseURL: undefined, keyEnv: undefined }
    expect(yesAnswers({ ANTHROPIC_API_KEY: 'k' }, choice).modelProvider).toEqual({ id: 'anthropic', credential: { source: 'environment', name: 'ANTHROPIC_API_KEY' }, baseURL: null, model: 'claude-sonnet-5' })
    expect(yesAnswers({ WORK_KEY: 'k' }, { ...choice, keyEnv: 'WORK_KEY' }).modelProvider?.credential).toEqual({ source: 'environment', name: 'WORK_KEY' })
    expect(() => yesAnswers({}, choice)).toThrow('delorun setup --yes: ANTHROPIC_API_KEY is not set; set it to the Anthropic key')
    expect(() => yesAnswers({ DEEPSEEK_API_KEY: '' }, { id: 'deepseek-official', model: undefined, baseURL: undefined, keyEnv: undefined })).toThrow('DEEPSEEK_API_KEY is not set')
    expect(yesAnswers({ DEEPSEEK_API_KEY: 'k' }, { id: 'deepseek-official', model: undefined, baseURL: undefined, keyEnv: undefined }).modelProvider).toEqual(DEEPSEEK)
  })

  it('refuses a --provider command line that names no provider setup offers, misses a field it needs or carries a key', () => {
    const usage = (choice: ProviderChoice): string => {
      try {
        chosenProvider(choice)
      } catch (error) {
        expect((error as CliError).exit).toBe(EXIT.usage)
        return (error as Error).message
      }
      return ''
    }
    const none = { model: undefined, baseURL: undefined, keyEnv: undefined }
    expect(usage({ ...none, id: 'sk-SECRET-VALUE-93' })).toBe('delorun setup --provider: --provider names no provider setup offers; choose one of anthropic, deepseek-official, google, groq, mistral, moonshotai, openai, openai-compatible, openrouter, together, xai')
    expect(usage({ ...none, id: 'openai', model: 'sk SECRET-VALUE-94' })).toBe('delorun setup --provider: --model must be a model id: letters, digits and . _ : / @ ~ + -')
    expect(usage({ ...none, id: 'openai-compatible', model: 'm', baseURL: 'https://u:sk-SECRET-VALUE-95@gw.example/v1' })).toBe('delorun setup --provider: --base-url must be an http or https URL without a user name, password, query or fragment')
    expect(usage({ ...none, id: 'openai' })).toBe('delorun setup --provider: openai needs --model, the model new chats start on')
    expect(usage({ ...none, id: 'openai-compatible', model: 'm' })).toBe('delorun setup --provider: openai-compatible needs --base-url, the endpoint\'s base URL')
    expect(usage({ ...none, id: 'openai', model: 'm', baseURL: 'https://x.example' })).toContain('--base-url applies to openai-compatible only')
    expect(usage({ ...none, id: 'openai-compatible', model: 'm', baseURL: 'not a url' })).toBe('delorun setup --provider: --base-url must be an http or https URL without a user name, password, query or fragment')
  })

  it('--key-env carrying a key is refused', () => {
    let error: unknown
    try {
      chosenProvider({ id: 'openai', model: 'm', baseURL: undefined, keyEnv: 'sk-SECRET-VALUE-90' })
    } catch (caught) {
      error = caught
    }
    expect((error as CliError).exit).toBe(EXIT.usage)
    expect((error as Error).message).toContain('--key-env must be the name of an environment variable')
    expect((error as Error).message).not.toContain('sk-SECRET-VALUE-90')
  })

  it('refuses a model the provider\'s installed catalogue does not list, and accepts any model of the custom endpoint', async () => {
    const catalog = await installedCatalog()
    const [first] = catalog.models('openai')
    expect(() => { checkCatalogModel({ id: 'openai', credential: { source: 'prompt' }, baseURL: null, model: first?.id ?? '' }, catalog, 'here', '--model') }).not.toThrow()
    expect(() => { checkCatalogModel({ id: 'openai', credential: { source: 'prompt' }, baseURL: null, model: 'no-such-model' }, catalog, 'here', '--model') }).toThrow('here: --model names a model that is not in openai\'s installed catalogue; delorun setup key lists the models it serves')
    expect(() => { checkCatalogModel({ id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: 'no-such-model' }, catalog, 'here', '--model') }).toThrow('not in deepseek-official\'s installed catalogue')
    expect(() => { checkCatalogModel({ id: 'openai-compatible', credential: { source: 'prompt' }, baseURL: 'http://x.example', model: 'anything' }, catalog, 'here', '--model') }).not.toThrow()
    expect(() => { checkCatalogModel(null, catalog, 'here', '--model') }).not.toThrow()
  })
})
