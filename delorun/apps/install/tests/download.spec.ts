/**
 * Contract C1's download rule, as the install path enforces it: a URL that is not a release host is refused before a
 * request leaves the process, a redirect out of the list is refused at the hop, and a download that cannot open,
 * answers a status other than 200, stalls, passes its limit or cannot be written to disk fails without leaving a file
 * behind — always with the download refusal, never a raw `fs` error.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, open as openFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Downloader, RELEASE_TIMINGS } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'

/** The download rule these specs use: plain HTTP so a stand-in server on loopback can answer, and one host. */
const LOOPBACK = { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 2 }

/** The short timeouts these specs use, so a stall fails in milliseconds rather than in contract C1's minute. */
const TIMINGS = { connectMs: 2_000, stallMs: 150 }

let open: Server[] = []
let directories: string[] = []

afterEach(async () => {
  await Promise.all(open.map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  open = []
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A stand-in release host.
 * @param handler - what it answers.
 * @returns its origin, `http://127.0.0.1:<port>`.
 */
async function standIn(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  open.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

/**
 * A port nothing listens on, as a computer with no route to the release host has.
 * @returns the origin.
 */
async function closedPort(): Promise<string> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Expect a download to refuse with a code.
 * @param download - the download.
 * @param code - the expected code.
 * @returns the refusal.
 */
async function refusal(download: Promise<unknown>, code: InstallError['code']): Promise<InstallError> {
  const error: unknown = await download.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

/**
 * A directory a download may write into.
 * @returns its path.
 */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-install-download-'))
  directories.push(directory)
  return directory
}

describe('the host rule', () => {
  it('refuses a release file that does not travel over HTTPS', async () => {
    const downloader = new Downloader()
    const error = await refusal(downloader.bytes('http://127.0.0.1:1/timestamp.json', 1_024), 'DOWNLOAD_REFUSED')
    expect(error.detail).toContain('https:')
  })

  it('refuses a host contract C1 does not list', async () => {
    const downloader = new Downloader()
    const error = await refusal(downloader.bytes('https://example.test/timestamp.json', 1_024), 'DOWNLOAD_REFUSED')
    expect(error.detail).toContain('not an allowed host')
  })

  it('refuses a redirect to a host outside the list, before the redirect is followed', async () => {
    const asked: string[] = []
    const origin = await standIn((request, response) => {
      asked.push(request.url ?? '')
      response.writeHead(302, { location: 'http://127.0.0.2:1/timestamp.json' }).end()
    })
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    const error = await refusal(downloader.bytes(`${origin}/timestamp.json`, 1_024), 'DOWNLOAD_REFUSED')
    expect(error.source).toBe('http://127.0.0.2:1/timestamp.json')
    expect(asked).toEqual(['/timestamp.json'])
  })
})

describe('a download that does not finish', () => {
  it('fails when the connection does not open, as an offline computer has', async () => {
    const origin = await closedPort()
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    const error = await refusal(downloader.bytes(`${origin}/timestamp.json`, 1_024), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('did not open')
  })

  it('fails on a status other than 200', async () => {
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(404).end()
    })
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    const error = await refusal(downloader.bytes(`${origin}/timestamp.json`, 1_024), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('404')
  })

  it('fails on a body above its limit, counted while it arrives', async () => {
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200).end(Buffer.alloc(4_096, 1))
    })
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    await refusal(downloader.bytes(`${origin}/timestamp.json`, 1_024), 'DOWNLOAD_FAILED')
  })

  it('fails on a body that delivers no byte for the stall timeout', async () => {
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200, { 'content-length': '64' })
      response.write(Buffer.alloc(8, 1))
    })
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    await refusal(downloader.bytes(`${origin}/timestamp.json`, 1_024), 'DOWNLOAD_FAILED')
  })
})

describe('a download into a file', () => {
  it('leaves no file behind when the download fails', async () => {
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200).end(Buffer.alloc(4_096, 1))
    })
    const directory = await scratch()
    const path = join(directory, 'archive.tar.gz')
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    await refusal(downloader.file(`${origin}/archive.tar.gz`, 1_024, path), 'DOWNLOAD_FAILED')
    expect(await readdir(directory)).toEqual([])
  })

  it('reports the length and SHA-256 of what it wrote', async () => {
    const body = Buffer.from('the runtime archive\n')
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200, { 'content-length': String(body.byteLength) }).end(body)
    })
    const directory = await scratch()
    const path = join(directory, 'archive.tar.gz')
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    const written = await downloader.file(`${origin}/archive.tar.gz`, 1_024, path)
    expect({ length: written.length, sha256: written.sha256 }).toEqual({
      length: body.byteLength,
      sha256: '742f3750eed6191c78e0403ca38be50570904c70565569e91e9c90dd674062cc',
    })
    expect(await readdir(directory)).toEqual(['archive.tar.gz'])
  })

  it('tells how many bytes are on disk after each piece, ending on the whole length', async () => {
    const pieces = [Buffer.from('the runtime '), Buffer.from('archive'), Buffer.from('\n')]
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200, { 'content-length': String(pieces.reduce((sum, piece) => sum + piece.byteLength, 0)) })
      for (const piece of pieces) response.write(piece)
      response.end()
    })
    const counted: number[] = []
    const downloader = new Downloader({ hosts: LOOPBACK, timings: TIMINGS })
    const written = await downloader.file(`${origin}/archive.tar.gz`, 1_024, join(await scratch(), 'archive.tar.gz'), (bytes) => { counted.push(bytes) })
    expect(counted.at(-1)).toBe(written.length)
    expect([...counted].sort((left, right) => left - right)).toEqual(counted)
    expect(counted.length).toBeGreaterThan(0)
  })

  it('refuses with the download refusal when the disk fills mid-write, and removes the file', async () => {
    const body = Buffer.alloc(4_096, 1)
    const origin = await standIn((request, response) => {
      void request
      response.writeHead(200, { 'content-length': String(body.byteLength) }).end(body)
    })
    const directory = await scratch()
    const path = join(directory, 'archive.tar.gz')
    // A filesystem that fills fails the write, not the open: the refusal must still be the package's own.
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    const downloader = new Downloader({
      hosts: LOOPBACK,
      timings: TIMINGS,
      openFile: async (target, flags, mode) => {
        const real = await openFile(target, flags, mode)
        vi.spyOn(real, 'write').mockRejectedValue(full)
        return real
      },
    })
    const error = await refusal(downloader.file(`${origin}/archive.tar.gz`, 8_192, path), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('ENOSPC')
    expect(await readdir(directory)).toEqual([])
  })
})

describe('contract C1’s published rule', () => {
  it('attempts the release host over HTTPS with C1’s timings, and refuses every other host', async () => {
    const downloader = new Downloader()
    expect(RELEASE_TIMINGS.connectMs).toBe(30_000)
    expect(RELEASE_TIMINGS.stallMs).toBe(60_000)
    await refusal(downloader.bytes('https://registry.npmjs.org/delorun', 1_024), 'DOWNLOAD_REFUSED')
  })
})

describe('a download that takes too long in all', () => {
  /** A host that sends the status line and then one byte every 50 ms, so no stall timeout ever fires. */
  async function dripping(): Promise<string> {
    return standIn((_, response) => {
      response.writeHead(200)
      const timer = setInterval(() => response.write('x'), 50)
      response.on('close', () => { clearInterval(timer) })
    })
  }

  it('fails in memory and into a file once the total deadline passes, though bytes keep arriving', async () => {
    const origin = await dripping()
    const downloader = new Downloader({ hosts: LOOPBACK, timings: { ...TIMINGS, stallMs: 5_000, totalMs: 300 } })
    const error = await refusal(downloader.bytes(`${origin}/x`, 1_000_000), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('the download did not finish within 300 ms')
    const directory = await scratch()
    const toFile = await refusal(downloader.file(`${origin}/x`, 1_000_000, join(directory, 'x')), 'DOWNLOAD_FAILED')
    expect(toFile.detail).toContain('the download did not finish within 300 ms')
    expect(await readdir(directory)).toEqual([])
  })

  it('applies the deadline a derived downloader is given, and keeps its own timings when it is given none', async () => {
    const origin = await dripping()
    const base = new Downloader({ hosts: LOOPBACK, timings: { ...TIMINGS, stallMs: 5_000 } })
    const derived = base.withHosts(LOOPBACK, { totalMs: 250 })
    await refusal(derived.bytes(`${origin}/x`, 1_000_000), 'DOWNLOAD_FAILED')
    const same = base.withHosts(LOOPBACK)
    const stalled = await standIn(() => undefined)
    const quick = new Downloader({ hosts: LOOPBACK, timings: TIMINGS }).withHosts(LOOPBACK)
    expect((await refusal(quick.bytes(`${stalled}/x`, 1_000), 'DOWNLOAD_FAILED')).detail).toContain('the connection did not open')
    expect(same).toBeInstanceOf(Downloader)
  })
})

describe('the other ways a download ends badly', () => {
  /** A downloader over a fetch that answers what a spec chooses. */
  function over(answer: () => Promise<Response>): Downloader {
    return new Downloader({ hosts: LOOPBACK, timings: TIMINGS, fetch: () => answer() })
  }

  it('records the status a host answered, and refuses a redirect that names no location', async () => {
    const error = await refusal(over(() => Promise.resolve(new Response('gone', { status: 410 }))).bytes('http://127.0.0.1/x', 10), 'DOWNLOAD_FAILED')
    expect(error.status).toBe(410)
    const redirect = await refusal(over(() => Promise.resolve(new Response(null, { status: 302 }))).bytes('http://127.0.0.1/x', 10), 'DOWNLOAD_FAILED')
    expect(redirect.detail).toContain('answered 302 without a location')
    expect(redirect.status).toBeUndefined()
  })

  it('marks a body over its limit, declared or counted', async () => {
    const declared = await refusal(over(() => Promise.resolve(new Response('x', { status: 200, headers: { 'content-length': '999' } }))).bytes('http://127.0.0.1/x', 10), 'DOWNLOAD_FAILED')
    expect(declared.oversize).toBe(true)
    const origin = await standIn((_, response) => response.writeHead(200).end('x'.repeat(100)))
    const counted = await refusal(new Downloader({ hosts: LOOPBACK, timings: TIMINGS }).bytes(`${origin}/x`, 10), 'DOWNLOAD_FAILED')
    expect(counted.oversize).toBe(true)
    const other = await refusal(over(() => Promise.resolve(new Response('x', { status: 503 }))).bytes('http://127.0.0.1/x', 10), 'DOWNLOAD_FAILED')
    expect(other.oversize).toBe(false)
  })

  it('reads an empty body, and refuses a URL that does not parse', async () => {
    expect((await over(() => Promise.resolve(new Response(null, { status: 200 }))).bytes('http://127.0.0.1/x', 10)).bytes.byteLength).toBe(0)
    await refusal(over(() => Promise.resolve(new Response('x'))).bytes('http://[', 10), 'DOWNLOAD_REFUSED')
  })

  it('fails a connection that never opens within the connect timeout, and a body that never begins within the stall timeout', async () => {
    const silent = await standIn(() => undefined)
    const connect = await refusal(new Downloader({ hosts: LOOPBACK, timings: { connectMs: 150, stallMs: 150 } }).bytes(`${silent}/x`, 10), 'DOWNLOAD_FAILED')
    expect(connect.detail).toContain('the connection did not open')
    const headersOnly = await standIn((_, response) => { response.writeHead(200).flushHeaders() })
    const stalled = await refusal(new Downloader({ hosts: LOOPBACK, timings: TIMINGS }).bytes(`${headersOnly}/x`, 10), 'DOWNLOAD_FAILED')
    expect(stalled.detail).toContain('delivered no byte for 150 ms')
  })

  it('fails a body whose connection drops, as a download that stopped', async () => {
    const origin = await standIn((_, response) => {
      response.writeHead(200, { 'content-length': '100' })
      // The connection closes once the headers and the first byte are handed to the socket, which delivers them first.
      response.write('x', () => { response.destroy() })
    })
    const error = await refusal(new Downloader({ hosts: LOOPBACK, timings: { ...TIMINGS, stallMs: 5_000 } }).bytes(`${origin}/x`, 1_000), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('the download stopped')
  })

  it('refuses with the download refusal when the file cannot be created, written to completion or closed', async () => {
    const origin = await standIn((_, response) => response.writeHead(200).end('body'))
    const directory = await scratch()
    const denied = new Downloader({ hosts: LOOPBACK, timings: TIMINGS, openFile: () => Promise.reject(new Error('EACCES: denied')) })
    expect((await refusal(denied.file(`${origin}/x`, 100, join(directory, 'a')), 'DOWNLOAD_FAILED')).detail).toContain('cannot be written: EACCES')
    const unclosable = new Downloader({
      hosts: LOOPBACK,
      timings: TIMINGS,
      openFile: async (target, flags, mode) => {
        const real = await openFile(target, flags, mode)
        const close = real.close.bind(real)
        vi.spyOn(real, 'close').mockImplementation(async () => { await close(); throw new Error('EIO: close failed') })
        return real
      },
    })
    expect((await refusal(unclosable.file(`${origin}/x`, 100, join(directory, 'b')), 'DOWNLOAD_FAILED')).detail).toContain('EIO')
    expect(await readdir(directory)).toEqual([])
  })
})
