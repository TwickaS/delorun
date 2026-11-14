/**
 * The checksum record of the divergence ledger: the SHA-256 digest of every `security`-class file, recorded on its entry
 * in `delorun/upstream-patches.json`. The digest binds the lead's verdict to the content it reviewed: the upstream update
 * path carries a security entry forward only when its file is the one the ledger recorded, and the boundary gate refuses
 * a recorded digest that no longer matches. Entries of the other classes record no digest.
 *
 * @module @delorun/tools/ledger-digests
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
 * The digest of every named path's content at one commit, read in one `git cat-file --batch` run so that a ledger of
 * hundreds of entries costs one process rather than one per entry.
 * @param root - the repository root.
 * @param commit - the commit to read the content from, which is `HEAD` unless a caller measures an earlier state.
 * @param paths - repository-relative paths, in the order they are looked up.
 * @returns the digest of each path the commit holds; a path it does not hold is absent from the map.
 * @throws Error when git fails or answers with a header this reader cannot read.
 */
export function commitDigests(root: string, commit: string, paths: readonly string[]): Map<string, string> {
  const digests = new Map<string, string>()
  if (paths.length === 0) return digests
  const run = runGitBytes(root, ['cat-file', '--batch'], `${paths.map(path => `${commit}:${path}`).join('\n')}\n`)
  if (run.status !== 0) throw new Error(`git cat-file --batch exited ${String(run.status)}: ${run.stderr.trim()}`)
  let offset = 0
  for (const path of paths) {
    const header = readHeader(run.stdout, offset)
    const size = Number(header.fields[2])
    if (header.fields.length !== 3 || header.fields[1] !== 'blob' || !Number.isSafeInteger(size)) {
      // `<commit>:<path>` that names no object answers `<name> missing`; a path the commit lacks has no digest.
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
 * One recorded digest the content a caller read does not answer for. The kind is kept apart from the message so that a
 * caller can report a path the commit holds no file for under its own code: a listed patch may not delete its file.
 */
export type DigestDefect =
  | {
    /** The listed path. */
    readonly path: string
    /** The content differs from the record. */
    readonly kind: 'mismatch'
    /** The digest the entry records. */
    readonly recorded: string
    /** The digest the content has. */
    readonly actual: string
  }
  | {
    /** The listed path. */
    readonly path: string
    /** The commit holds no file at the path, so there is no content to digest. */
    readonly kind: 'missing'
    /** The digest the entry records. */
    readonly recorded: string
  }

/**
 * The paths of the `security`-class entries, the only entries that record a digest.
 * @param manifest - the parsed ledger.
 * @returns the paths, in ledger order.
 */
export function securityPaths(manifest: PatchManifest): string[] {
  return manifest.patches.filter(patch => patch.class === 'security').map(patch => patch.path)
}

/**
 * Compare the digest each `security`-class entry records with the digest its file has.
 * @param manifest - the parsed ledger.
 * @param digests - the digest of the files the caller read, by path.
 * @returns one defect per recorded digest that differs, and one per recorded digest whose path the caller holds no
 * content for; a security entry that records no digest is a ledger defect that `manifestErrors` reports, not one here.
 */
export function digestDefects(manifest: PatchManifest, digests: ReadonlyMap<string, string>): DigestDefect[] {
  const defects: DigestDefect[] = []
  for (const patch of manifest.patches) {
    const recorded = patch.sha256
    if (patch.class !== 'security' || recorded === undefined) continue
    const actual = digests.get(patch.path)
    if (actual === undefined) {
      defects.push({ path: patch.path, kind: 'missing', recorded })
      continue
    }
    if (actual !== recorded) defects.push({ path: patch.path, kind: 'mismatch', recorded, actual })
  }
  return defects
}

/**
 * Report the defects of the checksum record as messages.
 * @param manifest - the parsed ledger.
 * @param digests - the digest of the files the caller read, by path.
 * @returns one message per recorded digest that differs, and one per recorded digest whose path the caller holds no
 * content for.
 */
export function digestErrors(manifest: PatchManifest, digests: ReadonlyMap<string, string>): string[] {
  return digestDefects(manifest, digests).map(defect => defect.kind === 'missing'
    ? `${defect.path}: recorded sha256 ${defect.recorded} cannot be checked, because the path holds no file to read`
    : `${defect.path}: recorded sha256 ${defect.recorded}, but the file is ${defect.actual}`)
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
