/**
 * Real vectors: two witnessed checkpoints of the public Rekor v2 log `log2025-1.rekor.sigstore.dev` and the tiles the
 * client reads to prove the older tree a prefix of the newer one, recorded read-only by `real/record-real-log.ts` on
 * the date `real/log2025-1/source.json` names, with the log's key from Sigstore's trusted root and one witness's key
 * from its operator. Every other spec agrees with fixtures this package's own tests build; these agree with the log a
 * release is published to, so a client that read another address, another note format or another tile layout would
 * fail here. They read only the recorded files.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { VerifiedBundle } from '../src/bundle.ts'
import { checkOnline } from '../src/online.ts'
import { parseCheckpoint, splitNote } from '../src/note.ts'
import { logEndpoints, tilesTransport } from '../src/transport.ts'
import { NOTE_SIGNATURE, rootMetadata, scenario, throwawayKeys, verifierKey } from './fixtures.ts'

const DIRECTORY = join(import.meta.dirname, 'real', 'log2025-1')

/** What the recording names. */
const SOURCE = JSON.parse(readFileSync(join(DIRECTORY, 'source.json'), 'utf8')) as {
  readonly log: string
  readonly firstSize: number
  readonly secondSize: number
  readonly tiles: readonly string[]
  readonly keys: { readonly log: { readonly vkey: string }, readonly witness: { readonly vkey: string } }
}

const FIRST = readFileSync(join(DIRECTORY, 'checkpoint-first.txt'), 'utf8')
const SECOND = readFileSync(join(DIRECTORY, 'checkpoint-second.txt'), 'utf8')

/** The trusted root's log and witness fields for the real log, over fixture keys for every role the check does not read. */
const ROOT = rootMetadata(throwawayKeys(), scenario().log, [], {
  log: { origin: 'log2025-1.rekor.sigstore.dev', vkey: SOURCE.keys.log.vkey },
  witnesses: { keys: [{ name: 'witness.stagemole.eu', vkey: SOURCE.keys.witness.vkey }], threshold: 1 },
})

/**
 * The newest cosigning time of a note's witness lines, read from the recorded note, as the clock of a check run then.
 * @param note - the note.
 * @returns Unix seconds.
 */
function cosignedAt(note: string): number {
  const times = splitNote(note).signatures.filter(line => line.signature.byteLength === 72).map(line => Number(line.signature.readBigUInt64BE(0)))
  return Math.max(...times)
}

/**
 * A fetch that serves the recording, and answers 404 for anything it does not hold.
 * @param change - a replacement for one recorded tile's bytes.
 * @returns the fetch and the URLs it was asked for.
 */
function recordedFetch(change?: { readonly url: string, readonly bytes: Buffer }): { readonly fetch: typeof globalThis.fetch, readonly asked: string[] } {
  const asked: string[] = []
  const fetch: typeof globalThis.fetch = (input) => {
    const url = String(input)
    asked.push(url)
    if (url === `${SOURCE.log}/checkpoint`) return Promise.resolve(new Response(SECOND))
    if (change !== undefined && url === change.url) return Promise.resolve(new Response(new Uint8Array(change.bytes)))
    if (SOURCE.tiles.includes(url)) return Promise.resolve(new Response(new Uint8Array(readFileSync(join(DIRECTORY, 'tiles', url.slice(`${SOURCE.log}/`.length))))))
    return Promise.resolve(new Response('not recorded', { status: 404 }))
  }
  return { fetch, asked }
}

/**
 * The older checkpoint, as an offline check would have accepted it from a bundle.
 * @returns the verified tree.
 */
function firstTree(): VerifiedBundle {
  const checkpoint = parseCheckpoint(splitNote(FIRST).body)
  return { treeSize: checkpoint.size, rootHash: checkpoint.rootHash, cosigned: cosignedAt(FIRST), checkpoint }
}

describe('the public log, recorded', () => {
  it('is read at the address the root\'s origin names, below /api/v2', () => {
    expect(logEndpoints(ROOT)).toEqual({ checkpoint: `${SOURCE.log}/checkpoint`, tiles: SOURCE.log })
    // The recording includes a partial tile of the leaf level and tiles of three levels above it.
    expect(SOURCE.tiles.some(url => /\/tile\/0\/.+\.p\/\d+$/u.test(url))).toBe(true)
    expect(SOURCE.tiles.filter(url => /\/tile\/[1-9]\//u.test(url)).length).toBeGreaterThanOrEqual(1)
  })

  it('verifies the log\'s signature and the witness\'s cosignature, and proves the older tree a prefix of the newer one from its tiles', async () => {
    const { fetch, asked } = recordedFetch()
    const verdict = await checkOnline({ root: ROOT, bundle: firstTree(), stored: undefined, transport: tilesTransport({ fetch, ...logEndpoints(ROOT) }), now: cosignedAt(SECOND) + 60 })
    expect(verdict).toMatchObject({ ok: true, checkpoint: { origin: 'log2025-1.rekor.sigstore.dev', treeSize: SOURCE.secondSize } })
    expect(asked.slice(1).sort()).toEqual([...SOURCE.tiles].sort())
  })

  it('fails the check when one recorded hash of a tile changes', async () => {
    const url = SOURCE.tiles.find(candidate => candidate.includes('/tile/1/'))!
    const bytes = readFileSync(join(DIRECTORY, 'tiles', url.slice(`${SOURCE.log}/`.length)))
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    const { fetch } = recordedFetch({ url, bytes })
    const verdict = await checkOnline({ root: ROOT, bundle: firstTree(), stored: undefined, transport: tilesTransport({ fetch, ...logEndpoints(ROOT) }), now: cosignedAt(SECOND) + 60 })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('leaves the release unchecked when the root names a log key the log did not sign with', async () => {
    const { fetch } = recordedFetch()
    const other = { ...ROOT, log: { ...ROOT.log, vkey: verifierKey('log2025-1.rekor.sigstore.dev', NOTE_SIGNATURE, throwawayKeys().log) } }
    const verdict = await checkOnline({ root: other, bundle: firstTree(), stored: undefined, transport: tilesTransport({ fetch, ...logEndpoints(ROOT) }), now: cosignedAt(SECOND) + 60 })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable', detail: 'the log\'s answer carries no valid signature from the trusted root\'s log key' })
  })
})
