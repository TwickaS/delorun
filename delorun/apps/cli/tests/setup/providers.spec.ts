/**
 * The providers setup offers and the profile rows each writes: DeepSeek's rows stay as the base bundle inserts them
 * unless the answer names another variable or model, every other provider is a route of the pi-ai adapter that its
 * own Config accepts, and every provider's key variable and endpoint is the one its adapter reads.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { SETUP_PROVIDER_IDS, type ModelProviderAnswer } from '@delorun/contract-setup-answers'
import { baseProviderRows, credentialReference, installedCatalog, PROVIDERS_BY_LABEL, SETUP_PROVIDERS, writeProviderRows } from '../../src/setup/providers.ts'

/** The authentication variables and endpoints the pi-ai adapter generates from its installed catalog, by provider. */
const PROVIDER_DATA_MODULE = '@deepseek-ai/dsh-llm-pi-ai/src/provider-data.generated.ts'

let directory: string
let patch: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-providers-'))
  patch = join(directory, 'cordis.patch.yml')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** @returns the patch's rows, or none when setup wrote no file. */
function rows(): { id: string, name?: string, config?: Record<string, unknown> }[] {
  return existsSync(patch) ? parse(readFileSync(patch, 'utf8')) as ReturnType<typeof rows> : []
}

/**
 * @param id - a row id.
 * @returns the row's config in the patch.
 */
function configOf(id: string): Record<string, unknown> | undefined {
  return rows().find(row => row.id === id)?.config
}

const ANTHROPIC: ModelProviderAnswer = { id: 'anthropic', credential: { source: 'prompt' }, baseURL: null, model: 'claude-sonnet-5' }

describe('the providers setup offers', () => {
  it('lists every provider once, by label, with a table entry for each id', () => {
    expect(PROVIDERS_BY_LABEL.map(provider => provider.label)).toEqual(['Anthropic', 'DeepSeek', 'Google Gemini', 'Groq', 'Mistral', 'Moonshot AI', 'OpenAI', 'OpenAI-compatible endpoint', 'OpenRouter', 'Together AI', 'xAI'])
    for (const id of SETUP_PROVIDER_IDS) expect(SETUP_PROVIDERS[id].id).toBe(id)
  })

  it('reads each catalog provider\'s key from a variable the pi-ai adapter reads, and finds a fixed endpoint and models in its installed catalog', async () => {
    const catalog = await installedCatalog()
    // A source module of the adapter, imported by name so the compiler does not resolve it as an emitted path.
    const { PROVIDER_DATA } = await import(PROVIDER_DATA_MODULE) as { PROVIDER_DATA: Readonly<Record<string, { env: readonly string[], defaultBaseURL?: string }>> }
    for (const provider of PROVIDERS_BY_LABEL.filter(each => each.adapter === 'catalog')) {
      expect(PROVIDER_DATA[provider.id]?.env).toContain(provider.keyVariable)
      expect(catalog.baseURL(provider.id)).toBe(PROVIDER_DATA[provider.id]?.defaultBaseURL)
      expect(catalog.models(provider.id).length).toBeGreaterThan(0)
    }
  })

  it('starts each provider\'s model question on a model its installed catalog lists, and DeepSeek\'s on the profile\'s default', async () => {
    const catalog = await installedCatalog()
    for (const provider of PROVIDERS_BY_LABEL.filter(each => each.adapter !== 'custom')) {
      expect(catalog.models(provider.id).map(model => model.id)).toContain(provider.defaultModel)
    }
    expect(SETUP_PROVIDERS['deepseek-official'].defaultModel).toBe(baseProviderRows().defaultModel.config['model'])
    expect(SETUP_PROVIDERS['openai-compatible'].defaultModel).toBeUndefined()
  })

  it('reads the same pi-ai package the adapter serves the catalog from, so setup and the adapter list the same providers and models', () => {
    const dependency = (manifest: string): unknown => (JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies: Record<string, string> }).dependencies['@earendil-works/pi-ai']
    const adapter = join(import.meta.dirname, '../../../../../packages/llm/llm-pi-ai/package.json')
    expect(dependency(join(import.meta.dirname, '../../package.json'))).toBe(dependency(adapter))
  })

  it('lists DeepSeek\'s built-in models, starting with the base bundle\'s default, and none for the custom endpoint', async () => {
    const catalog = await installedCatalog()
    expect(catalog.models('deepseek-official')[0]?.id).toBe(baseProviderRows().defaultModel.config['model'])
    expect(catalog.models('openai-compatible')).toEqual([])
    expect(() => catalog.baseURL('openai-compatible')).toThrow('has no fixed endpoint for openai-compatible')
  })

  it('names the reference a typed key is stored under, or the variable the answer reads', () => {
    expect(credentialReference(ANTHROPIC)).toBe('ANTHROPIC_API_KEY')
    expect(credentialReference({ ...ANTHROPIC, credential: { source: 'environment', name: 'MY_KEY' } })).toBe('MY_KEY')
  })
})

describe('the provider rows', () => {
  it('are the rows upstream\'s base bundle inserts, with DeepSeek as the default model', () => {
    expect(baseProviderRows()).toEqual({
      defaultModel: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      deepseek: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: {} },
      piAi: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} },
    })
  })

  it('stops when the bundle inserts one of them no longer', () => {
    writeFileSync(patch, '- insert:\n    - id: llm-deepseek\n      name: x\n')
    expect(() => baseProviderRows(patch)).toThrow(`${patch} inserts no agent-default-model row, so the model provider answer cannot be written`)
  })

  it('leaves the profile as stock DeepSeek Harness composes it for DeepSeek with its own variable and default model', () => {
    writeProviderRows(patch, { id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: null })
    writeProviderRows(patch, { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: 'deepseek-flash' })
    expect(rows()).toEqual([])
  })

  it('points DeepSeek\'s adapter at another variable, and selects another DeepSeek model', () => {
    writeProviderRows(patch, { id: 'deepseek-official', credential: { source: 'environment', name: 'WORK_DEEPSEEK_KEY' }, baseURL: null, model: 'deepseek-v4-pro' })
    expect(rows()).toEqual([
      { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { apiKeyEnv: 'WORK_DEEPSEEK_KEY' } },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    ])
    writeProviderRows(patch, { id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: null })
    expect(rows()).toEqual([])
  })

  it('sets a catalog provider\'s route and the default model, keeping the routes already there and dropping the earlier model\'s effort', () => {
    writeFileSync(patch, [
      '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      groq:', '        apiKeyEnv: GROQ_API_KEY',
      '      anthropic:', '        modelOverrides: {}',
      '- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', '    provider: groq', '    model: llama-3.3-70b-versatile', '    reasoningEffort: high', '',
    ].join('\n'))
    writeProviderRows(patch, ANTHROPIC)
    expect(configOf('llm-pi-ai')).toEqual({ providers: { groq: { apiKeyEnv: 'GROQ_API_KEY' }, anthropic: { modelOverrides: {}, apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
    expect(configOf('agent-default-model')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(configOf('llm-deepseek')).toBeUndefined()
  })

  it('returns new chats to DeepSeek\'s default model and keeps the pi-ai routes when DeepSeek is chosen again', () => {
    writeProviderRows(patch, ANTHROPIC)
    writeProviderRows(patch, { id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: null })
    expect(rows().map(row => row.id)).toEqual(['llm-pi-ai'])
  })

  it('declares an OpenAI-compatible route with its endpoint and model, adding a later model beside the first', () => {
    const answer: ModelProviderAnswer = { id: 'openai-compatible', credential: { source: 'environment', name: 'LOCAL_LLM_KEY' }, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }
    writeProviderRows(patch, answer)
    writeProviderRows(patch, { ...answer, model: 'llama3.3' })
    writeProviderRows(patch, { ...answer, model: 'llama3.3' })
    expect(configOf('llm-pi-ai')).toEqual({
      providers: { 'openai-compatible': { displayName: 'OpenAI-compatible endpoint', apiKeyEnv: 'LOCAL_LLM_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:8b' }, { id: 'llama3.3' }] } },
    })
    expect(configOf('agent-default-model')).toEqual({ provider: 'openai-compatible', model: 'llama3.3' })
  })

  it('writes routes the pi-ai adapter\'s own Config accepts', () => {
    for (const provider of PROVIDERS_BY_LABEL.filter(each => each.adapter !== 'deepseek')) {
      writeProviderRows(patch, { id: provider.id, credential: { source: 'prompt' }, baseURL: provider.adapter === 'custom' ? 'https://gateway.example/v1' : null, model: 'model-1' })
    }
    const written = readFileSync(patch, 'utf8')
    expect(Object.keys(configOf('llm-pi-ai')?.['providers'] ?? {}).sort()).toEqual(SETUP_PROVIDER_IDS.filter(id => id !== 'deepseek-official'))
    // The adapter's schema validates the row's config as the profile loader hands it over: parsed YAML.
    expect(() => PiAiConfig(parse(written).find((row: { id: string }) => row.id === 'llm-pi-ai').config)).not.toThrow()
  })
})
