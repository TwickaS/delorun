/**
 * A runtime the store's start check verified, as `@delo/changes` reads a signed installation: its directory and each
 * file of its verified signed file list with the length, digest and execute bit the list gives it. `delorun changes`,
 * `verify`, the start's hand-off and the update's harness carry read the installation through it.
 *
 * @module @delo/cli/update/signed-runtime
 */
import type { SignedFile, SignedRuntime } from '@delo/changes'
import type { RuntimeFile } from '@delo/contract-release-manifest'
import type { VerifiedRuntime } from '@delo/runtime-store'

/**
 * @param file - a file of a verified signed file list.
 * @returns it as Changes reads a signed file.
 */
function signedFileOf(file: RuntimeFile): SignedFile {
  return { path: file.path, length: file.length, sha256: file.sha256, executable: file.mode === '0755' }
}

/**
 * A runtime the store's start check verified, as Changes reads a signed installation.
 * @param directory - the installation, `runtimes/<version>/`.
 * @param verified - the runtime with its verified file list.
 * @returns the installation and its signed files.
 */
export function signedRuntimeOf(directory: string, verified: Pick<VerifiedRuntime, 'files'>): SignedRuntime {
  return { directory, files: verified.files.files.map(signedFileOf) }
}
