/**
 * Records the real-log vectors of `real-log.spec.ts` from the public Rekor v2 log the release workflow publishes to,
 * `log2025-1.rekor.sigstore.dev`, by read-only `GET` requests only: two of its witnessed checkpoints some seconds apart,
 * and every tile `@delorun/release-verify`'s transport reads to prove the older tree a prefix of the newer one. A person
 * runs it by hand to refresh the vectors; no spec or check runs it, because the specs must not reach the network.
 *
 * Usage: `node_modules/.bin/tsx delorun/packages/release-verify/tests/real/record-real-log.ts <output directory>`
 *
 * @module @delorun/release-verify/tests/real/record-real-log
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCheckpoint, splitNote } from '../../src/note.ts'
import { tilesTransport } from '../../src/transport.ts'

/** The log's host, which its checkpoint origin line names. */
export const REAL_LOG_ORIGIN = 'log2025-1.rekor.sigstore.dev'

/** The prefix below which the log serves its checkpoint and tiles. */
export const REAL_LOG_PREFIX = `https://${REAL_LOG_ORIGIN}/api/v2`

/**
 * Wait.
 * @param milliseconds - how long.
 * @returns when the time passed.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Record the vectors.
 * @param output - the directory to write them to.
 */
async function record(output: string): Promise<void> {
  const recorded = new Map<string, Buffer>()
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init)
    const body = Buffer.from(await response.arrayBuffer())
    if (response.ok) recorded.set(String(input), body)
    return new Response(body, { status: response.status, headers: response.headers })
  }
  const transport = tilesTransport({ fetch, checkpoint: `${REAL_LOG_PREFIX}/checkpoint`, tiles: REAL_LOG_PREFIX })
  const signal = AbortSignal.timeout(120_000)
  const first = await transport.latestCheckpoint(signal)
  const firstSize = parseCheckpoint(splitNote(first).body).size
  let second = first
  for (let attempt = 0; attempt < 30 && parseCheckpoint(splitNote(second).body).size === firstSize; attempt++) {
    await sleep(5_000)
    second = await transport.latestCheckpoint(signal)
  }
  const secondSize = parseCheckpoint(splitNote(second).body).size
  recorded.clear()
  await transport.consistencyProof(firstSize, secondSize, signal)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'checkpoint-first.txt'), first)
  writeFileSync(join(output, 'checkpoint-second.txt'), second)
  for (const [url, body] of recorded) {
    const path = join(output, 'tiles', url.slice(`${REAL_LOG_PREFIX}/`.length))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  writeFileSync(join(output, 'source.json'), `${JSON.stringify({ log: REAL_LOG_PREFIX, fetchedAt: new Date().toISOString(), firstSize, secondSize, tiles: [...recorded.keys()] }, null, 2)}\n`)
}

if (import.meta.main) await record(process.argv[2] ?? join(import.meta.dirname, 'log2025-1'))
