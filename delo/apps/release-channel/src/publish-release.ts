/**
 * Publishes a built channel directory (the output of `delo/apps/release/src/local-release.ts`, or a signed release
 * laid out the same way) to the channel's R2 bucket, and optionally mirrors the release files to the GitHub release.
 *
 * `node delo/apps/release-channel/src/publish-release.ts --stage <stage> --account <id> --channel <dir> [--mirror github --tag v<version> --repo <owner/name>]`
 *
 * The S3 token is read from `DELO_R2_ACCESS_KEY_ID` and `DELO_R2_SECRET_ACCESS_KEY`; it is scoped to Object Read and
 * Write on the one bucket and is never a Worker secret. The order is fixed: the release files under
 * `releases/download/`, then new `root/<n>.root.json` files, then `timestamp.json` last. Release files and roots are
 * create-only (`If-None-Match: *`): a published object is never replaced, and the refusal names the key. An object
 * already stored with identical bytes is skipped, so an interrupted publish resumes. `timestamp.json` is the only
 * replaced key, conditional on the entity tag read just before, so a racing re-signing wins and the publish stops
 * without replacing it.
 *
 * `--mirror github` uploads the same release files to the GitHub release `--tag` of `--repo` with
 * `gh release upload`, without `--clobber`, after the bucket publish succeeds.
 *
 * @module @delo/release-channel/publish-release
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { releaseBucket } from './bucket.ts'
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

/**
 * Upload a channel directory to the store.
 * @param store - the store.
 * @param channel - the channel directory.
 * @param log - receives one line per object.
 * @returns the keys written, in order.
 * @throws PublishRefusal when a release file or root exists with other bytes, or `timestamp.json` changed since it was read.
 */
export async function publishChannel(store: PublishStore, channel: string, log: (line: string) => void = () => {}): Promise<string[]> {
  const written: string[] = []
  for (const { key, path } of await publishPlan(channel)) {
    const bytes = await readFile(path)
    if (key === 'timestamp.json') {
      const current = await store.read(key)
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
  }
  return written
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
    const { values } = parseArgs({ args: [...argv], strict: true, options: { stage: { type: 'string' }, account: { type: 'string' }, channel: { type: 'string' }, mirror: { type: 'string' }, tag: { type: 'string' }, repo: { type: 'string' } } })
    if (values.stage === undefined || values.account === undefined || values.channel === undefined) throw new Error('pass --stage <stage>, --account <Cloudflare account id> and --channel <dir>')
    if (values.mirror !== undefined && (values.mirror !== 'github' || values.tag === undefined || values.repo === undefined)) throw new Error('--mirror takes github, with --tag v<version> and --repo <owner/name>')
    const accessKeyId = process.env.DELO_R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.DELO_R2_SECRET_ACCESS_KEY
    if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('DELO_R2_ACCESS_KEY_ID and DELO_R2_SECRET_ACCESS_KEY hold no S3 token')
    await publishChannel(s3Store({ accountId: values.account, bucket: releaseBucket(values.stage), accessKeyId, secretAccessKey }), values.channel, console.log)
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
