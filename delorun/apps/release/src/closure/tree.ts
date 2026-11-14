/**
 * The staged closure tree: listing its regular files in archive order with their C2 modes, refusing anything an
 * archive cannot hold, and the runtime file list (contract C2) derived from archive entries.
 *
 * @module @delorun/release/closure/tree
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RELEASE_SCHEMAS,
  type RuntimeFile,
  type RuntimeFileList,
  type RuntimeFileMode,
  type RuntimePlatform,
  type SignedEnvelope,
} from '@delorun/contract-release-manifest'
import { compareEntryPaths, entryPathError } from '@delorun/release-formats/archive/entry'
import { semanticVersion, sha256Hex } from '@delorun/release-formats/brands'

/** One regular file of a staged tree. */
export interface StagedFile {
  /** Path relative to the tree's root, `/`-separated. */
  readonly path: string
  /** Absolute path on disk. */
  readonly absolute: string
  /** `0755` when any execute bit is set, otherwise `0644`. */
  readonly mode: RuntimeFileMode
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu

/**
 * Why a path cannot be installed on a platform, beyond the rules of every archive path.
 * @param path - the entry path.
 * @param platform - the closure's platform.
 * @returns the reason, or `undefined`.
 */
export function platformPathError(path: string, platform: RuntimePlatform): string | undefined {
  if (platform !== 'win32-x64') return undefined
  for (const segment of path.split('/')) {
    if (/[<>:"|?*]/u.test(segment)) return `segment ${JSON.stringify(segment)} holds a character Windows refuses`
    if (/[. ]$/u.test(segment)) return `segment ${JSON.stringify(segment)} ends with a dot or a space`
    if (WINDOWS_RESERVED.test(segment)) return `segment ${JSON.stringify(segment)} is a reserved Windows device name`
  }
  return undefined
}

/**
 * List the regular files of a staged tree in byte-wise path order.
 * @param root - the tree's root directory.
 * @param platform - the closure's platform; macOS and Windows closures refuse two paths that differ only in case.
 * @returns every regular file.
 * @throws Error listing every symbolic link, special file, invalid path and case collision found.
 */
export async function listStagedTree(root: string, platform: RuntimePlatform): Promise<StagedFile[]> {
  const files: StagedFile[] = []
  const problems: string[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort(compareEntryPaths)
    for (const name of names) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      const absolute = join(directory, name)
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        await walk(absolute, path)
        continue
      }
      if (!info.isFile()) {
        problems.push(`${path}: ${info.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}`)
        continue
      }
      const error = entryPathError(path) ?? platformPathError(path, platform)
      if (error !== undefined) problems.push(`${path}: ${error}`)
      files.push({ path, absolute, mode: (info.mode & 0o111) === 0 ? '0644' : '0755' })
    }
  }
  await walk(root, '')
  files.sort((left, right) => compareEntryPaths(left.path, right.path))
  if (platform === 'darwin-x64' || platform === 'darwin-arm64' || platform === 'win32-x64') {
    const seen = new Map<string, string>()
    for (const file of files) {
      const folded = file.path.toLowerCase()
      const other = seen.get(folded)
      if (other !== undefined) problems.push(`${file.path}: differs from ${other} only in case`)
      else seen.set(folded, file.path)
    }
  }
  if (problems.length > 0) throw new Error(`the staged closure cannot be archived:\n${problems.join('\n')}`)
  return files
}

/** One archive entry as the file list records it. */
export interface ListedEntry {
  readonly path: string
  readonly mode: RuntimeFileMode
  readonly length: number
  readonly sha256: string
}

/**
 * The runtime file list of one closure archive.
 * @param version - the release.
 * @param platform - the closure's platform.
 * @param entries - the archive's entries, in archive order.
 * @returns the list's signed content.
 * @throws Error when the version or a digest is malformed.
 */
export function runtimeFileList(version: string, platform: RuntimePlatform, entries: readonly ListedEntry[]): RuntimeFileList {
  return {
    schema: RELEASE_SCHEMAS.files,
    version: semanticVersion(version),
    platform,
    files: entries.map((entry): RuntimeFile => ({ path: entry.path, length: entry.length, sha256: sha256Hex(entry.sha256), mode: entry.mode })),
  }
}

/**
 * The bytes of a release file before signing: the envelope with no signatures, as two-space indented JSON and one
 * newline.
 * @param signed - the content.
 * @returns the file's text.
 */
export function unsignedEnvelopeText<T>(signed: T): string {
  const envelope: SignedEnvelope<T> = { signed, signatures: [] }
  return `${JSON.stringify(envelope, undefined, 2)}\n`
}

/**
 * The release file names of one platform's closure.
 * @param version - the release.
 * @param platform - the platform.
 * @returns the archive's and the file list's names.
 */
export function closureFileNames(version: string, platform: RuntimePlatform): { archive: string, files: string } {
  return {
    archive: `delorun-${version}-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`,
    files: `delorun-${version}-${platform}.files.json`,
  }
}
