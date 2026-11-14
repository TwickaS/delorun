/**
 * The root files a launcher embeds, and nothing else: the launcher trusts a newer root only by walking from the newest
 * root it ships (contract C2, "Root metadata"). A launcher whose package carries no root refuses every install with
 * `NO_TRUSTED_ROOT` rather than trust what the network offers, and a set that skips a version refuses too, because
 * each rotation must be verified by the version before it. `@delorun/install`'s `readShippedRoots` holds the rule, which
 * the runtime this launcher starts applies to the same directory through `DELORUN_LAUNCHER_ROOTS`.
 *
 * @module @delorun/npm-launcher/root
 */
import { join } from 'node:path'
import { readShippedRoots } from '@delorun/install'

/** The directory of a launcher package that holds its roots, relative to the package. */
export const ROOTS_DIRECTORY = 'roots'

/**
 * Read the root files a launcher ships, oldest first.
 * @param packageDirectory - the launcher package's directory.
 * @returns the root files, oldest first; never empty.
 * @throws {InstallError} `NO_TRUSTED_ROOT` when `roots/` holds none; `INSTALL_VERIFY_FAILED` when the versions are not
 *   contiguous from the first, a file's own root signature does not verify, or a root is not signed by the root before
 *   it (contract C2, "Key rotation").
 */
export async function readEmbeddedRoots(packageDirectory: string): Promise<readonly Uint8Array[]> {
  return readShippedRoots(join(packageDirectory, ROOTS_DIRECTORY))
}
