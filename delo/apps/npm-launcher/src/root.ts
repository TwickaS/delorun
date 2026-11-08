/**
 * The root files a launcher embeds, and nothing else: the launcher trusts a newer root only by walking from the newest
 * root it ships (contract C2, "Root metadata"). A launcher whose package carries no root refuses every install with
 * `NO_TRUSTED_ROOT` rather than trust what the network offers, and a set that skips a version refuses too, because
 * each rotation must be verified by the version before it.
 *
 * @module @delo/npm-launcher/root
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallError, messageOf, newestRootVersion } from '@delo/install'

/** The directory of a launcher package that holds its roots, relative to the package. */
export const ROOTS_DIRECTORY = 'roots'

/** A shipped root file's name: `<n>.root.json`. */
const ROOT_FILE = /^([1-9][0-9]*)\.root\.json$/u

/**
 * Read the root files a launcher ships, oldest first.
 * @param packageDirectory - the launcher package's directory.
 * @returns the root files, oldest first; never empty.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when the directory holds none; `INSTALL_VERIFY_FAILED` when the versions
 *   are not contiguous from the first, or when a file's own root signature does not verify.
 */
export async function readEmbeddedRoots(packageDirectory: string): Promise<readonly Uint8Array[]> {
  const directory = join(packageDirectory, ROOTS_DIRECTORY)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} holds no release root, so this launcher can verify no release; install Delo from its release page instead`, { cause: error })
    }
    throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} cannot be read: ${messageOf(error)}`, { cause: error })
  }
  const versions = names
    .map(name => ROOT_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ version: Number(match[1]), name: match[0] }))
    .sort((left, right) => left.version - right.version)
  if (versions.length === 0) {
    throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} holds no <n>.root.json file, so this launcher can verify no release; install Delo from its release page instead`)
  }
  const roots: Uint8Array[] = []
  for (const [position, entry] of versions.entries()) {
    const first = versions[0]!.version
    if (entry.version !== first + position) {
      throw new InstallError('INSTALL_VERIFY_FAILED', join(directory, entry.name), `the launcher ships root ${String(entry.version)} without root ${String(first + position)}, so no rotation can be verified`)
    }
    roots.push(await readFile(join(directory, entry.name)))
  }
  const newest = newestRootVersion(roots)
  if (newest !== versions.at(-1)!.version) {
    throw new InstallError('INSTALL_VERIFY_FAILED', join(directory, versions.at(-1)!.name), `the newest root file names version ${String(newest)} and not ${String(versions.at(-1)!.version)}`)
  }
  return roots
}
