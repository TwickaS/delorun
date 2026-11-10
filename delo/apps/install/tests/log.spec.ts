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
import type { ReleaseLogCheck } from '@delo/contract-release-log'
import { leafHash, treeRoot } from '@delo/release/log/merkle'
import { checkpointBody, signatureLine } from '@delo/release/log/note'
import { generateKeyPairSync } from 'node:crypto'
import { Downloader, RELEASE_HOSTS } from '../src/download.ts'
import { InstallError as InstallFailure, isInstallError, messageOf, type InstallError } from '../src/errors.ts'
import { CHECKPOINT_MAX_BYTES, createTilesLogService, refuseFailedLog, runOnlineCheck, type LogService, type OnlineCheckRequest } from '../src/log.ts'
import { fixtureRelease, LOG_ORIGIN, NOW, WITNESS_NAME, logService, type Fixture } from './support.ts'

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

describe('the online check', () => {
  /**
   * The check's request for a fixture release, with the log answering what a spec chooses.
   * @param fixture - the release.
   * @param service - the log.
   * @param change - fields to replace.
   * @returns the request.
   */
  function request(fixture: Fixture, service: LogService, change: Partial<OnlineCheckRequest> = {}): OnlineCheckRequest {
    return { root: fixture.rootMetadata, release: '0.1.0' as OnlineCheckRequest['release'], log: { treeSize: 1, rootHash: treeRoot(fixture.leaves) }, service, now: NOW, ...change }
  }

  /**
   * A checkpoint of a tree, signed and cosigned as the fixture's log and witness do.
   * @param fixture - the release whose keys sign.
   * @param leaves - the tree's leaves.
   * @param change - what to leave out or change.
   * @returns the note.
   */
  function note(fixture: Fixture, leaves: readonly Buffer[], change: { readonly origin?: string, readonly logSignature?: boolean, readonly cosign?: boolean, readonly cosignedAt?: number } = {}): string {
    const origin = change.origin ?? LOG_ORIGIN
    const body = checkpointBody(origin, leaves.length, treeRoot([...leaves]))
    const log = change.logSignature === false ? '' : signatureLine(origin, fixture.keys.log, body)
    const witness = change.cosign === false ? '' : signatureLine(WITNESS_NAME, fixture.keys.witness, body, change.cosignedAt ?? NOW - 60)
    return `${body}\n${log}${witness}`
  }

  it('verifies a log whose latest checkpoint is the bundle’s own, and gives the checkpoint to store', async () => {
    const fixture = await fixtureRelease()
    const result = await runOnlineCheck(request(fixture, logService(fixture.checkpoint)))
    expect(result.check).toEqual({ release: '0.1.0', state: 'verified', lastAttempt: NOW })
    expect(result.checkpoint).toEqual({ treeSize: 1, rootHash: treeRoot(fixture.leaves).toString('hex') })
  })

  it('proves consistency from the stored checkpoint when it is at least as large as the bundle’s', async () => {
    const fixture = await fixtureRelease()
    const stored = { treeSize: 1, rootHash: treeRoot(fixture.leaves).toString('hex') }
    expect((await runOnlineCheck(request(fixture, logService(fixture.checkpoint), { stored }))).check.state).toBe('verified')
  })

  it('finds the release unchecked, with the reason, when the log does not answer, the proof is not served or the checkpoint is stale', async () => {
    const fixture = await fixtureRelease()
    const silent = await runOnlineCheck(request(fixture, { checkpoint: () => Promise.reject('connection refused'), consistency: () => Promise.reject(new Error('unused')) }))
    expect(silent).toMatchObject({ check: { state: 'unchecked' }, detail: 'the release log did not answer: connection refused' })
    const two = [...fixture.leaves, leafHash(Buffer.from('second'))]
    const growing = await runOnlineCheck(request(fixture, { checkpoint: () => Promise.resolve(note(fixture, two)), consistency: () => Promise.reject(new Error('503')) }))
    expect(growing).toMatchObject({ check: { state: 'unchecked' }, detail: 'the release log gave no consistency proof: 503' })
    const stale = await runOnlineCheck(request(fixture, logService(note(fixture, fixture.leaves, { cosignedAt: NOW - 90_000 }))))
    expect(stale).toMatchObject({ check: { state: 'unchecked' }, detail: expect.stringContaining('25 hours old') as string })
  })

  it('fails a checkpoint that is not the log’s: too large, unreadable, another origin, unsigned by the log or not cosigned by a listed witness', async () => {
    const fixture = await fixtureRelease()
    const failure = async (checkpoint: string): Promise<ReleaseLogCheck['failure']> => (await runOnlineCheck(request(fixture, logService(checkpoint)))).check.failure
    expect(await failure('x'.repeat(CHECKPOINT_MAX_BYTES + 1))).toBe('log-signature-invalid')
    expect(await failure('not a checkpoint')).toBe('log-signature-invalid')
    expect(await failure(note(fixture, fixture.leaves, { origin: 'other.example/log' }))).toBe('log-signature-invalid')
    expect(await failure(note(fixture, fixture.leaves, { logSignature: false }))).toBe('log-signature-invalid')
    expect(await failure(note(fixture, fixture.leaves, { cosign: false }))).toBe('witness-cosignature-missing')
    const stranger = generateKeyPairSync('ed25519').privateKey
    const body = checkpointBody(LOG_ORIGIN, 1, treeRoot([...fixture.leaves]))
    expect(await failure(`${body}\n${signatureLine(LOG_ORIGIN, fixture.keys.log, body)}${signatureLine('stranger.example', stranger, body, NOW - 60)}`)).toBe('witness-cosignature-missing')
  })

  it('fails a log that has gone backwards from the stored checkpoint, or whose proof does not verify', async () => {
    const fixture = await fixtureRelease()
    const stored = { treeSize: 5, rootHash: 'cd'.repeat(32) }
    expect((await runOnlineCheck(request(fixture, logService(fixture.checkpoint), { stored }))).check.failure).toBe('checkpoint-rolled-back')
    const two = [...fixture.leaves, leafHash(Buffer.from('second'))]
    expect((await runOnlineCheck(request(fixture, logService(note(fixture, two))))).check.failure).toBe('consistency-proof-invalid')
  })

  it('refuses an install only for a failed check, naming the reason, and lets a verified or unchecked one go on', () => {
    const verified: ReleaseLogCheck = { release: '0.1.0' as ReleaseLogCheck['release'], state: 'verified', lastAttempt: 1 }
    expect(() => refuseFailedLog({ check: verified }, 'release 0.1.0')).not.toThrow()
    expect(() => refuseFailedLog({ check: { ...verified, state: 'unchecked' }, detail: 'down' }, 'release 0.1.0')).not.toThrow()
    expect(() => refuseFailedLog({ check: { ...verified, state: 'failed', failure: 'checkpoint-rolled-back' } }, 'release 0.1.0')).toThrow('(checkpoint-rolled-back); nothing was installed')
    expect(() => refuseFailedLog({ check: { ...verified, state: 'failed' } }, 'release 0.1.0')).toThrow('(unknown)')
  })
})

describe('the consistency proof a tiles log serves', () => {
  it('reads hashes with or without the older size in front, and refuses a body that is not a list of hashes', async () => {
    const withoutSize = Buffer.alloc(64, 7)
    const origin = await standIn((request, response) => {
      if (request.url?.includes('first=2')) response.writeHead(200).end(withoutSize)
      else response.writeHead(200).end(Buffer.alloc(33))
    })
    const service = createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader: new Downloader({ timings: TIMINGS }) })
    expect(await service.consistency(2, 4)).toHaveLength(2)
    const error = await refusal(service.consistency(3, 4), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain('33 bytes, which is not a list of 32-byte hashes')
  })
})

describe('an install failure’s message', () => {
  it('is the error’s own message, or the text of whatever else was thrown', () => {
    expect(messageOf(new InstallFailure('DOWNLOAD_FAILED', 'x', 'detail'))).toBe('DOWNLOAD_FAILED: detail')
    expect(messageOf('plain text')).toBe('plain text')
  })
})
