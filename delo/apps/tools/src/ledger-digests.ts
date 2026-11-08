/**
 * The checksum record of the divergence ledger: the SHA-256 digest of every listed upstream file at `HEAD`, recorded
 * on the entry in `delo/upstream-patches.json`. The record makes a patch set reviewable and portable: the upstream
 * update path carries an entry forward only when the file it would carry is the one the ledger recorded, and the
 * boundary gate refuses a recorded digest that no longer matches.
 *
 * @module @delo/tools/ledger-digests
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PatchManifest } from './fork-boundary.ts'
import { runGitBytes } from './git.ts'

/**
 * The digest of a file's bytes, in the form the ledger records.
 * @param bytes - the file's bytes, or its text when the caller holds it that way.
 * @returns the lowercase hexadecimal SHA-256 digest.
 */
export function patchDigest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The digest of every named path's content at `HEAD`, read in one `git cat-file --batch` run so that a ledger of
 * hundreds of entries costs one process rather than one per entry.
 * @param root - the repository root.
 * @param paths - repository-relative paths, in the order they are looked up.
 * @returns the digest of each path that `HEAD` holds; a path that `HEAD` does not hold is absent from the map.
 * @throws Error when git fails or answers with a header this reader cannot read.
 */
export function headDigests(root: string, paths: readonly string[]): Map<string, string> {
  const digests = new Map<string, string>()
  if (paths.length === 0) return digests
  const run = runGitBytes(root, ['cat-file', '--batch'], `${paths.map(path => `HEAD:${path}`).join('\n')}\n`)
  if (run.status !== 0) throw new Error(`git cat-file --batch exited ${String(run.status)}: ${run.stderr.trim()}`)
  let offset = 0
  for (const path of paths) {
    const header = readHeader(run.stdout, offset)
    const size = Number(header.fields[2])
    if (header.fields.length !== 3 || header.fields[1] !== 'blob' || !Number.isSafeInteger(size)) {
      // `HEAD:<path>` that names no object answers `<name> missing`; a path HEAD lacks has no digest to compare.
      offset = header.contentStart
      continue
    }
    digests.set(path, patchDigest(run.stdout.subarray(header.contentStart, header.contentStart + size)))
    offset = header.contentStart + size + 1
  }
  return digests
}

/**
 * The digest of every named path's bytes in a working tree, for verifying a tree this process wrote rather than a
 * commit.
 * @param tree - the working tree's top level.
 * @param paths - repository-relative paths.
 * @returns the digest of each path the tree holds; a path it lacks is absent from the map.
 */
export function worktreeDigests(tree: string, paths: readonly string[]): Map<string, string> {
  const digests = new Map<string, string>()
  for (const path of paths) {
    try {
      digests.set(path, patchDigest(readFileSync(join(tree, path))))
    } catch (error) {
      // ENOENT and EISDIR: the path is not a file in this tree, so it has no content to record.
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'EISDIR'].includes(String(error.code)))) throw error
    }
  }
  return digests
}

/**
 * Compare the digest each entry records with the digest its file has.
 * @param manifest - the parsed ledger.
 * @param digests - the digest of the files the caller read, by path.
 * @returns one message per recorded digest that differs, and one per recorded digest whose path the caller holds no
 * content for; an entry that records no digest is reported by {@link unrecorded}, not here.
 */
export function digestErrors(manifest: PatchManifest, digests: ReadonlyMap<string, string>): string[] {
  const errors: string[] = []
  for (const patch of manifest.patches) {
    if (patch.sha256 === undefined) continue
    const actual = digests.get(patch.path)
    if (actual === undefined) {
      errors.push(`${patch.path}: recorded sha256 ${patch.sha256} cannot be checked, because the path holds no file to read`)
      continue
    }
    if (actual !== patch.sha256) errors.push(`${patch.path}: recorded sha256 ${patch.sha256}, but the file is ${actual}`)
  }
  return errors
}

/**
 * The entries whose checksum the ledger does not record.
 * @param manifest - the parsed ledger.
 * @returns the paths without a recorded digest, in ledger order.
 */
export function unrecorded(manifest: PatchManifest): string[] {
  return manifest.patches.filter(patch => patch.sha256 === undefined).map(patch => patch.path)
}

/**
 * Read one `git cat-file --batch` header line.
 * @param bytes - the command's standard output.
 * @param offset - the byte offset the header starts at.
 * @returns the header's space-separated fields and the offset its payload starts at.
 * @throws Error when the output carries no further header line.
 */
function readHeader(bytes: Buffer, offset: number): { readonly fields: string[]; readonly contentStart: number } {
  const end = bytes.indexOf(0x0a, offset)
  if (end < 0) throw new Error('git cat-file --batch answered without the header line of an object')
  return { fields: bytes.toString('utf8', offset, end).split(' '), contentStart: end + 1 }
}
