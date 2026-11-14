/**
 * The transport the online check reads through: the latest checkpoint from one URL, and RFC 6962 consistency proofs
 * built from a C2SP tlog-tiles log's hash tiles. Every answer comes from a fixture `fetch` over a fixture tree whose
 * hashes are computed from RFC 6962 §2.1, so a proof the transport builds wrong disagrees with the RFC's PROOF, and no
 * spec reaches the network. A log that cannot be read leaves the release `unchecked`; a tile the log serves wrong makes
 * a proof that does not verify.
 */
import { describe, expect, it } from 'vitest'
import { RELEASE_LOG_REQUEST_TIMEOUT_SECONDS } from '@delorun/contract-release-log'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { checkOnline, LogContradictionError, LogUnreachableError } from '../src/online.ts'
import { CHECKPOINT_SIZE_LIMIT, logEndpoints, tilesTransport } from '../src/transport.ts'
import type { VerifiedBundle } from '../src/bundle.ts'
import { consistencyProof, COSIGNED_AT, FixtureTiles, scenario, syntheticLeaves, treeRoot } from './fixtures.ts'

const PREFIX = 'https://log.example.test/api/v2'

/** A deadline that never passes. */
const SIGNAL = new AbortController().signal

/**
 * A transport over a fixture tile server.
 * @param tiles - the server.
 * @returns the transport.
 */
function transportOver(tiles: FixtureTiles): ReturnType<typeof tilesTransport> {
  return tilesTransport({ fetch: tiles.fetch, checkpoint: `${tiles.prefix}/checkpoint`, tiles: tiles.prefix })
}

/**
 * The failure a promise rejects with.
 * @param promise - the promise.
 * @returns the error.
 */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('the promise resolved')
}

describe('consistency proofs from tiles', () => {
  it('builds RFC 6962 PROOF between every pair of sizes up to 40 leaves, from level-0 tiles', async () => {
    const leaves = syntheticLeaves(40)
    for (let second = 1; second <= leaves.length; second++) {
      const tiles = new FixtureTiles(PREFIX, leaves.slice(0, second))
      const transport = transportOver(tiles)
      for (let first = 1; first <= second; first++) {
        const expected = consistencyProof(first, leaves.slice(0, second)).map(hash => hash.toString('hex'))
        expect(await transport.consistencyProof(first, second, SIGNAL), `${String(first)} to ${String(second)}`).toEqual(expected)
      }
    }
  })

  it('reads the full tile below a tree that fills it and the partial tile the tree size names above it', async () => {
    const leaves = syntheticLeaves(600)
    const tiles = new FixtureTiles(PREFIX, leaves)
    const transport = transportOver(tiles)
    for (const [first, second] of [[1, 600], [255, 600], [256, 600], [257, 600], [511, 513], [300, 512]] as const) {
      tiles.size = second
      const expected = consistencyProof(first, leaves.slice(0, second)).map(hash => hash.toString('hex'))
      expect(await transportOver(tiles).consistencyProof(first, second, SIGNAL), `${String(first)} to ${String(second)}`).toEqual(expected)
    }
    tiles.requested.length = 0
    tiles.size = 600
    await transport.consistencyProof(300, 600, SIGNAL)
    expect(tiles.requested).toContain(`${PREFIX}/tile/0/001`)
    expect(tiles.requested).toContain(`${PREFIX}/tile/0/002.p/88`)
    expect(tiles.requested).toContain(`${PREFIX}/tile/1/000.p/2`)
  })

  it('reads a subtree of 2^16 leaves as one hash of a level-2 tile', async () => {
    const leaves = syntheticLeaves(65_536 + 300)
    const tiles = new FixtureTiles(PREFIX, leaves)
    // From an older tree past the first 2^16 leaves, that subtree is a sibling the proof carries.
    const expected = consistencyProof(65_636, leaves).map(hash => hash.toString('hex'))
    expect(await transportOver(tiles).consistencyProof(65_636, leaves.length, SIGNAL)).toEqual(expected)
    expect(tiles.requested).toContain(`${PREFIX}/tile/2/000.p/1`)
  }, 60_000)

  it('fetches each tile once per proof', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(20))
    await transportOver(tiles).consistencyProof(3, 20, SIGNAL)
    expect(new Set(tiles.requested).size).toBe(tiles.requested.length)
  })

  it('falls back to the full tile when the partial one is gone because the tile filled since', async () => {
    const leaves = syntheticLeaves(256)
    const tiles = new FixtureTiles(PREFIX, leaves)
    // The tree the proof is for has 200 leaves; the log has grown to fill the tile and serves only the full one.
    const expected = consistencyProof(100, leaves.slice(0, 200)).map(hash => hash.toString('hex'))
    tiles.answers.set(`${PREFIX}/tile/0/000.p/200`, () => new Response('gone', { status: 404 }))
    expect(await transportOver(tiles).consistencyProof(100, 200, SIGNAL)).toEqual(expected)
    expect(tiles.requested).toEqual([`${PREFIX}/tile/0/000.p/200`, `${PREFIX}/tile/0/000`])
  })

  it('reports a tile the tree holds and the log serves by neither name, or at the wrong length, as a contradiction', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(10))
    tiles.answers.set(`${PREFIX}/tile/0/000.p/10`, () => new Response('gone', { status: 410 }))
    const missing = await failureOf(transportOver(tiles).consistencyProof(3, 10, SIGNAL))
    expect(missing).toBeInstanceOf(LogContradictionError)
    expect(missing.message).toBe('the log\'s checkpoint names 10 entries, but the log serves neither tile/0/000.p/10 nor tile/0/000')
    for (const length of [32 * 9, 32 * 11, 32 * 10 + 1]) {
      tiles.answers.set(`${PREFIX}/tile/0/000.p/10`, () => new Response(Buffer.alloc(length)))
      expect(await failureOf(transportOver(tiles).consistencyProof(3, 10, SIGNAL)), String(length)).toBeInstanceOf(LogContradictionError)
    }
    // A full tile served in place of a partial one must be full.
    tiles.answers.set(`${PREFIX}/tile/0/000.p/10`, () => new Response('gone', { status: 404 }))
    tiles.answers.set(`${PREFIX}/tile/0/000`, () => new Response(Buffer.alloc(32 * 10)))
    expect(await failureOf(transportOver(tiles).consistencyProof(3, 10, SIGNAL))).toBeInstanceOf(LogContradictionError)
  })

  it('leaves a tile the log cannot serve now as an unreachable log', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(10))
    tiles.answers.set(`${PREFIX}/tile/0/000.p/10`, () => new Response('busy', { status: 503 }))
    expect(await failureOf(transportOver(tiles).consistencyProof(3, 10, SIGNAL))).toBeInstanceOf(LogUnreachableError)
  })

  it('refuses a proof between sizes no proof runs between, as a defect of the caller', async () => {
    const transport = transportOver(new FixtureTiles(PREFIX, syntheticLeaves(4)))
    expect((await failureOf(transport.consistencyProof(0, 4, SIGNAL))).message).toContain('is not a prefix of a tree of size 4')
    expect((await failureOf(transport.consistencyProof(5, 4, SIGNAL))).message).toContain('is not a prefix')
    expect(await transport.consistencyProof(4, 4, SIGNAL)).toEqual([])
  })

})

describe('the latest checkpoint', () => {
  it('reads the note the checkpoint URL serves, following redirects itself, under the check\'s deadline', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(3))
    tiles.note = 'a note\n'
    expect(await transportOver(tiles).latestCheckpoint(SIGNAL)).toBe('a note\n')
    expect(tiles.inits[0]?.redirect).toBe('manual')
    expect(tiles.inits[0]?.signal).toBeInstanceOf(AbortSignal)
    const controller = new AbortController()
    controller.abort()
    const aborted = tilesTransport({ fetch: (_input, init) => init?.signal?.aborted === true ? Promise.reject(new Error('aborted')) : Promise.resolve(new Response('')), checkpoint: `${PREFIX}/checkpoint`, tiles: PREFIX })
    expect(await failureOf(aborted.latestCheckpoint(controller.signal))).toBeInstanceOf(LogUnreachableError)
    expect(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS).toBe(30)
  })

  it('reads an empty answer as an empty note, which the online check refuses as malformed', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(3))
    tiles.answers.set(`${PREFIX}/checkpoint`, () => new Response(null, { status: 200 }))
    expect(await transportOver(tiles).latestCheckpoint(SIGNAL)).toBe('')
  })

  it('reports a request that fails and an error status as an unreachable source', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(3))
    const url = `${PREFIX}/checkpoint`
    for (const [reason, answer] of [['answered 503', () => new Response('busy', { status: 503 })], ['answered 500', () => new Response(null, { status: 500 })]] as const) {
      tiles.answers.set(url, answer)
      const failure = await failureOf(transportOver(tiles).latestCheckpoint(SIGNAL))
      expect(failure).toBeInstanceOf(LogUnreachableError)
      expect(failure.message).toContain(reason)
    }
    const refused = tilesTransport({ fetch: () => Promise.reject(new TypeError('fetch failed')), checkpoint: url, tiles: PREFIX })
    expect((await failureOf(refused.latestCheckpoint(SIGNAL))).message).toContain('fetch failed')
    const thrown = tilesTransport({ fetch: () => Promise.reject('a reason that is not an Error'), checkpoint: url, tiles: PREFIX })
    expect((await failureOf(thrown.latestCheckpoint(SIGNAL))).message).toContain('a reason that is not an Error')
  })

  it('reports a missing checkpoint, an oversized one and a redirect off the log\'s host as a contradiction', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(3))
    const url = `${PREFIX}/checkpoint`
    const cases: [string, () => Response][] = [
      ['does not serve its checkpoint', () => new Response('missing', { status: 404 })],
      ['does not serve its checkpoint', () => new Response(null, { status: 410 })],
      [`more than ${String(CHECKPOINT_SIZE_LIMIT)} bytes`, () => new Response(Buffer.alloc(CHECKPOINT_SIZE_LIMIT + 1))],
      ['outside the log\'s host log.example.test', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/checkpoint' } })],
      ['outside the log\'s host log.example.test', () => new Response('moved', { status: 301, headers: { location: 'http://log.example.test/checkpoint' } })],
    ]
    for (const [reason, answer] of cases) {
      tiles.answers.set(url, answer)
      const failure = await failureOf(transportOver(tiles).latestCheckpoint(SIGNAL))
      expect(failure).toBeInstanceOf(LogContradictionError)
      expect(failure.message).toContain(reason)
    }
  })

  it('follows a redirect on the log\'s host, and refuses a third', async () => {
    const tiles = new FixtureTiles(PREFIX, syntheticLeaves(3))
    tiles.note = 'a note\n'
    tiles.answers.set(`${PREFIX}/checkpoint`, () => new Response(null, { status: 307, headers: { location: '/api/v2/moved' } }))
    tiles.answers.set(`${PREFIX}/moved`, () => new Response(null, { status: 308, headers: { location: `${PREFIX}/checkpoint-2` } }))
    tiles.answers.set(`${PREFIX}/checkpoint-2`, () => new Response('a moved note\n'))
    expect(await transportOver(tiles).latestCheckpoint(SIGNAL)).toBe('a moved note\n')
    tiles.answers.set(`${PREFIX}/checkpoint-2`, () => new Response(null, { status: 302 }))
    const looping = await failureOf(transportOver(tiles).latestCheckpoint(SIGNAL))
    expect(looping).toBeInstanceOf(LogContradictionError)
    expect(looping.message).toContain('redirects more than 2 times')
  })

  it('reports a body that breaks off while it is read as an unreachable source', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('the connection reset'))
      },
    })
    const transport = tilesTransport({ fetch: () => Promise.resolve(new Response(broken)), checkpoint: `${PREFIX}/checkpoint`, tiles: PREFIX })
    const failure = await failureOf(transport.latestCheckpoint(SIGNAL))
    expect(failure).toBeInstanceOf(LogUnreachableError)
    expect(failure.message).toContain('the connection reset')
  })
})

describe('the log the transport reads', () => {
  it('refuses a checkpoint URL or a tiles prefix that is neither HTTPS nor this machine\'s loopback when it is built', () => {
    const fetch = (): Promise<Response> => Promise.resolve(new Response(''))
    expect(() => tilesTransport({ fetch, checkpoint: 'http://log.example.test/checkpoint', tiles: PREFIX })).toThrow(/checkpoint URL .* is neither HTTPS/u)
    expect(() => tilesTransport({ fetch, checkpoint: `${PREFIX}/checkpoint`, tiles: 'http://log.example.test' })).toThrow(/tiles URL .* is neither HTTPS/u)
    // A local log a build names is read over plain HTTP on this machine only.
    expect(() => tilesTransport({ fetch, checkpoint: 'http://127.0.0.1:8080/checkpoint', tiles: 'http://localhost:8080' })).not.toThrow()
  })

  it('reads the log at the URL prefix the trusted root\'s origin names', () => {
    const fixture = scenario()
    expect(logEndpoints(fixture.root)).toEqual({ checkpoint: 'https://log.example.test/api/v2/checkpoint', tiles: 'https://log.example.test/api/v2' })
    const rooted = (origin: string): RootMetadata => ({ ...fixture.root, log: { ...fixture.root.log, origin } })
    expect(logEndpoints(rooted('log2025-1.rekor.example.test:8443')).tiles).toBe('https://log2025-1.rekor.example.test:8443/api/v2')
    expect(logEndpoints(rooted('Log.Example.test')).tiles).toBe('https://log.example.test/api/v2')
  })

  it('refuses an origin that is not a host with an optional port', () => {
    const fixture = scenario()
    const rooted = (origin: string): RootMetadata => ({ ...fixture.root, log: { ...fixture.root.log, origin } })
    for (const origin of ['https://log.example.test', 'log.example.test/release-log', 'log.example.test/', 'http://[', 'log.example.test?x=1', 'log.example.test#x', 'user@log.example.test', 'user:pass@log.example.test', 'log example']) {
      expect(() => logEndpoints(rooted(origin)), origin).toThrow()
    }
  })
})

describe('the online check over tiles', () => {
  /**
   * What verified offline for a bundle at a tree size.
   * @param size - the bundle's tree size.
   * @param leaves - the log's leaf hashes.
   * @returns the verified bundle.
   */
  function bundleAt(size: number, leaves: readonly Buffer[]): VerifiedBundle {
    const rootHash = treeRoot(leaves.slice(0, size))
    return { treeSize: size, rootHash, cosigned: COSIGNED_AT, checkpoint: { origin: 'log.example.test', size, rootHash, body: '' } }
  }

  it('proves the bundle\'s tree a prefix of the log\'s latest one and returns it to store', async () => {
    const fixture = scenario()
    for (let at = 0; at < 9; at++) fixture.log.append(Buffer.from(`entry ${String(at)}`))
    const endpoints = logEndpoints(fixture.root)
    const tiles = new FixtureTiles(endpoints.tiles, fixture.log.leafHashes)
    tiles.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const verdict = await checkOnline({ root: fixture.root, bundle: bundleAt(3, fixture.log.leafHashes), stored: undefined, transport: tilesTransport({ fetch: tiles.fetch, ...endpoints }), now: COSIGNED_AT + 60 })
    expect(verdict).toMatchObject({ ok: true, checkpoint: { treeSize: 12 } })
  })

  it('c18-inconsistent-log-fails-start: a tile the log serves wrong makes a proof that does not verify', async () => {
    const fixture = scenario()
    for (let at = 0; at < 9; at++) fixture.log.append(Buffer.from(`entry ${String(at)}`))
    const endpoints = logEndpoints(fixture.root)
    const tiles = new FixtureTiles(endpoints.tiles, fixture.log.leafHashes)
    tiles.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    tiles.answers.set(`${endpoints.tiles}/tile/0/000.p/12`, () => new Response(Buffer.alloc(32 * 12, 7)))
    const verdict = await checkOnline({ root: fixture.root, bundle: bundleAt(3, fixture.log.leafHashes), stored: undefined, transport: tilesTransport({ fetch: tiles.fetch, ...endpoints }), now: COSIGNED_AT + 60 })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('leaves the release unchecked when the log answers no tile', async () => {
    const fixture = scenario()
    fixture.log.append(Buffer.from('one more'))
    const endpoints = logEndpoints(fixture.root)
    const tiles = new FixtureTiles(endpoints.tiles, fixture.log.leafHashes)
    tiles.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    tiles.answers.set(`${endpoints.tiles}/tile/0/000.p/4`, () => new Response('down', { status: 502 }))
    const verdict = await checkOnline({ root: fixture.root, bundle: bundleAt(3, fixture.log.leafHashes), stored: undefined, transport: tilesTransport({ fetch: tiles.fetch, ...endpoints }), now: COSIGNED_AT + 60 })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
  })
})
