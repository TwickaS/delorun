/**
 * The release log's own host rule (contract C18): the tlog-tiles service reads the log's checkpoint and consistency
 * proof under the hosts the log names — its own origin and the witness network's distributor — and under no other. The
 * release-file rule of contract C1 stays the release files' own, so the log's host is refused there and a release host
 * is refused here. A launcher that handed the log the release downloader's rule refused every log answer, left the
 * release `unchecked`, and so refused every install.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Downloader, RELEASE_HOSTS } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { CHECKPOINT_MAX_BYTES, createTilesLogService } from '../src/log.ts'

/** The short timeouts these specs use, so a refusal is reported in milliseconds rather than in contract C1's minute. */
const TIMINGS = { connectMs: 2_000, stallMs: 500 }

/** A consistent checkpoint note, as a stand-in log serves one. */
const NOTE = 'rekor.sigstore.dev - 1\n42\n' + 'AA==\n'

let open: Server[] = []

afterEach(async () => {
  await Promise.all(open.map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  open = []
})

/**
 * A stand-in log on loopback.
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
 * Expect a promise to refuse with an install error code.
 * @param run - the promise.
 * @param code - the expected code.
 * @returns the refusal.
 */
async function refusal(run: Promise<unknown>, code: InstallError['code']): Promise<InstallError> {
  const error: unknown = await run.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

describe('the log’s host rule', () => {
  it('reads the checkpoint and the consistency proof from the log’s own host', async () => {
    const asked: string[] = []
    const origin = await standIn((request, response) => {
      asked.push(request.url ?? '')
      if (request.url === '/checkpoint') {
        response.writeHead(200).end(NOTE)
        return
      }
      // The older size as eight big-endian bytes, then one 32-byte hash.
      const proof = Buffer.alloc(8 + 32)
      proof.writeBigUInt64BE(1n, 0)
      response.writeHead(200).end(proof)
    })
    // The launcher's own downloader keeps contract C1's rule; the log service reads under the list it is given, so a
    // host the release rule refuses is read here without that rule being widened.
    const downloader = new Downloader({ timings: TIMINGS })
    const service = createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader })
    expect(await service.checkpoint()).toBe(NOTE)
    const proof = await service.consistency(1, 42)
    expect(proof).toHaveLength(1)
    expect(proof[0]?.byteLength).toBe(32)
    expect(asked).toEqual(['/checkpoint', '/proof/consistency?first=1&second=42'])
  })

  it('refuses a release host the log’s list does not name, before the redirect is followed', async () => {
    const asked: string[] = []
    // The hop keeps the log's scheme, so the host rule is what refuses it rather than the scheme.
    const release = 'http://releases.delorun.com/checkpoint'
    const origin = await standIn((request, response) => {
      asked.push(request.url ?? '')
      response.writeHead(302, { location: release }).end()
    })
    const service = createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader: new Downloader({ timings: TIMINGS }) })
    const error = await refusal(service.checkpoint(), 'DOWNLOAD_REFUSED')
    expect(error.source).toBe(release)
    expect(error.detail).toContain('releases.delorun.com is not an allowed host')
    expect(asked).toEqual(['/checkpoint'])
  })

  it('refuses a log origin its own host list does not name', () => {
    const build = (): unknown => createTilesLogService({
      origin: 'https://rekor.sigstore.dev',
      hosts: RELEASE_HOSTS.hosts,
      downloader: new Downloader({ timings: TIMINGS }),
    })
    expect(build).toThrow(/the log's origin is not one of the log hosts/)
  })
})

describe('the release files’ host rule', () => {
  it('refuses the log’s host, which contract C1’s release-file list does not name', async () => {
    const error = await refusal(new Downloader({ timings: TIMINGS }).bytes('https://rekor.sigstore.dev/checkpoint', CHECKPOINT_MAX_BYTES), 'DOWNLOAD_REFUSED')
    expect(error.source).toBe('https://rekor.sigstore.dev/checkpoint')
    expect(error.detail).toContain('rekor.sigstore.dev is not an allowed host')
  })
})
