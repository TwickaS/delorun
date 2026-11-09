/**
 * Contract C1's download rule, as the install path enforces it: a URL that is not a release host is refused before a
 * request leaves the process, a redirect out of the list is refused at the hop, and a download that cannot open,
 * answers a status other than 200, stalls, passes its limit or cannot be written to disk fails without leaving a file
 * behind — always with the download refusal, never a raw `fs` error.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, open as openFile, readdir, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  const directory = await mkdtemp(join(tmpdir(), 'delo-install-download-'))
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
      openFile: (async (target: string, flags: string, mode: number) => {
        const real = await openFile(target, flags, mode)
        return { write: () => Promise.reject(full), close: () => real.close() } as unknown as FileHandle
      }) as unknown as typeof openFile,
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
