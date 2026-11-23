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
import { LogVerificationError, verifyBundle, verifyEntryBody } from '@delorun/release-formats/log/bundle'
import { entryBody, entryRequest } from '@delorun/release-formats/log/entry'
import type { LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
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

/** The size limit of a refusal body the submit step reads to name the log's reason. */
const REFUSAL_BODY_LIMIT = 4 * 1024

/**
 * The only answers that mean the log refuses an entry's key type: HTTP 400 with a JSON body whose `message` is one of
 * these. Rekor v2 gives the first whenever it cannot build a `hashedrekord` entry from a request, which includes a key
 * type its instance does not allow; Rekor v1 gives the second for a disallowed algorithm. Because Rekor v2's message
 * also covers a malformed request, a signer moves to its next key only after its own request verified locally.
 */
export const ENTRY_TYPE_REFUSALS: readonly string[] = ['invalid hashedrekord request', 'entry algorithms are not allowed']

/** The log answered an entry submission with a status other than success. */
export class LogSubmitError extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The answer's body as text, at most {@link REFUSAL_BODY_LIMIT} bytes. */
  readonly body: string

  /**
   * @param url - the submission URL.
   * @param status - the HTTP status.
   * @param body - the answer's body as text.
   */
  constructor(url: string, status: number, body: string) {
    super(`${url} answered HTTP ${String(status)}${body === '' ? '' : `: ${body.replace(/\s+/gu, ' ').trim()}`}`)
    this.name = 'LogSubmitError'
    this.status = status
    this.body = body
  }
}

/**
 * Whether a submission failure is the log refusing the entry's key type, and nothing else.
 * @param error - the failure.
 * @returns `true` only for a {@link LogSubmitError} of status 400 whose body is a JSON object whose `message` is exactly
 *   one of {@link ENTRY_TYPE_REFUSALS}.
 */
export function isEntryTypeRefusal(error: unknown): boolean {
  if (!(error instanceof LogSubmitError) || error.status !== 400) return false
  let decoded: unknown
  try {
    decoded = JSON.parse(error.body)
  } catch (_notJson) {
    // A body that is not JSON is no type refusal.
    return false
  }
  if (typeof decoded !== 'object' || decoded === null || !('message' in decoded)) return false
  return typeof decoded.message === 'string' && ENTRY_TYPE_REFUSALS.includes(decoded.message)
}

/**
 * Submit an entry request.
 * @param url - the log's `/api/v2/log/entries`.
 * @param entry - the request.
 * @returns the answer.
 * @throws LogSubmitError when the log answers with a status other than 2xx; Error when it cannot be reached.
 */
async function submitEntry(url: string, entry: HashedRekordRequest): Promise<Response> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry), signal: AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000) })
  if (response.ok) return response
  const body = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0))).subarray(0, REFUSAL_BODY_LIMIT).toString('utf8')
  throw new LogSubmitError(url, response.status, body)
}

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
 * Log a signed release file, the manifest or the packs file, and assemble its verified bundle.
 * @param endpoints - the log's and the distributor's URLs.
 * @param root - the trusted root, whose log and witness keys the bundle must verify with.
 * @param manifestName - the manifest file's name.
 * @param manifest - the manifest file's bytes.
 * @param version - the release version.
 * @param entry - the request the signing command wrote.
 * @param attempts - how many times to ask for a witnessed checkpoint that covers the entry.
 * @param wait - waits between attempts.
 * @param document - which signed release file is logged: the manifest, or the packs file, whose bundle names it.
 * @returns the bundle, verified offline.
 * @throws Error when the log refuses the entry, a checkpoint does not parse, a tile the proof needs is not served or
 * has the wrong length, no checkpoint a listed witness cosigned covers the entry in time, or the bundle fails any
 * other step.
 */
export async function logRelease(endpoints: LogEndpoints, root: RootMetadata, manifestName: string, manifest: Uint8Array, version: string, entry: HashedRekordRequest, attempts: number, wait: () => Promise<void>, document: 'manifest' | 'packs' = 'manifest'): Promise<ReleaseLogBundle> {
  const answer: unknown = await (await submitEntry(endpoints.submit, entry)).json()
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
        verifyBundle(root, manifest, version, bundle, document)
        return bundle
      } catch (error) {
        if (!(error instanceof LogVerificationError && error.failure === 'witness-cosignature-missing')) throw error
      }
    }
    await wait()
  }
  throw new Error(`no checkpoint cosigned by a listed witness covered log index ${String(logged.logIndex)} after ${String(attempts)} attempts; the release is not published`)
}

/** A release file logged by {@link logFirstAccepted} or {@link logWithFallback}. */
export interface LoggedFile {
  /** The verified bundle. */
  readonly bundle: ReleaseLogBundle
  /** The request the log accepted. */
  readonly entry: HashedRekordRequest
  /** The position in the requests, or the signers, of the one the log accepted. */
  readonly signer: number
}

/**
 * Log a signed release file with the first of its signed entry requests whose key type the log accepts.
 *
 * Each request is verified first as a client would verify its entry under the root ({@link verifyEntryBody}), so a
 * request that is wrong never reaches the log. The next request is tried only when the log refuses the entry with one
 * of {@link ENTRY_TYPE_REFUSALS} ({@link isEntryTypeRefusal}); any other status, an unreachable log, a timeout, a
 * checkpoint that never covers the entry and a bundle that does not verify end the attempt. The log accepting an entry
 * proves nothing by itself: {@link logRelease} returns only a bundle that verified under the root.
 * @param endpoints - the log's and the distributor's URLs.
 * @param root - the trusted root the release verifies under.
 * @param name - the signed file's name.
 * @param bytes - the signed file's bytes.
 * @param version - the release version, read from the signed file.
 * @param entries - the signed entry requests, in the order to try them.
 * @param attempts - how many times to ask for a witnessed checkpoint that covers the entry.
 * @param wait - waits between attempts.
 * @param document - which signed release file is logged.
 * @param warn - reports each refused key type.
 * @returns the bundle, the accepted request and its position.
 * @throws Error when no request is given, a request does not verify locally, the last request's type is refused, or
 *   any other failure of {@link logRelease}.
 */
export async function logFirstAccepted(endpoints: LogEndpoints, root: RootMetadata, name: string, bytes: Uint8Array, version: string, entries: readonly HashedRekordRequest[], attempts: number, wait: () => Promise<void>, document: 'manifest' | 'packs', warn: (line: string) => void): Promise<LoggedFile> {
  if (entries.length === 0) throw new Error(`no key this machine holds may sign the log entry of ${name} under root ${String(root.version)}`)
  const typeOf = (entry: HashedRekordRequest): string => entry.hashedRekordRequestV002.signature.verifier.keyDetails
  for (const [position, entry] of entries.entries()) {
    try {
      verifyEntryBody(root, bytes, version, entryBody(entry))
    } catch (error) {
      throw new Error(`the ${typeOf(entry)} log entry of ${name} does not verify under root ${String(root.version)}, so it was not submitted: ${(error as Error).message}`, { cause: error })
    }
    try {
      return { bundle: await logRelease(endpoints, root, name, bytes, version, entry, attempts, wait, document), entry, signer: position }
    } catch (error) {
      if (!isEntryTypeRefusal(error) || position === entries.length - 1) throw error
      warn(`the log refused the ${typeOf(entry)} entry of ${name} (${(error as Error).message}); trying ${typeOf(entries[position + 1]!)}`)
    }
  }
  // The loop returns or throws at its last request.
  throw new Error(`no entry request logged ${name}`)
}

/**
 * Sign a release file's entry request with each signer, in order, and log it as {@link logFirstAccepted} does.
 * @param endpoints - the log's and the distributor's URLs.
 * @param root - the trusted root the release verifies under.
 * @param name - the signed file's name.
 * @param bytes - the signed file's bytes.
 * @param version - the release version.
 * @param signers - the keys that may sign the entry, in the order to try them ({@link entrySigners}).
 * @param attempts - how many times to ask for a witnessed checkpoint that covers the entry.
 * @param wait - waits between attempts.
 * @param document - which signed release file is logged.
 * @param warn - reports each refused key type.
 * @returns the bundle, the accepted request and its signer's position.
 * @throws Error as {@link logFirstAccepted} throws.
 */
export async function logWithFallback(endpoints: LogEndpoints, root: RootMetadata, name: string, bytes: Uint8Array, version: string, signers: readonly LogEntrySigner[], attempts: number, wait: () => Promise<void>, document: 'manifest' | 'packs', warn: (line: string) => void): Promise<LoggedFile> {
  return logFirstAccepted(endpoints, root, name, bytes, version, signers.map(signer => entryRequest(bytes, signer.key, signer.keyDetails)), attempts, wait, document, warn)
}
