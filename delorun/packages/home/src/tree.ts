/**
 * Create the Delorun home and Delorun's entries in it at mode 0700, and refuse a
 * home, `secrets/` or `run/<profile>/` that is laxer, a symbolic link or
 * another user's (contract C1, "Modes and the refusal rule").
 *
 * Linux and macOS only: Windows has no mode bits, and C1's DACL check is not
 * implemented here, so on Windows the directories are created without a
 * check. Upstream's entries keep upstream's layout and modes; this module
 * creates none of them.
 *
 * @module @delorun/home/tree
 */
import { lstatSync, type Stats } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, FORBIDDEN_MODE_BITS, PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { HomeLayoutError, shellPath } from './errors.ts'

/**
 * The run directory of one CLI profile.
 * @param home - the Delorun home.
 * @param profile - the CLI profile's name.
 * @returns `<home>/run/<profile>`.
 */
export function runDirectory(home: string, profile: string): string {
  return join(home, DELORUN_HOME_ENTRIES.run, profile)
}

/**
 * Create one directory at mode 0700 unless it exists. The mode is given at
 * creation, so the umask can only narrow it; an existing directory keeps its mode.
 * @param path - the directory.
 */
async function makePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * The refusal for a directory that C1 requires to be private, or `undefined` when it is private.
 * @param path - the directory.
 * @param stats - its `lstat` result.
 * @returns the refusal, or `undefined`.
 */
function directoryRefusal(path: string, stats: Stats): HomeLayoutError | undefined {
  if (stats.isSymbolicLink()) return new HomeLayoutError('HOME_MODE', path, `${path} is a symbolic link; it must be a directory of its own`)
  if (!stats.isDirectory()) return new HomeLayoutError('HOME_MODE', path, `${path} is not a directory`)
  if (stats.uid !== process.getuid?.()) return new HomeLayoutError('HOME_MODE', path, `${path} belongs to another user (uid ${String(stats.uid)})`)
  const mode = stats.mode & 0o777
  if ((mode & FORBIDDEN_MODE_BITS) === 0) return undefined
  return new HomeLayoutError('HOME_MODE', path, `${path} has mode ${mode.toString(8).padStart(4, '0')}, which other users can reach; it must be 0700`, `chmod 700 ${shellPath(path)}`)
}

/**
 * Refuse a directory that C1 requires to be private: one that is a symbolic
 * link, not a directory, owned by another user, or has a group or other bit set.
 * @param path - the absolute directory path.
 * @throws {HomeLayoutError} `HOME_MODE`, naming the path and the `chmod 700` fix where one applies.
 */
export async function checkPrivateDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const problem = directoryRefusal(path, await lstat(path))
  if (problem !== undefined) throw problem
}

/**
 * {@link checkPrivateDirectory}, synchronously, for callers on a synchronous path such as a log writer.
 * @param path - the absolute directory path.
 * @throws {HomeLayoutError} `HOME_MODE`, naming the path and the `chmod 700` fix where one applies.
 * @throws the filesystem error, such as `ENOENT`, when the path cannot be examined.
 */
export function checkPrivateDirectorySync(path: string): void {
  if (process.platform === 'win32') return
  const problem = directoryRefusal(path, lstatSync(path))
  if (problem !== undefined) throw problem
}

/**
 * Create the home and each of Delorun's top-level entries and the profile's run
 * directory at mode 0700, then check the home, `secrets/` and `run/<profile>/`.
 * Upstream's entries are left to upstream.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile whose `run/<profile>/` directory is created.
 * @throws {HomeLayoutError} `HOME_MODE` when one of the three checked directories is laxer than 0700, a symbolic link or another user's.
 */
export async function ensureHomeTree(home: string, profile: string): Promise<void> {
  // The parents of a custom home are created at 0700 too; the home's own mode is checked below.
  await mkdir(home, { recursive: true, mode: PRIVATE_DIR_MODE })
  await checkPrivateDirectory(home)
  for (const entry of Object.values(DELORUN_HOME_ENTRIES)) await makePrivateDirectory(join(home, entry))
  await makePrivateDirectory(runDirectory(home, profile))
  await checkPrivateDirectory(join(home, DELORUN_HOME_ENTRIES.secrets))
  await checkPrivateDirectory(runDirectory(home, profile))
}
