/**
 * File operations of installs and removals: an installation's read-only modes (contract C1, "Installed files"), the
 * release files written beside it, new staging directories, and removing a tree whose modes forbid writes.
 *
 * @module @delorun/runtime-store/files
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, STAGING_NAME_HEX_DIGITS } from '@delorun/contract-home-layout'
import type { RuntimeFileList } from '@delorun/contract-release-manifest'

/** Mode of an installed directory, and of an installed executable file. */
const READ_EXECUTE = 0o555

/** Mode of an installed file that is not executable. */
const READ_ONLY = 0o444

/** Mode of the release files beside an installation and of `store.json`. */
export const STORE_FILE_MODE = 0o444

/**
 * Create a new staging directory `staging/<16 hex>` at mode 0700.
 * @param staging - the `staging/` directory, which is created at mode 0700 when absent.
 * @returns the new directory.
 */
export async function createStagingDirectory(staging: string): Promise<string> {
  await mkdir(staging, { recursive: true, mode: PRIVATE_DIR_MODE })
  const directory = join(staging, randomBytes(STAGING_NAME_HEX_DIGITS / 2).toString('hex'))
  await mkdir(directory, { mode: PRIVATE_DIR_MODE })
  return directory
}

/**
 * C1's installed mode of a listed file: 0555 for a file the list marks `0755`, otherwise 0444. An extraction may
 * create each file at this mode, so sealing the tree leaves the file's change time, and the identity it reported, as
 * they were.
 * @param mode - the list's mode.
 * @returns the installed mode.
 */
export function installedFileMode(mode: RuntimeFileList['files'][number]['mode']): number {
  return mode === '0755' ? READ_EXECUTE : READ_ONLY
}

/**
 * Give a verified tree C1's installed modes: files 0444, or 0555 when the list marks them `0755`, and every
 * directory below the root 0555. A file that already has its mode is left alone, so its change time stays; an entry
 * that is not a regular file is left for the file check to refuse. The root keeps its mode, so the tree can still be
 * renamed; the caller sets it after.
 * @param root - the tree.
 * @param list - its file list.
 */
export async function setInstalledModes(root: string, list: Pick<RuntimeFileList, 'files'>): Promise<void> {
  for (const file of list.files) {
    const path = join(root, ...file.path.split('/'))
    const stats = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    const mode = installedFileMode(file.mode)
    if (stats?.isFile() === true && (stats.mode & 0o7777) !== mode) await chmod(path, mode)
  }
  const directories: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      await walk(path)
      directories.push(path)
    }
  }
  await walk(root)
  for (const directory of directories) await chmod(directory, READ_EXECUTE)
}

/**
 * Set an installation's root directory to C1's installed mode.
 * @param root - the installation.
 */
export async function sealInstallation(root: string): Promise<void> {
  await chmod(root, READ_EXECUTE)
}

/**
 * Write a file of the store other than a pointer (a release file beside an installation, `store.json` or an
 * installation's identity record): a temporary sibling `<name>.tmp-<16 hex>` created exclusively at its mode, flushed
 * and renamed over the path. The caller flushes the directory.
 * @param path - the file.
 * @param bytes - its contents.
 * @param mode - its mode: {@link STORE_FILE_MODE} for a release file or `store.json`, 0600 for an identity record.
 */
export async function writeStoreFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), mode)
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch((_cleanupError: unknown) => {
      // Gone already, or left for retention, which removes `*.tmp-<16 hex>` under store.lock.
    })
    throw error
  }
}

/**
 * Remove a tree, first giving each directory and file the owner's write permission that C1's installed modes take
 * away. A path that does not exist is not an error.
 * @param path - the tree's root.
 */
export async function removeTree(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stats.isDirectory()) {
    const walk = async (directory: string): Promise<void> => {
      await chmod(directory, PRIVATE_DIR_MODE)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name)
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile() && process.platform === 'win32') await chmod(child, 0o600)
      }
    }
    await walk(path)
  }
  await rm(path, { recursive: true, force: true })
}

/**
 * Move an installation out of `runtimes/` into a new staging directory, so it stops counting as installed at once,
 * and remove it there.
 * @param installation - `runtimes/<version>`.
 * @param staging - the `staging/` directory.
 * @returns the path it was moved to, removed when this returns; a failed removal leaves it for the next retention.
 */
export async function moveOutAndRemove(installation: string, staging: string): Promise<string> {
  const trash = await createStagingDirectory(staging)
  const target = join(trash, 'removed')
  await chmod(installation, PRIVATE_DIR_MODE)
  await rename(installation, target)
  await removeTree(trash)
  return trash
}
