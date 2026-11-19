/**
 * A signed snapshot of a release channel directory as it stood when one earlier release was the newest, for the
 * installed smoke's upgrade step. The launcher installs a release below the one the channel's timestamp names only
 * after a person confirms it, so the smoke installs the earlier release from a channel whose timestamp names it, then
 * serves the live channel again and updates.
 *
 * @module @delorun/release/installed-smoke/snapshot
 */
import { createHash, createPrivateKey } from 'node:crypto'
import { copyFile, link, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import type { JsonValue } from '@delorun/release-formats/sign/json'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { resignedTimestamp } from '../sign/timestamp.ts'

/** What a snapshot is made from. */
export interface SnapshotRequest {
  /** The live channel directory: `root/`, `timestamp.json` and `releases/download/v<version>/`. */
  readonly channel: string
  /** An empty directory to write the snapshot into. */
  readonly directory: string
  /** The earlier release the snapshot's timestamp names on both channels. */
  readonly release: string
  /** The path of the timestamp private key, PKCS #8 PEM, an Ed25519 key of the channel's root. */
  readonly timestampKey: string
  /** The signing time, in Unix seconds. */
  readonly now: number
}

/**
 * Copy a directory's files, hard-linking where the file system allows it.
 * @param from - the source directory.
 * @param to - the destination, created.
 * @returns when every file is in place.
 */
async function copyFiles(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const name of await readdir(from)) {
    try {
      await link(join(from, name), join(to, name))
    } catch (_crossDevice) {
      // A link fails across file systems or where the file system forbids it; the file is copied instead.
      await copyFile(join(from, name), join(to, name))
    }
  }
}

/**
 * Write the snapshot: the live channel's roots, the earlier release's files, and a timestamp one version below the live
 * one that names the earlier release, signed by the channel's timestamp key and verified under its root.
 * @param request - the channel, the directory, the release, the key and the time.
 * @returns the snapshot timestamp's version.
 * @throws Error when the live timestamp is version 1 or lower than the snapshot needs, the release's manifest is
 *   missing, or the key is not the root's timestamp key.
 */
export async function writeSnapshot(request: SnapshotRequest): Promise<number> {
  const { channel, directory, release, now } = request
  await copyFiles(join(channel, 'root'), join(directory, 'root'))
  const downloads = join('releases', 'download', `v${release}`)
  await copyFiles(join(channel, downloads), join(directory, downloads))
  const roots = await Promise.all((await readdir(join(channel, 'root'))).filter(name => /^\d+\.root\.json$/u.test(name)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map(name => readFile(join(channel, 'root', name))))
  const root = trustRootChain(roots, now).at(-1)!
  const liveBytes = await readFile(join(channel, 'timestamp.json'))
  const live = verifyTimestamp(root, liveBytes, now)
  if (live.version <= 1) throw new Error(`the live timestamp is version ${String(live.version)}, so there is no lower version to sign the snapshot as`)
  const name = `delorun-${release}.manifest.json`
  const manifest = await readFile(join(channel, downloads, name))
  const entry = { release, manifest: { name, length: manifest.length, sha256: createHash('sha256').update(manifest).digest('hex') } }
  const raw = readEnvelope('timestamp', liveBytes).signedJson as { readonly [key: string]: JsonValue }
  const content = resignedTimestamp(live, now)
  const channels = { stable: entry, beta: entry }
  const signed = { ...raw, version: live.version - 1, issued: content.issued, expires: content.expires, channels }
  const key = createPrivateKey(await readFile(request.timestampKey))
  const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed, signatures: [] }, [key]), undefined, 2)}\n`)
  verifyTimestamp(root, bytes, now)
  await writeFile(join(directory, 'timestamp.json'), bytes, { mode: 0o644 })
  return live.version - 1
}
