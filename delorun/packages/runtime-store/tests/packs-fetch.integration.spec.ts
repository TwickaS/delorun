/**
 * The pack transport fetches only signed names and URLs, never follows a redirect, and stops reading at the signed
 * length. Each case runs against a real HTTP server on the loopback address.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
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

const pin = (url: string, length: number, body = 'abc'): PackExternal => ({ name: 'native', version: brandString<SemanticVersion>('1.0.0'), url, sha512: brandString<Sha512Base64>(createHash('sha512').update(body).digest('base64')), length })

describe('the pack transport', () => {
  it('fetches a signed name from the channel within its exact size', async () => {
    const channel = await serve((request, response) => { response.end(request.url === '/release/a.tar.gz' ? 'hello' : 'wrong') })
    expect(Buffer.from((await createPackFiles({ channel, stallSeconds: 30 }).fetchRelease('a.tar.gz', { exact: 5 }))!).toString()).toBe('hello')
  })

  it('returns undefined for a file the channel lacks', async () => {
    const channel = await serve((_request, response) => { response.statusCode = 404; response.end() })
    expect(await createPackFiles({ channel, stallSeconds: 30 }).fetchRelease('a.tar.gz', { max: 5 })).toBeUndefined()
  })

  it('refuses a redirect and never reads where it points', async () => {
    let followed = false
    const target = await serve((_request, response) => { followed = true; response.end('x') })
    const channel = await serve((_request, response) => { response.statusCode = 302; response.setHeader('location', target); response.end() })
    await expect(createPackFiles({ channel, stallSeconds: 30 }).fetchRelease('a.tar.gz', { max: 5 })).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
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
    await expect(createPackFiles({ channel, stallSeconds: 30 }).fetchRelease('a.tar.gz', { exact: 2048 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(sent).toBeLessThan(64 * 1024)
  })

  it('refuses a declared length above the limit before reading, and a short body of an exact size', async () => {
    const big = await serve((_request, response) => { response.setHeader('content-length', '1000'); response.write('x'); setTimeout(() => response.end(Buffer.alloc(999)), 50) })
    await expect(createPackFiles({ channel: big, stallSeconds: 30 }).fetchRelease('a.tar.gz', { max: 10 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    const short = await serve((_request, response) => { response.end('abc') })
    await expect(createPackFiles({ channel: short, stallSeconds: 30 }).fetchRelease('a.tar.gz', { exact: 5 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
  })

  it('refuses a name that is not one plain file name', async () => {
    const channel = await serve((_request, response) => { response.end('x') })
    const files = createPackFiles({ channel, stallSeconds: 30 })
    for (const name of ['../x', 'a/b', '..', '.', '', '%2e%2e', 'a b']) await expect(files.fetchRelease(name, { max: 5 })).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
  })

  it('fetches an external only from registry.npmjs.org over https, and only the signed URL', async () => {
    const seen: string[] = []
    const fetcher: typeof fetch = vi.fn((url: string | URL | Request) => { seen.push(String(url)); return Promise.resolve(new Response('abc')) })
    const files = createPackFiles({ channel: 'https://releases.example/x/', stallSeconds: 30, fetch: fetcher })
    await files.fetchExternal(pin('https://registry.npmjs.org/native/-/native-1.0.0.tgz', 3))
    expect(seen).toEqual(['https://registry.npmjs.org/native/-/native-1.0.0.tgz'])
    for (const url of ['https://evil.example/native.tgz', 'http://registry.npmjs.org/native.tgz', 'https://registry.npmjs.org:444/native.tgz', 'https://user@registry.npmjs.org/native.tgz', 'https://registry.npmjs.org.evil.example/native.tgz', 'https://registry.npmjs.org/native.tgz?x=1']) {
      await expect(files.fetchExternal(pin(url, 3))).rejects.toMatchObject({ code: 'FETCH_REFUSED' })
    }
    expect(seen).toHaveLength(1)
  })

  it('refuses a channel that is neither https nor loopback', () => {
    expect(() => createPackFiles({ channel: 'http://releases.example/', stallSeconds: 30 })).toThrow(/not an https address/u)
  })
  it('refuses a body whose SHA-512 differs from the signed one, as it arrives', async () => {
    const fetcher: typeof fetch = vi.fn(() => Promise.resolve(new Response('abd')))
    const files = createPackFiles({ channel: 'https://releases.example/x/', stallSeconds: 30, fetch: fetcher })
    await expect(files.fetchExternal(pin('https://registry.npmjs.org/native/-/native-1.0.0.tgz', 3))).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
  })

  it('lets a slow download that keeps receiving data finish, however long it takes in total', async () => {
    const body = 'abcdefghij'
    const channel = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': String(body.length) })
      let sent = 0
      const timer = setInterval(() => {
        response.write(body.slice(sent, sent + 2))
        sent += 2
        if (sent >= body.length) { clearInterval(timer); response.end() }
      }, 250)
    })
    // Five pieces 250 ms apart take about 1.25 s, longer than the 1 s stall limit, yet no gap reaches it.
    const received: number[] = []
    const files = createPackFiles({ channel, stallSeconds: 1 })
    const bytes = await files.fetchRelease('a.tar.gz', { exact: body.length, sha512: createHash('sha512').update(body).digest('base64') }, { onBytes: (count) => { received.push(count) } })
    expect(Buffer.from(bytes!).toString()).toBe(body)
    expect(received.at(-1)).toBe(body.length)
  })

  it('fails a download that stops receiving data, saying how long and from where', async () => {
    const channel = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': '10' })
      response.write('abc')
    })
    const files = createPackFiles({ channel, stallSeconds: 1 })
    const failure = await files.fetchRelease('a.tar.gz', { exact: 10 }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'FETCH_REFUSED' })
    expect((failure as Error).message).toMatch(/a\.tar\.gz \(http:\/\/127\.0\.0\.1:\d+\/release\/a\.tar\.gz\) received no data for 1 seconds/u)
  })

  it('counts the stall limit from the request, so a download whose first byte never comes fails too', async () => {
    const channel = await serve(() => undefined)
    const files = createPackFiles({ channel, stallSeconds: 1 })
    await expect(files.fetchRelease('a.tar.gz', { exact: 10 })).rejects.toThrow(/received no data for 1 seconds/u)
  })

  it('gives a metadata file one total limit that its pieces do not extend', async () => {
    const channel = await serve((_request, response) => {
      response.writeHead(200)
      const timer = setInterval(() => { response.write('ab') }, 250)
      response.on('close', () => { clearInterval(timer) })
    })
    const files = createPackFiles({ channel, stallSeconds: 60, timeoutSeconds: 1 })
    await expect(files.fetchRelease('delorun-0.1.0.packs.json', { max: 1000 })).rejects.toThrow(/took more than 1 seconds in total/u)
  })

  it('refuses a body whose SHA-256 differs from the signed one, as it arrives', async () => {
    const body = 'abcdef'
    const channel = await serve((_request, response) => { response.end(body) })
    const files = createPackFiles({ channel, stallSeconds: 30 })
    const sha512 = createHash('sha512').update(body).digest('base64')
    await expect(files.fetchRelease('a.tar.gz', { exact: body.length, sha512, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    await expect(files.fetchRelease('a.tar.gz', { exact: body.length, sha512, sha256: createHash('sha256').update(body).digest('hex') })).resolves.toBeDefined()
  })

  it('stops reading as soon as the body passes the signed length', async () => {
    let wrote = 0
    const channel = await serve((_request, response) => {
      response.writeHead(200)
      const timer = setInterval(() => { wrote += 4; response.write('abcd') }, 20)
      response.on('close', () => { clearInterval(timer) })
    })
    const files = createPackFiles({ channel, stallSeconds: 30 })
    await expect(files.fetchRelease('a.tar.gz', { exact: 6 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    expect(wrote).toBeLessThan(40)
  })

  it('refuses a channel address with a user name or password before any request, without repeating it', () => {
    const fetcher: typeof fetch = vi.fn(() => Promise.reject(new Error('Request cannot be constructed from a URL that includes credentials: https://person:secret@releases.example/x/a.tar.gz')))
    let failure: unknown
    try {
      createPackFiles({ channel: 'https://person:secret@releases.example/x/', stallSeconds: 30, fetch: fetcher })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'FETCH_REFUSED' })
    expect((failure as Error).message).not.toMatch(/person|secret/u)
    expect(fetcher).not.toHaveBeenCalled()
    // An address that is neither https nor loopback is refused for the credentials first, never printed with them.
    for (const channel of ['http://person:secret@releases.example/x/', 'ftp://person:secret@releases.example/x/']) {
      expect(() => createPackFiles({ channel, stallSeconds: 30 })).toThrow(/user name or password/u)
      expect(() => createPackFiles({ channel, stallSeconds: 30 })).not.toThrow(/person|secret/u)
    }
  })

  it('cuts a metadata file at the release files\' 30 seconds in total, however steadily its pieces arrive', async () => {
    vi.useFakeTimers()
    try {
      // Like the real fetch, the stand-in errors its body when the request is aborted.
      const fetcher: typeof fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0
          const timer = setInterval(() => { sent += 1; controller.enqueue(new Uint8Array([97])); if (sent > 100) { clearInterval(timer); controller.close() } }, 5000)
          init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(new Error('This operation was aborted')) })
        },
      }))))
      const files = createPackFiles({ channel: 'https://releases.example/x/', stallSeconds: 3600, fetch: fetcher })
      const outcome = files.fetchRelease('delorun-0.1.0.packs.json', { max: 1000 }).then(() => undefined, (error: unknown) => error)
      await vi.advanceTimersByTimeAsync(31_000)
      expect((await outcome as Error).message).toMatch(/took more than 30 seconds in total/u)
    } finally {
      vi.useRealTimers()
    }
  })
})
