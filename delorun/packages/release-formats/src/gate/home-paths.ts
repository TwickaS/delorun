/**
 * The gate against the building user's own paths in a release's files. A file built on one person's computer that
 * names their home folder, their user name as a folder, or the build's unique temporary root differs from the same file
 * built elsewhere and publishes who built it and where. {@link homePathProblems} scans every file of a directory, and
 * every entry of each `.tar.gz` and `.tgz` archive in it (runtime closures, packs and the npm launcher's package; the release build and the launcher build both run it), for
 * the strings in {@link builderNeedles}; {@link refuseHomePaths} throws when it finds any.
 *
 * The scan reads bytes, so it covers JavaScript, JSON, YAML, source maps, text and, for the same strings, binary files,
 * which hold a path as plain bytes; it finds no path a binary stores in another encoding, such as UTF-16, and it cannot
 * read inside a `.zip`, whose entries are compressed. A path the build fixes on purpose, the shared build root
 * `/var/tmp/delorun-release-build/source`, is not a finding: only the unique roots `delorun-release-build-<suffix>` of a
 * build from existing artifacts are, where the suffix is the six letters or digits `mkdtemp` appends; text that names
 * the pattern, such as `delorun-release-build-*` in a comment or a document, is not one.
 *
 * @module @delorun/release-formats/gate/home-paths
 */
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { MAX_ARCHIVE_BYTES } from '../archive/entry.ts'
import { readTar } from '../archive/tar.ts'

/** Who built the release: the facts the scan looks for. */
export interface BuilderIdentity {
  /** The building user's home directory, such as `/home/user`. */
  readonly home: string
  /** The building user's login name. */
  readonly username: string
}

/**
 * The building user's identity on this computer.
 * @returns `os.homedir()` and `os.userInfo().username`.
 */
export function currentBuilder(): BuilderIdentity {
  return { home: homedir(), username: userInfo().username }
}

/** One string the scan looks for, with the words a refusal uses for it. */
interface Needle {
  readonly description: string
  readonly bytes: Buffer
  /** When set, the bytes alone are not a finding: the text must also match this, so a file that names the pattern in prose is not refused. */
  readonly confirm?: RegExp
}

/** The prefix of a build root `build-closure.ts` makes beside the fixed one for a build from existing artifacts. */
const UNIQUE_BUILD_ROOT = 'delorun-release-build-'

/** A real unique root: the prefix and the six letters or digits `mkdtemp` appends, with nothing alphanumeric after them. */
const UNIQUE_BUILD_ROOT_NAME = /delorun-release-build-[A-Za-z0-9]{6}(?![A-Za-z0-9])/u

/**
 * What a release's files must not hold, for a builder.
 * @param builder - the building user.
 * @returns the home directory, the user name as a folder in either separator, and the unique build-root prefix; a
 * home directory that is empty or only a separator is left out, since it would match every path.
 * @throws Error when the user name is empty or holds a path separator.
 */
export function builderNeedles(builder: BuilderIdentity): Needle[] {
  if (builder.username === '' || /[\\/]/u.test(builder.username)) throw new Error(`the building user name ${JSON.stringify(builder.username)} is not usable as a path segment`)
  const needles: Needle[] = [
    { description: `the build's temporary root ${UNIQUE_BUILD_ROOT}*`, bytes: Buffer.from(UNIQUE_BUILD_ROOT), confirm: UNIQUE_BUILD_ROOT_NAME },
    { description: `the user name as a folder (/${builder.username}/)`, bytes: Buffer.from(`/${builder.username}/`) },
    { description: `the user name as a folder (\\${builder.username}\\)`, bytes: Buffer.from(`\\${builder.username}\\`) },
  ]
  if (builder.home.replaceAll(/[\\/]/gu, '') !== '') needles.unshift({ description: `the building user's home directory ${builder.home}`, bytes: Buffer.from(builder.home) })
  return needles
}

/** One file or archive entry that holds a builder's path. */
export interface HomePathProblem {
  /** The file, relative to the scanned directory; an archive entry is `<archive>!<entry path>`. */
  readonly file: string
  /** What it holds. */
  readonly found: string
}

function scan(file: string, data: Buffer, needles: readonly Needle[], out: HomePathProblem[]): void {
  const found = needles.filter(needle => data.includes(needle.bytes) && (needle.confirm === undefined || needle.confirm.test(data.toString('latin1')))).map(needle => needle.description)
  if (found.length > 0) out.push({ file, found: found.join('; ') })
}

async function scanArchive(root: string, relative: string, needles: readonly Needle[], out: HomePathProblem[]): Promise<void> {
  const gunzip = createGunzip()
  const input = createReadStream(join(root, relative))
  input.once('error', error => gunzip.destroy(error))
  input.pipe(gunzip)
  try {
    for await (const entry of readTar(gunzip as AsyncIterable<Buffer>, MAX_ARCHIVE_BYTES, { foreign: true })) scan(`${relative}!${entry.path}`, entry.data, needles, out)
  } catch (error) {
    out.push({ file: relative, found: `an archive that could not be read, so its files were not scanned: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    input.destroy()
    gunzip.destroy()
  }
}

async function scanDirectory(root: string, relative: string, needles: readonly Needle[], out: HomePathProblem[]): Promise<void> {
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) await scanDirectory(root, path, needles, out)
    else if (entry.isFile() && /\.(?:tar\.gz|tgz)$/u.test(entry.name)) await scanArchive(root, path, needles, out)
    else if (entry.isFile()) scan(path, await readFile(join(root, path)), needles, out)
  }
}

/**
 * Find the files of a directory that hold a builder's path.
 * @param root - the directory, such as a release's closure build output.
 * @param builder - the building user; this computer's user by default.
 * @returns each offending file or archive entry with what it holds; empty when none does.
 */
export async function homePathProblems(root: string, builder: BuilderIdentity = currentBuilder()): Promise<HomePathProblem[]> {
  const out: HomePathProblem[] = []
  await scanDirectory(root, '', builderNeedles(builder), out)
  return out
}

/** The most files a refusal names; the rest are counted. */
const NAMED = 100

/**
 * Refuse a directory whose files hold a builder's path.
 * @param root - the directory.
 * @param builder - the building user; this computer's user by default.
 * @throws Error naming up to 100 offending files with what each holds, and counting the rest.
 */
export async function refuseHomePaths(root: string, builder: BuilderIdentity = currentBuilder()): Promise<void> {
  const problems = await homePathProblems(root, builder)
  if (problems.length === 0) return
  const lines = problems.slice(0, NAMED).map(problem => `${problem.file}: ${problem.found}`)
  throw new Error(`${String(problems.length)} file${problems.length === 1 ? '' : 's'} of the release name the builder's own paths, which publish who built it and where and differ between builders:\n${lines.join('\n')}${problems.length > NAMED ? `\nand ${String(problems.length - NAMED)} more` : ''}`)
}

/**
 * The gate `build-closure.ts` runs over its output once every file is written: a build from source refuses a builder's
 * path, and a build from existing artifacts, which embeds the worktree's paths and is for a local release only, reports
 * each one.
 * @param root - the build's output directory.
 * @param artifacts - `build` or `existing`, as `build-closure.ts --artifacts` says.
 * @param warn - receives one line per offending file of a build from existing artifacts.
 * @param builder - the building user; this computer's user by default.
 * @throws Error as {@link refuseHomePaths} does, for a build from source.
 */
export async function gateBuildOutput(root: string, artifacts: 'build' | 'existing', warn: (line: string) => void, builder: BuilderIdentity = currentBuilder()): Promise<void> {
  if (artifacts === 'build') return refuseHomePaths(root, builder)
  for (const problem of await homePathProblems(root, builder)) warn(`${problem.file}: ${problem.found}; this build is for a local release only`)
}
