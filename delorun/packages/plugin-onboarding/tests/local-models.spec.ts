import { describe, expect, it, vi } from 'vitest'
import { findLocalServers, LOCAL_CANDIDATES } from '../src/local-models.ts'
import { isLoopbackBaseURL } from '../src/wire.ts'

const listing = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { headers: { 'content-type': 'application/json' } })

describe('finding local servers', () => {
  it('asks only the two loopback model listings and reports the models of each that answered', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      asked.push(String(url))
      return Promise.resolve(String(url).includes(':11434') ? listing('llama3', 'qwen3') : new Response('no', { status: 404 }))
    }) as unknown as typeof fetch
    expect(await findLocalServers(1000, fetchImpl)).toEqual({ servers: [{ kind: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', models: ['llama3', 'qwen3'] }] })
    expect(asked).toEqual(['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:1234/v1/models'])
  })

  it('offers nothing for a refused connection, a listing without models or one that is not JSON', async () => {
    const answers = [Promise.reject(new Error('refused')), Promise.resolve(new Response('<html>', { status: 200 }))]
    const fetchImpl = vi.fn(() => answers.shift() as Promise<Response>) as unknown as typeof fetch
    expect(await findLocalServers(1000, fetchImpl)).toEqual({ servers: [] })
    expect(await findLocalServers(1000, vi.fn(() => Promise.resolve(listing())) as unknown as typeof fetch)).toEqual({ servers: [] })
  })

  it('only ever probes loopback addresses', () => {
    expect(LOCAL_CANDIDATES.every(each => isLoopbackBaseURL(each.baseURL))).toBe(true)
  })
})

describe('the loopback rule', () => {
  it.each([
    ['http://127.0.0.1:11434/v1', true], ['http://localhost:1234/v1', true], ['http://[::1]:8080', true],
    ['https://127.0.0.1/v1', false], ['http://192.0.2.5:11434/v1', false], ['http://example.com/v1', false],
    ['http://127.0.0.1.evil.test/v1', false], ['http://user:pw@127.0.0.1/v1', false], ['not a url', false],
  ])('%s -> %s', (url, expected) => { expect(isLoopbackBaseURL(url)).toBe(expected) })
})
