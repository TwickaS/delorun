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
import { consistencyProof, leafHash, treeRoot } from '@delo/release/log/merkle'
import { checkpointBody, signatureLine } from '@delo/release/log/note'
import { generateKeyPairSync } from 'node:crypto'
import { Downloader, RELEASE_HOSTS } from '../src/download.ts'
import { InstallError as InstallFailure, isInstallError, messageOf, type InstallError } from '../src/errors.ts'
import { CHECKPOINT_MAX_BYTES, COSIGNATURE_CLOCK_SKEW_SECONDS, createTilesLogService, LogContradiction, refuseFailedLog, runOnlineCheck, type LogService, type OnlineCheckRequest } from '../src/log.ts'
import { LogStandIn } from '../../release/tests/log/standin.ts'
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
  it('reads the checkpoint from the log’s own host and computes the consistency proof from its tiles', async () => {
    const asked: string[] = []
    const tiles = new LogStandIn()
    tiles.grow(10)
    const leaves = Array.from({ length: 10 }, (_, index) => leafHash(Buffer.from(String(index))))
    const origin = await standIn((request, response) => {
      asked.push(request.url ?? '')
      if (request.url === '/checkpoint') {
        response.writeHead(200).end(NOTE)
        return
      }
      const tile = tiles.tile((request.url ?? '').slice(1))
      response.writeHead(tile === undefined ? 404 : 200).end(tile)
    })
    // The launcher's own downloader keeps contract C1's rule; the log service reads under the list it is given, so a
    // host the release rule refuses is read here without that rule being widened.
    const service = createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader: new Downloader({ timings: TIMINGS }) })
    expect(await service.checkpoint()).toBe(NOTE)
    expect(await service.consistency(3, 10)).toEqual(consistencyProof(3, leaves))
    expect(asked[0]).toBe('/checkpoint')
    expect(asked.slice(1).every(path => path.startsWith('/tile/'))).toBe(true)
    expect(asked.some(path => path.includes('/proof/'))).toBe(false)
  })

  it('counts a redirect to a host the log’s list does not name as an answer that is wrong, before the redirect is followed', async () => {
    const asked: string[] = []
    // The hop keeps the log's scheme, so the host rule is what refuses it rather than the scheme.
    const release = 'http://releases.delorun.com/checkpoint'
    const origin = await standIn((request, response) => {
      asked.push(request.url ?? '')
      response.writeHead(302, { location: release }).end()
    })
    const service = createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader: new Downloader({ timings: TIMINGS }) })
    const error: unknown = await service.checkpoint().then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(LogContradiction)
    expect((error as Error).message).toContain('releases.delorun.com is not an allowed host')
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

  it('fails a checkpoint that is not the log’s: too large, unreadable, another origin or unsigned by the log', async () => {
    const fixture = await fixtureRelease()
    const failure = async (checkpoint: string): Promise<ReleaseLogCheck['failure']> => (await runOnlineCheck(request(fixture, logService(checkpoint)))).check.failure
    expect(await failure('x'.repeat(CHECKPOINT_MAX_BYTES + 1))).toBe('log-signature-invalid')
    expect(await failure('not a checkpoint')).toBe('log-signature-invalid')
    expect(await failure(note(fixture, fixture.leaves, { origin: 'other.example/log' }))).toBe('log-signature-invalid')
    expect(await failure(note(fixture, fixture.leaves, { logSignature: false }))).toBe('log-signature-invalid')
  })

  it('finds the release unchecked, not failed, when no listed witness has cosigned the latest checkpoint', async () => {
    const fixture = await fixtureRelease()
    const missing = await runOnlineCheck(request(fixture, logService(note(fixture, fixture.leaves, { cosign: false }))))
    expect(missing).toMatchObject({ check: { state: 'unchecked' }, detail: 'the latest checkpoint has 0 of the 1 witness cosignatures a check needs' })
    expect(missing.checkpoint).toBeUndefined()
    const stranger = generateKeyPairSync('ed25519').privateKey
    const body = checkpointBody(LOG_ORIGIN, 1, treeRoot([...fixture.leaves]))
    const unlisted = await runOnlineCheck(request(fixture, logService(`${body}\n${signatureLine(LOG_ORIGIN, fixture.keys.log, body)}${signatureLine('stranger.example', stranger, body, NOW - 60)}`)))
    expect(unlisted.check.state).toBe('unchecked')
  })

  it('still fails a log that contradicts the release when its checkpoint lacks the cosignature', async () => {
    const fixture = await fixtureRelease()
    const two = [...fixture.leaves, leafHash(Buffer.from('second'))]
    expect((await runOnlineCheck(request(fixture, logService(note(fixture, two, { cosign: false }))))).check.failure).toBe('consistency-proof-invalid')
    const stored = { treeSize: 5, rootHash: 'cd'.repeat(32) }
    expect((await runOnlineCheck(request(fixture, logService(note(fixture, fixture.leaves, { cosign: false })), { stored }))).check.failure).toBe('checkpoint-rolled-back')
  })

  it('fails a cosignature from a listed witness that is present and does not verify, with the witness named', async () => {
    const fixture = await fixtureRelease()
    const body = checkpointBody(LOG_ORIGIN, 1, treeRoot([...fixture.leaves]))
    const other = checkpointBody(LOG_ORIGIN, 2, treeRoot([...fixture.leaves, leafHash(Buffer.from('second'))]))
    const wrong = `${body}\n${signatureLine(LOG_ORIGIN, fixture.keys.log, body)}${signatureLine(WITNESS_NAME, fixture.keys.witness, other, NOW - 60)}`
    const result = await runOnlineCheck(request(fixture, logService(wrong)))
    expect(result).toMatchObject({ check: { state: 'failed', failure: 'witness-cosignature-missing' }, detail: `the cosignature of witness ${WITNESS_NAME} does not verify` })
    expect(() => refuseFailedLog(result, 'release 0.1.0')).toThrow(`does not verify); nothing was installed`)
  })

  it('fails a cosignature dated in the future beyond the clock skew, and accepts one within it', async () => {
    const fixture = await fixtureRelease()
    const future = await runOnlineCheck(request(fixture, logService(note(fixture, fixture.leaves, { cosignedAt: NOW + COSIGNATURE_CLOCK_SKEW_SECONDS + 1 }))))
    expect(future).toMatchObject({ check: { state: 'failed', failure: 'witness-cosignature-missing' }, detail: `the cosignature of witness ${WITNESS_NAME} is dated ${String(COSIGNATURE_CLOCK_SKEW_SECONDS + 1)} seconds after this computer's clock` })
    const near = await runOnlineCheck(request(fixture, logService(note(fixture, fixture.leaves, { cosignedAt: NOW + COSIGNATURE_CLOCK_SKEW_SECONDS }))))
    expect(near.check.state).toBe('verified')
  })

  it('fails a log that has gone backwards from the stored checkpoint, or whose proof does not verify', async () => {
    const fixture = await fixtureRelease()
    const stored = { treeSize: 5, rootHash: 'cd'.repeat(32) }
    expect((await runOnlineCheck(request(fixture, logService(fixture.checkpoint), { stored }))).check.failure).toBe('checkpoint-rolled-back')
    const two = [...fixture.leaves, leafHash(Buffer.from('second'))]
    expect((await runOnlineCheck(request(fixture, logService(note(fixture, two))))).check.failure).toBe('consistency-proof-invalid')
  })

  it('fails a log whose answer does not hold together, and counts a log that does not answer in time as unchecked', async () => {
    const fixture = await fixtureRelease()
    const wrongCheckpoint = await runOnlineCheck(request(fixture, { checkpoint: () => Promise.reject(new LogContradiction('the log answered 404 for its checkpoint')), consistency: () => Promise.reject(new Error('unused')) }))
    expect(wrongCheckpoint).toMatchObject({ check: { state: 'failed', failure: 'log-signature-invalid' }, detail: 'the log answered 404 for its checkpoint' })
    const two = [...fixture.leaves, leafHash(Buffer.from('second'))]
    const wrongTile = await runOnlineCheck(request(fixture, { checkpoint: () => Promise.resolve(note(fixture, two)), consistency: () => Promise.reject(new LogContradiction('the log serves no tile')) }))
    expect(wrongTile).toMatchObject({ check: { state: 'failed', failure: 'consistency-proof-invalid' }, detail: 'the log serves no tile' })
    const silent = await runOnlineCheck(request(fixture, { checkpoint: () => new Promise(() => undefined), consistency: () => Promise.reject(new Error('unused')) }, { deadlineMs: 20 }))
    expect(silent).toMatchObject({ check: { state: 'unchecked' }, detail: 'the release log did not answer: no answer within 20 ms' })
    const slowProof = await runOnlineCheck(request(fixture, { checkpoint: () => Promise.resolve(note(fixture, two)), consistency: () => new Promise(() => undefined) }, { deadlineMs: 20 }))
    expect(slowProof).toMatchObject({ check: { state: 'unchecked' }, detail: 'the release log gave no consistency proof: no answer within 20 ms' })
  })

  it('refuses an install only for a failed check, naming the reason, and lets a verified or unchecked one go on', () => {
    const verified: ReleaseLogCheck = { release: '0.1.0' as ReleaseLogCheck['release'], state: 'verified', lastAttempt: 1 }
    expect(() => refuseFailedLog({ check: verified }, 'release 0.1.0')).not.toThrow()
    expect(() => refuseFailedLog({ check: { ...verified, state: 'unchecked' }, detail: 'down' }, 'release 0.1.0')).not.toThrow()
    expect(() => refuseFailedLog({ check: { ...verified, state: 'failed', failure: 'checkpoint-rolled-back' } }, 'release 0.1.0')).toThrow('(checkpoint-rolled-back); nothing was installed')
    expect(() => refuseFailedLog({ check: { ...verified, state: 'failed' } }, 'release 0.1.0')).toThrow('(unknown)')
  })
})

describe('what a tiles log answers wrongly', () => {
  /**
   * A log service over a stand-in server.
   * @param handler - what the server answers.
   * @param change - what the service changes.
   * @returns the service.
   */
  async function serviceOver(handler: Parameters<typeof createServer>[1], change: { readonly requestDeadlineMs?: number } = {}): Promise<LogService> {
    const origin = await standIn(handler)
    return createTilesLogService({ origin, hosts: ['127.0.0.1'], downloader: new Downloader({ timings: TIMINGS }), ...change })
  }

  /**
   * Expect a call to fail as an answer that is wrong.
   * @param call - the call.
   * @returns the error's message.
   */
  async function contradiction(call: Promise<unknown>): Promise<string> {
    const error: unknown = await call.then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(LogContradiction)
    return (error as Error).message
  }

  it('is a client bug, not an unreachable log, when the log answers 404 or 410 for its checkpoint', async () => {
    expect(await contradiction((await serviceOver((_, response) => response.writeHead(404).end())).checkpoint())).toBe('the log answered 404 for its checkpoint')
    expect(await contradiction((await serviceOver((_, response) => response.writeHead(410).end())).checkpoint())).toBe('the log answered 410 for its checkpoint')
  })

  it('is the network’s, not the log’s, when the log answers a server error, so the check cannot tell and stays unchecked', async () => {
    const service = await serviceOver((_, response) => response.writeHead(503).end())
    const error: unknown = await service.checkpoint().then(() => undefined, (failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(LogContradiction)
    expect(isInstallError(error, 'DOWNLOAD_FAILED')).toBe(true)
  })

  it('passes on a failure that is not a download failure, as the network’s, not an answer of the log', async () => {
    const service = await serviceOver((_, response) => response.writeHead(302, { location: 'http://[' }).end())
    const error: unknown = await service.checkpoint().then(() => undefined, (failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(LogContradiction)
    expect(error).toBeInstanceOf(TypeError)
  })

  it('fails a checkpoint over the size cap', async () => {
    const service = await serviceOver((_, response) => response.writeHead(200).end('x'.repeat(CHECKPOINT_MAX_BYTES + 1)))
    expect(await contradiction(service.checkpoint())).toContain('larger than the log\'s format allows')
  })

  it('fails a tile that the checkpoint says exists but the log does not serve, and a tile of the wrong length', async () => {
    const missing = await serviceOver((_, response) => response.writeHead(404).end())
    expect(await contradiction(missing.consistency(3, 10))).toContain('the log\'s checkpoint says it holds 10 entries, but the log serves neither')
    const short = await serviceOver((_, response) => response.writeHead(200).end(Buffer.alloc(33)))
    expect(await contradiction(short.consistency(3, 10))).toContain('holds 33 bytes')
    const huge = await serviceOver((_, response) => response.writeHead(200).end(Buffer.alloc(8193)))
    expect(await contradiction(huge.consistency(3, 10))).toContain('larger than the log\'s format allows')
  })

  it('reads a partial tile the log no longer serves from its full tile', async () => {
    const tiles = new LogStandIn()
    tiles.grow(300)
    tiles.keepsReplacedPartials = false
    const leaves = Array.from({ length: 300 }, (_, index) => leafHash(Buffer.from(String(index))))
    const service = await serviceOver((request, response) => {
      const tile = tiles.tile((request.url ?? '').slice(1))
      response.writeHead(tile === undefined ? 404 : 200).end(tile)
    })
    expect(await service.consistency(100, 300)).toEqual(consistencyProof(100, leaves))
  })

  it('counts a log that drips its answer as unreachable once the request’s total deadline passes', async () => {
    const service = await serviceOver((_, response) => {
      response.writeHead(200)
      const timer = setInterval(() => response.write('x'), 100)
      response.on('close', () => { clearInterval(timer) })
    }, { requestDeadlineMs: 400 })
    const error: unknown = await service.checkpoint().then(() => undefined, (failure: unknown) => failure)
    expect(error).not.toBeInstanceOf(LogContradiction)
    expect(isInstallError(error, 'DOWNLOAD_FAILED')).toBe(true)
    expect((error as Error).message).toContain('did not finish within 400 ms')
  })
})

describe('an install failure’s message', () => {
  it('is the error’s own message, or the text of whatever else was thrown', () => {
    expect(messageOf(new InstallFailure('DOWNLOAD_FAILED', 'x', 'detail'))).toBe('DOWNLOAD_FAILED: detail')
    expect(messageOf('plain text')).toBe('plain text')
  })
})
