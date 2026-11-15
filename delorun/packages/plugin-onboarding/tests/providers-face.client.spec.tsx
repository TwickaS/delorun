import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createProvidersFace } from '../src/client/providers-face.ts'
import { DIRECTORY } from './directory.fixture.ts'

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = Promise.resolve({ ok: false as const, error: { message: 'no' } })

/** A context whose remote namespaces answer what the specs give. */
function remote(change: { readonly settings?: unknown; readonly mutate?: unknown; readonly discover?: unknown; readonly directory?: unknown } = {}) {
  const set = vi.fn(() => ok(undefined))
  const mutate = vi.fn(() => ('mutate' in change ? change.mutate : ok({})))
  const discoverModels = vi.fn(() => ('discover' in change ? change.discover : ok([{ id: 'm1', name: 'Model one' }, { id: 'm2' }])))
  const view = { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { openai: { baseURL: 'https://x' } } }, base: {}, revision: 7 }] }
  const ctx = {
    remote: {
      llm: { listConfigurableProviders: vi.fn(() => ('directory' in change ? change.directory : ok([
        { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], defaultBaseURL: 'https://api.openai.com/v1', nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false }, baseURLEnv: ['X'] },
        { provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'], declared: true },
      ]))), discoverModels },
      settings: { describe: vi.fn(() => ('settings' in change ? change.settings : ok(view))), mutate },
      credentials: { set },
    },
  } as never as Context
  return { face: createProvidersFace(ctx), set, mutate, discoverModels }
}

describe('the providers service', () => {
  it('reads the directory, and reads nothing when the harness refuses or throws', async () => {
    const entries = await remote().face.directory()
    expect(entries?.map(each => [each.provider, each.authEnv, each.baseURLEnv, each.declared])).toEqual([['openai', ['OPENAI_API_KEY'], ['X'], undefined], ['gateway', [], [], true]])
    expect(await remote({ directory: refused }).face.directory()).toBeUndefined()
    expect(await remote({ directory: Promise.reject(new Error('down')) }).face.directory()).toBeUndefined()
  })

  it('asks the free model list with the typed key and the route\'s endpoint, and counts the models', async () => {
    const { face, discoverModels } = remote()
    expect(await face.probe(DIRECTORY[1]!, 'sk-abc', undefined)).toEqual({ kind: 'works', models: 2, defaultModel: 'Model one' })
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openai', apiKey: 'sk-abc', baseURL: 'https://api.openai.com/v1' })
    expect(await face.probe(DIRECTORY[1]!, 'sk-abc', 'http://h')).toMatchObject({ kind: 'works' })
    expect(discoverModels).toHaveBeenLastCalledWith('llm-pi-ai', { provider: 'openai', apiKey: 'sk-abc', baseURL: 'http://h' })
    expect(await remote({ discover: ok([]) }).face.probe(DIRECTORY[0]!, 'k', undefined)).toEqual({ kind: 'works', models: 0, defaultModel: undefined })
    expect(await remote({ discover: refused }).face.probe(DIRECTORY[1]!, 'k', undefined)).toEqual({ kind: 'failed' })
    expect(await remote({ discover: Promise.reject(new Error('down')) }).face.probe(DIRECTORY[1]!, 'k', undefined)).toEqual({ kind: 'failed' })
  })

  it('names the conventional reference in the profile and then stores the key under it', async () => {
    const { face, set, mutate } = remote()
    const entry = { ...DIRECTORY[1]!, settingsPath: ['providers', 'openai'] }
    expect(await face.save(entry, 'sk-abc', undefined)).toBe(true)
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'OPENAI_API_KEY' }], 7)
    expect(set).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-abc')
  })

  it('creates a profile that holds the typed base URL, and writes no profile for a route whose profile already names its reference', async () => {
    const created = remote()
    expect(await created.face.save({ ...DIRECTORY[3]! }, 'k', 'http://h')).toBe(true)
    expect(created.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway'], value: { apiKeyEnv: 'GATEWAY_API_KEY', baseURL: 'http://h' } }], 7)
    const deepseek = remote({ settings: ok({ namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1 }] }) })
    expect(await deepseek.face.save(DIRECTORY[0]!, 'k', undefined)).toBe(true)
    expect(deepseek.mutate).not.toHaveBeenCalled()
    expect(deepseek.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'k')
  })

  it('reports a key that was not saved, and stores nothing when the profile write is refused', async () => {
    const refusedWrite = remote({ mutate: refused })
    expect(await refusedWrite.face.save(DIRECTORY[1]!, 'k', undefined)).toBe(false)
    expect(refusedWrite.set).not.toHaveBeenCalled()
    expect(await remote({ settings: refused }).face.save(DIRECTORY[1]!, 'k', undefined)).toBe(false)
    expect(await remote({ settings: Promise.reject(new Error('down')) }).face.save(DIRECTORY[1]!, 'k', undefined)).toBe(false)
  })
})
