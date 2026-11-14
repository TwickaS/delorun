/**
 * The release workflow's side of contract C18: submit a signed manifest's Rekor v2 `hashedrekord` request to the log
 * (`POST /api/v2/log/entries`, answered with a `TransparencyLogEntry` in protobuf JSON), wait until
 * a listed witness has cosigned a checkpoint at or above the entry's tree size, compute the entry's inclusion proof in
 * that checkpoint's tree from the log's tiles, and assemble the release-log bundle, which must verify before the
 * release is published.
 *
 * @module @delorun/release/log/client
 */
import { createHash } from 'node:crypto'
import { RELEASE_LOG_BUNDLE_SCHEMA, RELEASE_LOG_REQUEST_TIMEOUT_SECONDS, type HashedRekordRequest, type ReleaseLogBundle } from '@delorun/contract-release-log'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { LogVerificationError, verifyBundle } from '@delorun/release-formats/log/bundle'
import { parseCheckpoint, splitNote } from '@delorun/release-formats/log/note'
import { inclusionProofFromTiles, TILE_WIDTH } from '@delorun/release-formats/log/tiles'

/** Where the log and the witnessed checkpoints are. */
export interface LogEndpoints {
  /** The log's entry submission URL, Rekor v2's `/api/v2/log/entries`. */
  readonly submit: string
  /** The URL that returns the latest checkpoint with witness cosignatures, as signed-note text. */
  readonly checkpoint: string
  /** The log's tile prefix: the URL below which it serves `tile/<L>/<N>[.p/<W>]` (C2SP `tlog-tiles`). */
  readonly tiles: string
}

/** An int64 in protobuf JSON: a decimal string, and absent when zero. */
const int64 = z.string().regex(/^(?:0|[1-9]\d{0,14})$/u).transform(Number)

/** The `TransparencyLogEntry` fields the bundle keeps. Rekor v2 records no integration time, so it omits the field. */
const Submitted = z.looseObject({ logIndex: int64.optional(), integratedTime: int64.optional(), canonicalizedBody: z.string().min(1) })

/** The size limit of a checkpoint note: a checkpoint with its signature lines is a few hundred bytes. */
const CHECKPOINT_SIZE_LIMIT = 64 * 1024

async function respond(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000) })
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  return response
}

async function bytesOf(url: string, response: Response, limit: number): Promise<Buffer> {
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error(`${url} answered ${String(bytes.byteLength)} bytes, above ${String(limit)}`)
  return bytes
}

/**
 * Read a tile below a log's tile prefix.
 * @param prefix - the tile prefix.
 * @param path - the tile's path.
 * @returns the tile's bytes, or `undefined` when the log answers 404.
 * @throws Error on any other failed answer or one larger than a full tile.
 */
async function fetchTile(prefix: string, path: string): Promise<Uint8Array | undefined> {
  const url = `${prefix.replace(/\/+$/u, '')}/${path}`
  const response = await fetch(url, { signal: AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  return bytesOf(url, response, TILE_WIDTH * 32)
}

/**
 * Log a manifest and assemble its verified bundle.
 * @param endpoints - the log's and the distributor's URLs.
 * @param root - the trusted root, whose log and witness keys the bundle must verify with.
 * @param manifestName - the manifest file's name.
 * @param manifest - the manifest file's bytes.
 * @param version - the release version.
 * @param entry - the request the signing command wrote.
 * @param attempts - how many times to ask for a witnessed checkpoint that covers the entry.
 * @param wait - waits between attempts.
 * @returns the bundle, verified offline.
 * @throws Error when the log refuses the entry, a checkpoint does not parse, a tile the proof needs is not served or
 * has the wrong length, no checkpoint a listed witness cosigned covers the entry in time, or the bundle fails any
 * other step.
 */
export async function logRelease(endpoints: LogEndpoints, root: RootMetadata, manifestName: string, manifest: Uint8Array, version: string, entry: HashedRekordRequest, attempts: number, wait: () => Promise<void>): Promise<ReleaseLogBundle> {
  const answer: unknown = await (await respond(endpoints.submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) })).json()
  const submitted = Submitted.parse(answer)
  // Protobuf JSON omits an int64 that is zero, so an absent index or time is 0.
  const logged = { logIndex: submitted.logIndex ?? 0, integratedTime: submitted.integratedTime ?? 0, body: submitted.canonicalizedBody }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const checkpoint = (await bytesOf(endpoints.checkpoint, await respond(endpoints.checkpoint), CHECKPOINT_SIZE_LIMIT)).toString('utf8')
    const { size, rootHash } = parseCheckpoint(splitNote(checkpoint).body)
    if (size > logged.logIndex) {
      const hashes = await inclusionProofFromTiles(logged.logIndex, size, path => fetchTile(endpoints.tiles, path))
      const bundle: ReleaseLogBundle = {
        schema: RELEASE_LOG_BUNDLE_SCHEMA,
        manifest: { name: manifestName, sha256: brandString<ReleaseLogBundle['manifest']['sha256']>(createHash('sha256').update(manifest).digest('hex')) },
        entry: logged,
        inclusion: { logIndex: logged.logIndex, treeSize: size, rootHash: rootHash.toString('hex'), hashes: hashes.map(hash => hash.toString('hex')) },
        checkpoint,
      }
      try {
        verifyBundle(root, manifest, version, bundle)
        return bundle
      } catch (error) {
        if (!(error instanceof LogVerificationError && error.failure === 'witness-cosignature-missing')) throw error
      }
    }
    await wait()
  }
  throw new Error(`no checkpoint cosigned by a listed witness covered log index ${String(logged.logIndex)} after ${String(attempts)} attempts; the release is not published`)
}
