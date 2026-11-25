/**
 * Publishes a built channel directory (the output of `delorun/apps/release/src/local-release.ts`, or a signed release
 * laid out the same way) to the channel's R2 bucket, and optionally mirrors the release files to the GitHub release.
 *
 * `node delorun/apps/release-channel/src/publish-release.ts --stage <stage> --account <id> --channel <dir> --mark-url <https://host/mark> [--mirror github --tag v<version> --repo <owner/name>]`
 *
 * The Resign Worker's high-water mark moves at publish time: right after `timestamp.json` is uploaded, the script posts
 * it to `--mark-url` (the Worker's `/mark` address: the URL must end in `/mark`, which {@link parseMarkUrl} checks before anything is published), signed with `DELORUN_MARK_SECRET`; a refusal fails the publish
 * ({@link postMark}, `./mark-endpoint.ts`).
 *
 * The S3 token is read from `DELORUN_R2_ACCESS_KEY_ID` and `DELORUN_R2_SECRET_ACCESS_KEY`; it is scoped to Object Read and
 * Write on the one bucket and is never a Worker secret. The order is fixed: the release files under
 * `releases/download/`, then new `root/<n>.root.json` files, then `timestamp.json` last. Release files and roots are
 * create-only (`If-None-Match: *`): a published object is never replaced, and the refusal names the key. An object
 * already stored with identical bytes is skipped, so an interrupted publish resumes. `timestamp.json` is the only
 * replaced key, only to a higher version than the one stored and conditional on the entity tag read just before, so a racing re-signing wins and the publish stops
 * without replacing it.
 *
 * R2 sometimes drops a connection mid-publish (`fetch failed`, undici's `UND_ERR_SOCKET`, "other side closed"). Every
 * store call is therefore tried up to three times, with a growing pause between attempts ({@link retryingStore}); the
 * writes are create-only or conditional, so a repeated attempt cannot publish anything twice. An HTTP answer is never
 * retried: a 403 or a 412 is the bucket's decision, not a dropped connection, and the third dropped connection fails
 * with the error the store raised.
 *
 * `--mirror github` uploads the same release files to the GitHub release `--tag` of `--repo` with
 * `gh release upload`, without `--clobber`, after the bucket publish succeeds.
 *
 * @module @delorun/release-channel/publish-release
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { releaseBucket } from './bucket.ts'
import { MARK_SIGNATURE_HEADER, markSignature } from './mark-endpoint.ts'
import { s3Store } from './s3-store.ts'
import type { PublishStore } from './store.ts'

/** A published object that a publish would have replaced. */
export class PublishRefusal extends Error {
  /**
   * @param message - what was refused, naming the key.
   */
  constructor(message: string) {
    super(message)
    this.name = 'PublishRefusal'
  }
}

/** The undici error code for a connection the other side closed, which R2 answers with under load. */
export const SOCKET_CLOSED_CODE = 'UND_ERR_SOCKET'

/** How many times a store call is tried in all before its socket error is raised. */
export const SOCKET_ATTEMPTS = 3

/** The pause before the second attempt, in milliseconds; each later pause is twice the one before. */
export const SOCKET_BACKOFF_MS = 250

/**
 * Whether an error is a connection the other side closed. undici reports one as `TypeError: fetch failed` with the
 * socket error as its cause, so the cause chain is walked; an HTTP answer is never one, because the store raises those
 * as its own errors after reading the response.
 * @param error - the error a store call raised.
 * @returns whether the connection dropped.
 */
export function isSocketClosed(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (typeof current === 'object' && 'code' in current && (current as { readonly code?: unknown }).code === SOCKET_CLOSED_CODE) return true
    current = typeof current === 'object' && 'cause' in current ? (current as { readonly cause?: unknown }).cause : undefined
  }
  return false
}

/** What {@link retryingStore} needs. */
export interface RetryOptions {
  /** How many attempts a call gets in all; {@link SOCKET_ATTEMPTS} by default. */
  readonly attempts?: number
  /** The pause before the second attempt in milliseconds; {@link SOCKET_BACKOFF_MS} by default. */
  readonly backoffMs?: number
  /** The pause, for tests; a real timer by default. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Receives one line per retry. */
  readonly log?: (line: string) => void
}

/**
 * Wrap a store so a call whose connection dropped is tried again, up to {@link SOCKET_ATTEMPTS} attempts in all, with a
 * growing pause between them. Every write the publisher makes is create-only or conditional on an entity tag, so a
 * repeated attempt publishes nothing twice. An HTTP answer is not retried: a 403 or a 412 is the bucket's decision.
 * @param store - the store to wrap.
 * @param options - the attempt count, the backoff and the log.
 * @returns the store, with each call retried on a dropped connection.
 * @throws the error the store raised, unchanged, when every attempt dropped the connection.
 */
export function retryingStore(store: PublishStore, options: RetryOptions = {}): PublishStore {
  const attempts = options.attempts ?? SOCKET_ATTEMPTS
  const backoffMs = options.backoffMs ?? SOCKET_BACKOFF_MS
  const sleep = options.sleep ?? (async (milliseconds: number): Promise<void> => { await delay(milliseconds) })
  const log = options.log ?? (() => {})
  const attempt = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    for (let tries = 1; ; tries++) {
      try {
        return await call()
      } catch (error) {
        if (!isSocketClosed(error) || tries >= attempts) throw error
        const pause = backoffMs * 2 ** (tries - 1)
        log(`retrying ${what} after a dropped connection (attempt ${String(tries)} of ${String(attempts)}): ${error instanceof Error ? error.message : String(error)}`)
        await sleep(pause)
      }
    }
  }
  return {
    read: async key => await attempt(`GET ${key}`, async () => await store.read(key)),
    list: async prefix => await attempt(`LIST ${prefix}`, async () => await store.list(prefix)),
    putIfAbsent: async (key, bytes) => await attempt(`PUT ${key}`, async () => await store.putIfAbsent(key, bytes)),
    putIfMatch: async (key, bytes, etag) => await attempt(`PUT ${key}`, async () => await store.putIfMatch(key, bytes, etag)),
  }
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await files(path))
    else if (entry.isFile()) found.push(path)
  }
  return found.sort()
}

/**
 * The keys of a channel directory in publishing order.
 * @param channel - the directory.
 * @returns the object keys of the release files, then the roots, then `timestamp.json`, with their paths.
 */
export async function publishPlan(channel: string): Promise<{ key: string, path: string }[]> {
  const all = (await files(channel)).map(path => ({ path, key: relative(channel, path).split(sep).join('/') }))
  const under = (prefix: string): { key: string, path: string }[] => all.filter(entry => entry.key.startsWith(prefix))
  const timestamp = all.filter(entry => entry.key === 'timestamp.json')
  const known = new Set([...under('releases/download/'), ...under('root/'), ...timestamp].map(entry => entry.key))
  const stray = all.find(entry => !known.has(entry.key))
  if (stray !== undefined) throw new Error(`${stray.key} is not a channel file; the channel holds timestamp.json, root/ and releases/download/ only`)
  if (timestamp.length === 0) throw new Error('the channel directory holds no timestamp.json')
  return [...under('releases/download/'), ...under('root/'), ...timestamp]
}

function requireHigherVersion(next: Uint8Array, stored: Uint8Array): void {
  const version = readEnvelope('timestamp', next).signed.version
  const current = readEnvelope('timestamp', stored).signed.version
  if (version <= current) throw new PublishRefusal(`timestamp.json in the bucket is version ${String(current)}; the new one is version ${String(version)}, and a publish only moves it to a higher version (the daily re-signing may have written a newer one; sign the next version from it)`)
}

/**
 * Upload a channel directory to the store.
 * @param store - the store.
 * @param channel - the channel directory.
 * @param log - receives one line per object.
 * @param announceMark - called with the bytes of `timestamp.json` right after they are uploaded; see {@link postMark}.
 * @returns the keys written, in order.
 * @throws PublishRefusal when a release file or root exists with other bytes, `timestamp.json` changed since it was read,
 * or the stored `timestamp.json` has a version equal to or higher than the new one.
 * @throws Error when the new or the stored `timestamp.json` is not a timestamp file.
 */
export async function publishChannel(store: PublishStore, channel: string, log: (line: string) => void = () => {}, announceMark?: (timestamp: Uint8Array) => Promise<void>): Promise<string[]> {
  const written: string[] = []
  for (const { key, path } of await publishPlan(channel)) {
    const bytes = await readFile(path)
    if (key === 'timestamp.json') {
      const current = await store.read(key)
      if (current !== undefined) requireHigherVersion(bytes, current.bytes)
      const ok = current === undefined ? await store.putIfAbsent(key, bytes) : await store.putIfMatch(key, bytes, current.etag)
      if (!ok) throw new PublishRefusal(`${key} was replaced by another writer after it was read; the earlier write stands, nothing was replaced`)
    } else if (!await store.putIfAbsent(key, bytes)) {
      const existing = await store.read(key)
      if (existing === undefined || !Buffer.from(existing.bytes).equals(bytes)) throw new PublishRefusal(`${key} is already published with other bytes; a published object is never replaced`)
      log(`skipped ${key}: published with the same bytes`)
      continue
    }
    written.push(key)
    log(`published ${key}`)
    if (key === 'timestamp.json') await announceMark?.(bytes)
  }
  return written
}

/**
 * Ask the cron Worker to move the high-water mark to the timestamp just uploaded, signed with the shared HMAC secret.
 * @param options - the Worker's mark URL, the secret and the fetch function (global `fetch` by default).
 * @returns the function `publishChannel` calls with the uploaded bytes.
 * @throws Error from that function when the Worker refuses the request, so a publish that did not move the mark fails.
 */
export function postMark(options: { readonly url: string, readonly secret: string, readonly fetch?: typeof fetch }): (timestamp: Uint8Array) => Promise<void> {
  return async (timestamp) => {
    const response = await (options.fetch ?? fetch)(options.url, { method: 'POST', body: new Uint8Array(timestamp), headers: { [MARK_SIGNATURE_HEADER]: markSignature(options.secret, timestamp) } })
    if (!response.ok) throw new Error(`the Worker refused to move the high-water mark (${String(response.status)}): ${(await response.text()).trim()}`)
  }
}

/**
 * Check the `--mark-url` value: an absolute `https:` URL, or an `http:` URL on loopback, whose path ends in `/mark`, the Worker's mark
 * address, so a bare host or the Worker's other paths fail before anything is uploaded.
 * @param value - the `--mark-url` argument.
 * @returns the URL, unchanged.
 * @throws {Error} when the value is not a URL or its path does not end in `/mark`.
 */
export function parseMarkUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`--mark-url must be the Resign Worker's /mark address, a URL ending in /mark; ${JSON.stringify(value)} is not a URL (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  if ((url.protocol !== 'https:' && !loopback) || !url.pathname.endsWith('/mark') || url.search !== '' || url.hash !== '') {
    throw new Error(`--mark-url must be the Resign Worker's /mark address, an https: URL (http: only on loopback) ending in /mark with no query or fragment; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Upload a release's files to a GitHub release with `gh release upload`, never with `--clobber`.
 * @param options - the channel directory, tag and repository, and the command runner (`gh` by default).
 * @returns the file paths uploaded.
 */
export async function mirrorToGithub(options: { readonly channel: string, readonly tag: string, readonly repo: string, readonly run?: (args: readonly string[]) => Promise<void> }): Promise<string[]> {
  const prefix = `releases/download/${options.tag}/`
  const paths = (await publishPlan(options.channel)).filter(entry => entry.key.startsWith(prefix)).map(entry => entry.path)
  if (paths.length === 0) throw new Error(`the channel directory holds no files under ${prefix}`)
  const run = options.run ?? (async (args: readonly string[]): Promise<void> => { await promisify(execFile)('gh', [...args]) })
  await run(['release', 'upload', options.tag, ...paths, '--repo', options.repo])
  return paths
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...argv], strict: true, options: { stage: { type: 'string' }, account: { type: 'string' }, channel: { type: 'string' }, mirror: { type: 'string' }, tag: { type: 'string' }, repo: { type: 'string' }, 'mark-url': { type: 'string' } } })
    if (values.stage === undefined || values.account === undefined || values.channel === undefined) throw new Error('pass --stage <stage>, --account <Cloudflare account id> and --channel <dir>')
    if (values.mirror !== undefined && (values.mirror !== 'github' || values.tag === undefined || values.repo === undefined)) throw new Error('--mirror takes github, with --tag v<version> and --repo <owner/name>')
    const accessKeyId = process.env.DELORUN_R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.DELORUN_R2_SECRET_ACCESS_KEY
    if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('DELORUN_R2_ACCESS_KEY_ID and DELORUN_R2_SECRET_ACCESS_KEY hold no S3 token')
    const markSecret = process.env.DELORUN_MARK_SECRET
    if (values['mark-url'] === undefined || markSecret === undefined) throw new Error('pass --mark-url <the Resign Worker\'s /mark address, ending in /mark> and set DELORUN_MARK_SECRET, so the high-water mark moves when the timestamp is uploaded')
    const markUrl = parseMarkUrl(values['mark-url'])
    const store = retryingStore(s3Store({ accountId: values.account, bucket: releaseBucket(values.stage), accessKeyId, secretAccessKey }), { log: console.log })
    await publishChannel(store, values.channel, console.log, postMark({ url: markUrl, secret: markSecret }))
    if (values.mirror === 'github') {
      const uploaded = await mirrorToGithub({ channel: values.channel, tag: values.tag!, repo: values.repo! })
      console.log(`mirrored ${String(uploaded.length)} files to ${values.repo!} ${values.tag!}`)
    }
    return 0
  } catch (error) {
    console.error(`publish-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
