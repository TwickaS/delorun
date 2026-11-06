/**
 * The rebuild record of contract C2 (`delorun-<version>.rebuild.json`): what the targets-key holder rebuilt, with
 * which recipe and toolchain, the digest of every output file and the comparison with the release workflow's output.
 * Signing requires it; this module holds the facts both the recording and the signing command derive.
 *
 * @module @delo/release/rebuild/record
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileRef, Sha256Hex } from '@delo/contract-release-manifest'
import { compareEntryPaths } from '../archive/entry.ts'
import { fileDigest } from '../archive/sink.ts'
import { sha256Hex } from '../brands.ts'

/** The source signing requires, named in every refusal of contract C2's rebuild rule. */
export const REQUIRED_SOURCE = 'a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe'

/** The recipe's directory in the repository. */
export const RECIPE_PATH = 'delo/apps/release'

/**
 * The environment variables that mark a CI run and are set, by name.
 * @param env - the process environment.
 * @returns `CI` and `GITHUB_ACTIONS` when set to a non-empty value.
 */
export function ciMarkers(env: NodeJS.ProcessEnv): string[] {
  return ['CI', 'GITHUB_ACTIONS'].filter(name => (env[name] ?? '') !== '')
}

/**
 * The SHA-256 that names the recipe at a commit: the hash of one line `<sha256>  <path>` per file under
 * {@link RECIPE_PATH}, in byte-wise path order, as `sha256sum` prints them.
 * @param repository - the repository.
 * @param commit - the commit.
 * @returns the digest.
 */
export function recipeDigest(repository: string, commit: string): Sha256Hex {
  const paths = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', commit, '--', RECIPE_PATH], { cwd: repository, encoding: 'utf8' })
    .split('\0').filter(path => path !== '').sort(compareEntryPaths)
  const lines = paths.map((path) => {
    const blob = execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: repository, maxBuffer: 256 * 1024 * 1024 })
    return `${createHash('sha256').update(blob).digest('hex')}  ${path}\n`
  })
  return sha256Hex(createHash('sha256').update(lines.join('')).digest('hex'))
}

/**
 * The file references of every regular file in a build output directory, in byte-wise name order.
 * @param directory - the output directory.
 * @returns one reference per file.
 * @throws Error when the directory holds anything but regular files.
 */
export async function outputRefs(directory: string): Promise<FileRef[]> {
  const refs: FileRef[] = []
  for (const name of (await readdir(directory)).sort(compareEntryPaths)) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error(`${join(directory, name)} is not a regular file`)
    const { length, sha256 } = await fileDigest(join(directory, name))
    refs.push({ name, length, sha256: sha256Hex(sha256) })
  }
  return refs
}

/**
 * The commit a revision names.
 * @param repository - the repository.
 * @param revision - a tag, branch or commit.
 * @returns the 40-hex commit id.
 * @throws Error when the revision names no commit.
 */
export function commitOf(repository: string, revision: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
}

/**
 * The name of a release's rebuild record.
 * @param version - the release.
 * @returns `delorun-<version>.rebuild.json`.
 */
export function rebuildRecordName(version: string): string {
  return `delorun-${version}.rebuild.json`
}
