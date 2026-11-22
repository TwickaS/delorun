/**
 * The key test: each provider route's key is tried with the provider's free model listing, never a completion, and the
 * answer names the route and its result, never a key or a provider's message.
 */
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DEEPSEEK_ROUTE, discoveryResult, listingResult, testKeys, type KeyTestDeps } from '../src/key-test.ts'
import { keyTestDeps } from '../src/index.ts'
import { KeyTestAnswer, MAX_PROVIDERS } from '../src/wire.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

const coded = (code: string) => Object.assign(new Error('provider said something with sk-secret'), { code })

/** Parts where every route discovers, unless changed. */
function deps(change: Partial<KeyTestDeps> = {}): KeyTestDeps {
  return {
    providers: () => [{ id: 'openai', name: 'OpenAI' }, { id: DEEPSEEK_ROUTE, name: 'DeepSeek' }],
    configurable: () => [{ provider: 'openai', settingsNs: 'llm.openai' }],
    needsKey: () => true,
    credentialConfigured: vi.fn(async () => true),
    discover: vi.fn(async () => {}),
    deepseek: vi.fn(async () => 'works' as const),
    timeoutMs: 1000,
    hidden: [],
    ...change,
  }
}

describe('the key test', () => {
  it('asks a configurable route\'s discovery and the official DeepSeek route\'s own listing, all at once', async () => {
    const parts = deps()
    expect(await testKeys(parts)).toEqual({ hidden: [], providers: [
      { provider: 'openai', name: 'OpenAI', result: 'works' },
      { provider: DEEPSEEK_ROUTE, name: 'DeepSeek', result: 'works' },
    ] })
    expect(parts.discover).toHaveBeenCalledExactlyOnceWith('llm.openai', 'openai', expect.any(AbortSignal))
    expect(parts.deepseek).toHaveBeenCalledOnce()
  })

  it('tries the DeepSeek listing when its discovery declines, and leaves another route without one untested', async () => {
    const parts = deps({
      providers: () => [{ id: 'local', name: 'Local' }, { id: DEEPSEEK_ROUTE, name: 'DeepSeek' }],
      configurable: () => [{ provider: DEEPSEEK_ROUTE, settingsNs: 'llm.deepseek' }],
      discover: vi.fn(async () => { throw coded('NO_DISCOVERY') }),
      deepseek: vi.fn(async () => 'rejected' as const),
    })
    expect((await testKeys(parts)).providers.map(each => each.result)).toEqual(['untested', 'rejected'])
  })

  it('leaves a hidden route out of the answer and does not test it', async () => {
    const discover = vi.fn(async () => {})
    const parts = deps({
      providers: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'custom', name: 'Custom' }],
      configurable: () => [{ provider: 'custom', settingsNs: 'llm.custom' }, { provider: 'deepseek-account', settingsNs: 'llm.account' }],
      needsKey: () => false,
      discover,
      hidden: ['deepseek-account'],
    })
    expect((await testKeys(parts)).providers.map(each => each.provider)).toEqual(['custom'])
    expect(discover).toHaveBeenCalledExactlyOnceWith('llm.custom', 'custom', expect.any(AbortSignal))
    expect((await testKeys({ ...parts, hidden: [] })).providers.map(each => each.provider)).toEqual(['deepseek-account', 'custom'])
  })

  it('answers no-key for a route with no configured credential, without asking its discovery, and untested for a configured one with no listing', async () => {
    const discover = vi.fn(async () => { throw coded('INVALID_DISCOVERY') })
    const credentialConfigured = vi.fn(async (provider: string) => provider === 'custom')
    const parts = deps({
      providers: () => [{ id: 'custom', name: 'Custom' }, { id: 'unset', name: 'Unset' }],
      configurable: () => [{ provider: 'custom', settingsNs: 'llm.custom' }, { provider: 'unset', settingsNs: 'llm.unset' }],
      credentialConfigured,
      discover,
    })
    expect((await testKeys(parts)).providers.map(each => each.result)).toEqual(['untested', 'no-key'])
    expect(credentialConfigured.mock.calls).toEqual([['custom'], ['unset']])
    expect(discover).toHaveBeenCalledExactlyOnceWith('llm.custom', 'custom', expect.any(AbortSignal))
  })

  it('sends a keyless route straight to discovery, without a credential check', async () => {
    const credentialConfigured = vi.fn(async () => false)
    const discover = vi.fn(async () => { throw coded('NO_DISCOVERY') })
    const parts = deps({
      providers: () => [{ id: 'local', name: 'Local server' }, { id: 'needy', name: 'Needy' }],
      configurable: () => [{ provider: 'local', settingsNs: 'llm.local' }],
      needsKey: provider => provider !== 'local',
      credentialConfigured,
      discover,
    })
    expect((await testKeys(parts)).providers.map(each => each.result)).toEqual(['untested', 'no-key'])
    expect(credentialConfigured.mock.calls).toEqual([['needy']])
  })

  it('answers failed for a route whose credential cannot be read, and asks its discovery nothing', async () => {
    const discover = vi.fn(async () => {})
    const parts = deps({
      providers: () => [{ id: 'custom', name: 'Custom' }],
      credentialConfigured: async () => { throw new Error('malformed reference') },
      discover,
    })
    expect((await testKeys(parts)).providers.map(each => each.result)).toEqual(['failed'])
    expect(discover).not.toHaveBeenCalled()
  })

  it('decides the official DeepSeek route by its own listing, not by the credential check', async () => {
    const credentialConfigured = vi.fn(async () => true)
    const parts = deps({
      providers: () => [{ id: DEEPSEEK_ROUTE, name: 'DeepSeek' }],
      configurable: () => [],
      credentialConfigured,
      deepseek: vi.fn(async () => 'no-key' as const),
    })
    expect((await testKeys(parts)).providers.map(each => each.result)).toEqual(['no-key'])
    expect(credentialConfigured).not.toHaveBeenCalled()
  })

  it('answers failed for a route whose test throws, and tests at most the limit', async () => {
    const many = Array.from({ length: MAX_PROVIDERS + 3 }, (_, index) => ({ id: `p${String(index)}`, name: `P${String(index)}` }))
    const parts = deps({ providers: () => many, configurable: () => many.map(each => ({ provider: each.id, settingsNs: 'ns' })), discover: vi.fn(async () => { throw coded('DISCOVERY_FAILED') }) })
    const answer = await testKeys(parts)
    expect(answer.providers).toHaveLength(MAX_PROVIDERS)
    expect(new Set(answer.providers.map(each => each.result))).toEqual(new Set(['failed']))
    expect(JSON.stringify(answer)).not.toContain('sk-secret')
    const throwing = deps({ providers: () => [{ id: DEEPSEEK_ROUTE, name: 'DeepSeek' }], configurable: () => [], deepseek: async () => { throw new Error('boom') } })
    expect((await testKeys(throwing)).providers[0]?.result).toBe('failed')
  })

  it.each<readonly [string, string]>([
    ['MISSING_CREDENTIAL', 'no-key'], ['NO_DISCOVERY', 'untested'], ['DISCOVERY_UNSUPPORTED', 'untested'], ['INVALID_DISCOVERY', 'untested'],
    ['ABORTED', 'unreachable'], ['TIMEOUT', 'unreachable'], ['DISCOVERY_FAILED', 'failed'], ['', 'failed'],
  ])('reads a discovery failure coded %s as %s', (code, result) => {
    expect(discoveryResult(code === '' ? new Error('plain') : coded(code))).toBe(result)
    expect(discoveryResult('not an error')).toBe('failed')
  })

  it.each<readonly [string, string]>([
    ['INVALID_RESPONSE', 'untested'], ['HTTP_401', 'rejected'], ['HTTP_403', 'rejected'], ['TRANSPORT', 'unreachable'], ['TIMEOUT', 'unreachable'],
    ['ABORTED', 'unreachable'], ['MISSING_CREDENTIAL', 'no-key'], ['HTTP_500', 'failed'],
  ])('reads a DeepSeek listing failure coded %s as %s', (code, result) => {
    expect(listingResult(coded(code))).toBe(result)
  })
})

describe('the key test in the harness', () => {
  /** A local DeepSeek listing that answers the status given, recording the key it was sent. */
  async function listing(status: number): Promise<{ readonly url: string; readonly keys: string[] }> {
    const keys: string[] = []
    const server: Server = createServer((request, response) => {
      keys.push(String(request.headers['x-api-key'] ?? request.headers.authorization ?? ''))
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] }))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { url: `http://127.0.0.1:${String(address.port)}`, keys }
  }

  it('lists no route and discovers nothing without the model runtime', async () => {
    const parts = keyTestDeps(new Context(), 1000, [])
    expect([parts.providers(), parts.configurable()]).toEqual([[], []])
    await expect(parts.discover('ns', 'openai', AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })

  it('asks the model runtime\'s discovery for a route', async () => {
    const ctx = new Context()
    const discoverModels = vi.fn(async () => [])
    ctx.provide('llm', { listProviders: () => [{ id: 'openai', name: 'OpenAI' }], listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'ns' }], discoverModels } as never)
    const parts = keyTestDeps(ctx, 1000, [])
    expect(parts.providers()).toEqual([{ id: 'openai', name: 'OpenAI' }])
    expect(parts.configurable()).toEqual([{ provider: 'openai', settingsNs: 'ns' }])
    const signal = AbortSignal.timeout(1000)
    await parts.discover('ns', 'openai', signal)
    expect(discoverModels).toHaveBeenCalledExactlyOnceWith('ns', { provider: 'openai' }, signal)
  })

  it('sends the stored key to the DeepSeek listing at the configured address, and reads its answer', async () => {
    const ctx = new Context()
    const resolve = vi.fn(async () => ({ value: 'sk-stored' }))
    ctx.provide('credentials', { resolve } as never)
    const ok = await listing(200)
    vi.stubEnv('DEEPSEEK_BASE_URL', ok.url)
    expect(await keyTestDeps(ctx, 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('works')
    expect(ok.keys).toEqual(['sk-stored'])
    expect(resolve).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY')
    const refused = await listing(401)
    vi.stubEnv('DEEPSEEK_BASE_URL', refused.url)
    expect(await keyTestDeps(ctx, 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('rejected')
  })

  it('reads the variable the DeepSeek route\'s profile names, not only DEEPSEEK_API_KEY', async () => {
    const ctx = new Context()
    const resolve = vi.fn(async (ref: string) => (ref === 'MY_ROUTE_KEY' ? { value: 'sk-mine' } : undefined))
    ctx.provide('credentials', { resolve } as never)
    ctx.provide('llm', { listConfigurableProviders: () => [{ provider: DEEPSEEK_ROUTE, settingsNs: 'llm.deepseek', settingsPath: [] }] } as never)
    ctx.provide('settings', { describe: () => [{ ns: 'llm.deepseek', value: { apiKeyEnv: 'MY_ROUTE_KEY' } }] } as never)
    const ok = await listing(200)
    vi.stubEnv('DEEPSEEK_BASE_URL', ok.url)
    expect(await keyTestDeps(ctx, 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('works')
    expect(ok.keys).toEqual(['sk-mine'])
    expect(resolve).toHaveBeenCalledExactlyOnceWith('MY_ROUTE_KEY')
  })

  it('reads the key from the environment without a credentials service, and answers no-key without one', async () => {
    const ok = await listing(200)
    vi.stubEnv('DEEPSEEK_BASE_URL', ok.url)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env')
    expect(await keyTestDeps(new Context(), 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('works')
    expect(ok.keys).toEqual(['sk-env'])
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect(await keyTestDeps(new Context(), 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('no-key')
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    expect(await keyTestDeps(ctx, 5000, []).deepseek(AbortSignal.timeout(5000))).toBe('no-key')
  })

  it('uses DeepSeek\'s public address when none is configured, and gives up at the deadline', async () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }) })
      throw new Error('unreachable')
    })
    const controller = new AbortController()
    const result = keyTestDeps(new Context(), 5000, []).deepseek(controller.signal)
    controller.abort()
    expect(await result).toBe('unreachable')
    expect(String(fetch.mock.calls[0]?.[0])).toContain('api.deepseek.com')
  })

  describe('the needs-key check', () => {
    /** A context whose configurable route `custom` has the given directory facts and settings profile. */
    function needsContext(extra: object, profile: unknown) {
      const ctx = new Context()
      ctx.provide('llm', { listConfigurableProviders: () => [{ provider: 'custom', displayName: 'Custom', settingsNs: 'llm.custom', settingsPath: ['providers', 'custom'], ...extra }] } as never)
      ctx.provide('settings', { describe: () => [{ ns: 'llm.custom', value: profile }] } as never)
      return ctx
    }

    it('needs a key when the profile names a reference or the adapter reports environment variables', () => {
      expect(keyTestDeps(needsContext({}, { providers: { custom: { apiKeyEnv: 'CUSTOM_API_KEY' } } }), 1000, []).needsKey('custom')).toBe(true)
      expect(keyTestDeps(needsContext({ nativeAuth: { env: ['CUSTOM_API_KEY'], oauth: false } }, {}), 1000, []).needsKey('custom')).toBe(true)
      expect(keyTestDeps(new Context(), 1000, []).needsKey('custom')).toBe(true)
    })

    it('is keyless when the profile names no reference and the adapter reports no environment variable', () => {
      expect(keyTestDeps(needsContext({}, { providers: { custom: { baseURL: 'http://localhost:11434/v1' } } }), 1000, []).needsKey('custom')).toBe(false)
      expect(keyTestDeps(needsContext({ nativeAuth: { env: [], oauth: true } }, {}), 1000, []).needsKey('custom')).toBe(false)
    })
  })

  describe('the configured-credential check', () => {
    /** A context whose configurable route `custom` keeps its credential reference in its settings profile. */
    function routeContext(profile: unknown, describe = vi.fn(async () => ({ configured: true, writable: true }))) {
      const ctx = new Context()
      ctx.provide('llm', { listConfigurableProviders: () => [{ provider: 'custom', displayName: 'Custom', settingsNs: 'llm.custom', settingsPath: ['providers', 'custom'] }] } as never)
      ctx.provide('settings', { describe: () => [{ ns: 'llm.custom', value: profile }] } as never)
      const resolve = vi.fn(async () => ({ value: 'sk-stored' }))
      ctx.provide('credentials', { describe, resolve } as never)
      return { ctx, describe, resolve }
    }

    it('asks the credentials service whether the route\'s reference is configured, and never reads its value', async () => {
      const { ctx, describe, resolve } = routeContext({ providers: { custom: { apiKeyEnv: 'CUSTOM_API_KEY' } } })
      expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(true)
      expect(describe).toHaveBeenCalledExactlyOnceWith('CUSTOM_API_KEY')
      expect(resolve).not.toHaveBeenCalled()
    })

    it('answers the credentials service\'s configured flag', async () => {
      const { ctx } = routeContext({ providers: { custom: { apiKeyEnv: 'CUSTOM_API_KEY' } } }, vi.fn(async () => ({ configured: false, writable: true })))
      expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(false)
    })

    it('reports no credential for a route the directory does not list, or whose profile names no reference', async () => {
      expect(await keyTestDeps(new Context(), 1000, []).credentialConfigured('custom')).toBe(false)
      for (const profile of [undefined, {}, { providers: {} }, { providers: { custom: 'text' } }, { providers: { custom: {} } }, { providers: { custom: { apiKeyEnv: '' } } }]) {
        const { ctx, describe } = routeContext(profile)
        expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(false)
        expect(describe).not.toHaveBeenCalled()
      }
    })

    it('reads the launch environment as the store without a credentials service', async () => {
      const ctx = new Context()
      ctx.provide('llm', { listConfigurableProviders: () => [{ provider: 'custom', displayName: 'Custom', settingsNs: 'llm.custom', settingsPath: ['providers', 'custom'] }] } as never)
      ctx.provide('settings', { describe: () => [{ ns: 'llm.custom', value: { providers: { custom: { apiKeyEnv: 'CUSTOM_API_KEY' } } } }] } as never)
      expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(false)
      vi.stubEnv('CUSTOM_API_KEY', '')
      expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(false)
      vi.stubEnv('CUSTOM_API_KEY', 'sk-env')
      expect(await keyTestDeps(ctx, 1000, []).credentialConfigured('custom')).toBe(true)
    })

    it('refuses a route whose settings service is not mounted, rather than reporting no credential', async () => {
      const unmounted = new Context()
      unmounted.provide('llm', { listConfigurableProviders: () => [{ provider: 'custom', displayName: 'Custom', settingsNs: 'llm.custom', settingsPath: [] }] } as never)
      await expect(keyTestDeps(unmounted, 1000, []).credentialConfigured('custom')).rejects.toThrow('the settings service is not mounted')
    })
  })
})

describe('where a found key came from', () => {
  const FAKE_KEY = 'sk-FAKEFAKEFAKE0123456789'
  const withRoute = (describe: (ref: string) => Promise<unknown>, ref = 'OPENAI_API_KEY') => {
    const ctx = new Context()
    ctx.provide('credentials', { describe } as never)
    ctx.provide('llm', { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'llm.openai', settingsPath: [] }, { provider: DEEPSEEK_ROUTE, settingsNs: 'llm.deepseek', settingsPath: [] }] } as never)
    ctx.provide('settings', { describe: () => [{ ns: 'llm.openai', value: { apiKeyEnv: ref } }] } as never)
    return keyTestDeps(ctx, 1000, [])
  }

  it('names each credentials layer and the variable, and never the key', async () => {
    for (const [layer, kind] of [['env', 'environment'], ['file', 'saved'], ['project-env', 'project-file'], ['user-env', 'home-file'], ['other', 'unknown']] as const) {
      const parts = withRoute(async () => ({ configured: true, source: layer, writable: true, masked: FAKE_KEY }))
      const source = await parts.credentialSource?.('openai')
      expect(source).toEqual({ kind, variable: 'OPENAI_API_KEY' })
      expect(JSON.stringify(source)).not.toContain(FAKE_KEY)
    }
  })

  it('names the default DeepSeek variable, and nothing for an unconfigured or unknown route', async () => {
    const parts = withRoute(async (ref) => ({ configured: ref === 'DEEPSEEK_API_KEY', source: 'env', writable: true }))
    expect(await parts.credentialSource?.(DEEPSEEK_ROUTE)).toEqual({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    expect(await parts.credentialSource?.('openai')).toBeUndefined()
    expect(await parts.credentialSource?.('nowhere')).toBeUndefined()
  })

  it('leaves a reference that is not a plain variable name out of the answer', async () => {
    const parts = withRoute(async () => ({ configured: true, source: 'env', writable: true }), `sk-${'x'.repeat(10)}=1 2`)
    expect(await parts.credentialSource?.('openai')).toEqual({ kind: 'environment' })
  })

  it('puts the source in the answer only for a route that holds a key', async () => {
    const answer = await testKeys(deps({
      credentialConfigured: vi.fn(async (provider: string) => provider === 'openai'),
      providers: () => [{ id: 'openai', name: 'OpenAI' }, { id: 'groq', name: 'Groq' }],
      credentialSource: vi.fn(async () => ({ kind: 'saved' as const, variable: 'X_API_KEY' })),
    }))
    expect(answer.providers.find(each => each.provider === 'openai')?.source).toEqual({ kind: 'saved', variable: 'X_API_KEY' })
    expect(answer.providers.find(each => each.provider === 'groq')).not.toHaveProperty('source')
  })
})

describe('a key found on the host computer', () => {
  it('reaches a paired device as a result and the name of its variable, never as key text', async () => {
    const secret = 'sk-HOSTONLY0123456789'
    vi.stubEnv('DEEPSEEK_API_KEY', secret)
    const answer = await testKeys(deps({
      providers: () => [{ id: 'openai', name: 'OpenAI' }],
      credentialConfigured: vi.fn(async () => true),
      credentialSource: vi.fn(async () => ({ kind: 'environment' as const, variable: 'DEEPSEEK_API_KEY' })),
    }))
    expect(answer.providers[0]?.source).toEqual({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    expect(JSON.stringify(answer)).not.toContain(secret)
    expect(KeyTestAnswer.safeParse(answer).success).toBe(true)
  })
})

describe('the key test answer on the wire', () => {
  const row = (source: unknown) => ({ providers: [{ provider: 'openai', name: 'OpenAI', result: 'works', source }] })

  it('accepts a source kind with a variable name', () => {
    expect(KeyTestAnswer.safeParse(row({ kind: 'environment', variable: 'OPENAI_API_KEY' })).success).toBe(true)
  })

  it('rejects an unknown source kind, a variable that is not a name, and an extra field', () => {
    expect(KeyTestAnswer.safeParse(row({ kind: 'keychain' })).success).toBe(false)
    expect(KeyTestAnswer.safeParse(row({ kind: 'environment', variable: 'sk-abc def' })).success).toBe(false)
    expect(KeyTestAnswer.safeParse(row({ kind: 'saved', value: 'sk-abc' })).success).toBe(false)
  })
})
