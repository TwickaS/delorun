/**
 * The files of an installed package: the SHA-256 of each regular file and the target of each symbolic link under its
 * directory, nested `node_modules` left out because each package of a closure is recorded on its own, and each file's
 * identity as `@delorun/runtime-store/identity` defines it. A later check compares the package with what was recorded:
 * the quick check hashes only a file whose identity differs from the recorded one, or whose recorded identity could not
 * vouch, on a file system whose change times only the local kernel sets; the full check hashes every file. Either way,
 * a file added or removed since the record is a change.
 *
 * @module @delorun/plugin-install-check/files
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { changeTimeOf, identityOf, RACY_WINDOW_NS } from '@delorun/runtime-store/identity'

/** What was recorded of one package's files. */
export interface PackageFiles {
  /** Per file, relative to the package's directory with `/` separators: the SHA-256 in hex, or `link:<target>`. */
  readonly files: Readonly<Record<string, string>>
  /** Per file, its identity, or `null` where the identity cannot vouch for it. */
  readonly identities: Readonly<Record<string, string | null>>
  /** Whether the package held more files than were recorded. */
  readonly truncated: boolean
}

/** How a package differs from its record. */
export interface FileChanges {
  /** Files whose content or link target differs. */
  readonly changed: readonly string[]
  /** Files the record does not list. */
  readonly added: readonly string[]
  /** Files the record lists that are gone. */
  readonly removed: readonly string[]
  /** Identities a hash vouched for again, to replace the recorded ones; `null` for one still too recent. */
  readonly identities: Readonly<Record<string, string | null>>
}

/** One file under a package. */
interface Listed {
  readonly path: string
  readonly absolute: string
}

/**
 * The files under a package's directory, nested `node_modules` left out, sorted by path.
 * @param dir - the package's directory.
 * @param limit - the most files listed.
 * @returns the files, and whether there were more.
 */
async function listFiles(dir: string, limit: number): Promise<{ readonly files: Listed[], readonly truncated: boolean }> {
  const files: Listed[] = []
  const walk = async (absolute: string, prefix: string): Promise<boolean> => {
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!await walk(join(absolute, entry.name), path)) return false
        continue
      }
      if (files.length === limit) return false
      files.push({ path, absolute: join(absolute, entry.name) })
    }
    return true
  }
  const complete = await walk(dir, '')
  return { files, truncated: !complete }
}

/**
 * A file's recorded value: the SHA-256 of a regular file, `link:<target>` for a symbolic link, `other` for anything
 * else.
 * @param absolute - the file.
 * @returns the value.
 */
async function valueOf(absolute: string): Promise<string> {
  const stats = await lstat(absolute)
  if (stats.isSymbolicLink()) return `link:${await readlink(absolute)}`
  if (!stats.isFile()) return 'other'
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * A file's identity, when it can vouch: its change time must lie at least the racy window before the capture time.
 * @param absolute - the file.
 * @param capturedAtNs - the capture time, in nanoseconds; no later than the stat.
 * @returns the identity, or `null`.
 */
async function vouchingIdentity(absolute: string, capturedAtNs: bigint): Promise<string | null> {
  const identity = identityOf(await lstat(absolute, { bigint: true }))
  return changeTimeOf(identity) + RACY_WINDOW_NS <= capturedAtNs ? identity : null
}

/**
 * Record a package's files.
 * @param dir - the package's directory.
 * @param limit - the most files recorded.
 * @param capturedAt - the capture time in milliseconds, taken before the walk starts.
 * @returns the record of its files.
 */
export async function capturePackage(dir: string, limit: number, capturedAt: number): Promise<PackageFiles> {
  const { files, truncated } = await listFiles(dir, limit)
  const values: Record<string, string> = {}
  const identities: Record<string, string | null> = {}
  const capturedAtNs = BigInt(capturedAt) * 1_000_000n
  for (const file of files) {
    values[file.path] = await valueOf(file.absolute)
    identities[file.path] = await vouchingIdentity(file.absolute, capturedAtNs)
  }
  return { files: values, identities, truncated }
}

/**
 * Compare a package with its record.
 * @param dir - the package's directory.
 * @param recorded - its record.
 * @param options - `full` hashes every file; otherwise a file whose identity vouches is not read. `trusted` says
 *   whether the directory's file system lets change times vouch; `capturedAt` is the time of this check in
 *   milliseconds, taken before it starts; `limit` the most files listed.
 * @returns the changes, and the identities this check can record.
 */
export async function comparePackage(dir: string, recorded: PackageFiles, options: { readonly full: boolean, readonly trusted: boolean, readonly capturedAt: number, readonly limit: number }): Promise<FileChanges> {
  const { files } = await listFiles(dir, options.limit)
  const capturedAtNs = BigInt(options.capturedAt) * 1_000_000n
  const changed: string[] = []
  const added: string[] = []
  const identities: Record<string, string | null> = {}
  const present = new Set<string>()
  for (const file of files) {
    present.add(file.path)
    const value = recorded.files[file.path]
    if (value === undefined) {
      if (!recorded.truncated) added.push(file.path)
      continue
    }
    const before = recorded.identities[file.path]
    if (!options.full && options.trusted && before !== null && before !== undefined && identityOf(await lstat(file.absolute, { bigint: true })) === before) continue
    if (await valueOf(file.absolute) !== value) {
      changed.push(file.path)
      continue
    }
    identities[file.path] = await vouchingIdentity(file.absolute, capturedAtNs)
  }
  const removed = recorded.truncated ? [] : Object.keys(recorded.files).filter(path => !present.has(path))
  return { changed, added, removed, identities }
}
