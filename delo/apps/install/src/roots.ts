/**
 * The release roots a launcher ships, and the stored root anchored on them (contract C2, "Root metadata"). A launcher
 * package carries its roots in `roots/<n>.root.json`, and the runtime it starts finds the same directory through
 * `DELO_LAUNCHER_ROOTS` (contract C1). Both read the directory with {@link readShippedRoots}: a directory with no root
 * refuses with `NO_TRUSTED_ROOT` rather than trust what the network offers, and a set that skips a version or does not
 * walk as a chain refuses too, because each rotation must be verified by the version before it.
 * {@link readAnchoredRoot} trusts the home's `trust/root.json` only through those roots.
 *
 * @module @delo/install/roots
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_FILE_NAME_PATTERN, TRUST_FILES } from '@delo/contract-home-layout'
import { walkRootChain, type TrustedRoot } from '@delo/release-formats/sign/verify'
import { InstallError, messageOf } from './errors.ts'
import { readStoredRootBytes, readStoredRootChain, trustFile } from './state.ts'
import { newestRootVersion, verifyStoredRoot } from './verify.ts'

/** A shipped root file's name: `<n>.root.json`, the name a stored root of the walked chain repeats. */
const ROOT_FILE = new RegExp(ROOT_FILE_NAME_PATTERN, 'u')

/**
 * Read the root files a launcher ships, oldest first.
 * @param directory - the directory that holds them, a launcher package's `roots/`.
 * @returns the root files, oldest first; never empty.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when the directory is missing, unreadable or holds no root file;
 *   `INSTALL_VERIFY_FAILED` when the versions are not contiguous from the first, a file's own root signature does not
 *   verify, a root is not signed by the root before it (contract C2, "Key rotation"), or the newest file's name gives
 *   another version than the root it holds.
 */
export async function readShippedRoots(directory: string): Promise<readonly Uint8Array[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} holds no release root, so no release can be verified with it; install Delo from its release page instead`, { cause: error })
    }
    throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} cannot be read: ${messageOf(error)}`, { cause: error })
  }
  const versions = names
    .map(name => ROOT_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ version: Number(match[1]), name: match[0] }))
    .sort((left, right) => left.version - right.version)
  if (versions.length === 0) {
    throw new InstallError('NO_TRUSTED_ROOT', directory, `${directory} holds no <n>.root.json file, so no release can be verified with it; install Delo from its release page instead`)
  }
  const roots: Uint8Array[] = []
  for (const [position, entry] of versions.entries()) {
    const first = versions[0]!.version
    if (entry.version !== first + position) {
      throw new InstallError('INSTALL_VERIFY_FAILED', join(directory, entry.name), `${directory} holds root ${String(entry.version)} without root ${String(first + position)}, so no rotation can be verified`)
    }
    roots.push(await readFile(join(directory, entry.name)))
  }
  try {
    walkRootChain(roots)
  } catch (error) {
    throw new InstallError('INSTALL_VERIFY_FAILED', directory, `the roots in ${directory} are not a chain: ${messageOf(error)}`, { cause: error })
  }
  const newest = newestRootVersion(roots)
  if (newest !== versions.at(-1)!.version) {
    throw new InstallError('INSTALL_VERIFY_FAILED', join(directory, versions.at(-1)!.name), `the newest root file names version ${String(newest)} and not ${String(versions.at(-1)!.version)}`)
  }
  return roots
}

/**
 * Read the home's trusted root, `trust/root.json`, and trust it through the roots a launcher ships, by the chain an
 * install walked to it (`trust/roots/`): {@link verifyStoredRoot}'s rule, so a root a same-user process, a restore or a
 * sync placed under `trust/` is not an anchor.
 * @param home - the resolved Delo home.
 * @param shipped - the root files the launcher ships, oldest first, as {@link readShippedRoots} returns them.
 * @returns the root to anchor on, by {@link verifyStoredRoot}'s rule: the newest shipped root when the stored root is
 *   an older shipped one.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when no root is stored or none is shipped; `TRUST_STATE_INVALID` when the
 *   stored root or the walked chain is a link, another user's, laxer than 0600 or unreadable; `INSTALL_VERIFY_FAILED`
 *   when no shipped root leads to the stored one.
 */
export async function readAnchoredRoot(home: string, shipped: readonly Uint8Array[]): Promise<TrustedRoot> {
  const path = trustFile(home, TRUST_FILES.root)
  const stored = await readStoredRootBytes(home)
  if (stored === undefined) throw new InstallError('NO_TRUSTED_ROOT', path, `no trusted release root is stored at ${path}; an install through Delo's launcher stores one`)
  return verifyStoredRoot({ stored, shipped, walked: await readStoredRootChain(home), source: path })
}
