/**
 * The pack transport fetches only signed names and URLs, never follows a redirect, and stops reading at the signed
 * length. Each case runs against a real HTTP server on the loopback address.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PackExternal, SemanticVersion, Sha512Base64 } from '@delorun/contract-release-manifest'
import { createPackFiles } from '../src/packs-fetch.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done) }))) })

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/release/`
}

const pin = (url: string, length: number): PackExternal => ({ name: 'native', version: brandString<SemanticVersion>('1.0.0'), url, sha512: brandString<Sha512Base64>('x'.repeat(86) + '=='), length })

describe('the pack transport', () => {
  it('fetches a signed name from the channel within its exact size', async () => {
    const channel = await serve((request, response) => { response.end(request.url === '/release/a.tar.gz' ? 'hello' : 'wrong') })
    expect(Buffer.from((await createPackFiles({ channel }).fetchRelease('a.tar.gz', { exact: 5 }))!).toString()).toBe('hello')
  })

  it('returns undefined for a file the channel lacks', async () => {
    const channel = await serve((_request, response) => { response.statusCode = 404; response.end() })
    expect(await createPackFiles({ channel }).fetchRelease('a.tar.gz', { max: 5 })).toBeUndefined()
  })

  it('refuses a redirect and never reads where it points', async () => {
    let followed = false
    const target = await serve((_request, response) => { followed = true; response.end('x') })
    const channel = await serve((_request, response) => { response.statusCode = 302; response.setHeader('location', target); response.end() })
    await expect(createPackFiles({ channel }).fetchRelease('a.tar.gz', { max: 5 })).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
    expect(followed).toBe(false)
  })

  it('aborts a body that passes the signed length while reading, without buffering the rest', async () => {
    let sent = 0
    let closed = false
    const channel = await serve((request, response) => {
      request.socket.on('close', () => { closed = true })
      const timer = setInterval(() => { sent += 1024; response.write(Buffer.alloc(1024)) }, 1)
      response.on('close', () => { clearInterval(timer) })
    })
    await expect(createPackFiles({ channel }).fetchRelease('a.tar.gz', { exact: 2048 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(sent).toBeLessThan(64 * 1024)
  })

  it('refuses a declared length above the limit before reading, and a short body of an exact size', async () => {
    const big = await serve((_request, response) => { response.setHeader('content-length', '1000'); response.write('x'); setTimeout(() => response.end(Buffer.alloc(999)), 50) })
    await expect(createPackFiles({ channel: big }).fetchRelease('a.tar.gz', { max: 10 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    const short = await serve((_request, response) => { response.end('abc') })
    await expect(createPackFiles({ channel: short }).fetchRelease('a.tar.gz', { exact: 5 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
  })

  it('refuses a name that is not one plain file name', async () => {
    const channel = await serve((_request, response) => { response.end('x') })
    const files = createPackFiles({ channel })
    for (const name of ['../x', 'a/b', '..', '.', '', '%2e%2e', 'a b']) await expect(files.fetchRelease(name, { max: 5 })).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
  })

  it('fetches an external only from registry.npmjs.org over https, and only the signed URL', async () => {
    const seen: string[] = []
    const fetcher = vi.fn((url: string | URL | Request) => { seen.push(String(url)); return Promise.resolve(new Response('abc')) }) as unknown as typeof fetch
    const files = createPackFiles({ channel: 'https://releases.example/x/', fetch: fetcher })
    await files.fetchExternal(pin('https://registry.npmjs.org/native/-/native-1.0.0.tgz', 3))
    expect(seen).toEqual(['https://registry.npmjs.org/native/-/native-1.0.0.tgz'])
    for (const url of ['https://evil.example/native.tgz', 'http://registry.npmjs.org/native.tgz', 'https://registry.npmjs.org:444/native.tgz', 'https://user@registry.npmjs.org/native.tgz', 'https://registry.npmjs.org.evil.example/native.tgz', 'https://registry.npmjs.org/native.tgz?x=1']) {
      await expect(files.fetchExternal(pin(url, 3))).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
    }
    expect(seen).toHaveLength(1)
  })

  it('refuses a channel that is neither https nor loopback', () => {
    expect(() => createPackFiles({ channel: 'http://releases.example/' })).toThrow(/not an https address/u)
  })
})
