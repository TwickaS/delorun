/**
 * Contract C1's pointer files, `current` and `previous`: each holds exactly one version and one newline, at most 65
 * bytes. A pointer is replaced by writing a sibling `<pointer>.tmp-<16 hex>` through exclusive creation at mode 0600,
 * flushing it, renaming it over the pointer and, on Linux and macOS, flushing `runtimes/`; it is never a symbolic
 * link. Two pointers are written `previous` first and `current` second, so a process killed between the writes
 * leaves `current` naming the version it named before.
 *
 * @module @delorun/runtime-store/pointer
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  POINTER_FILE_MAX_BYTES,
  POINTER_RENAME_RETRY_MS,
  PROTECTED_FILE_MODE,
  STORE_ENTRIES,
  type RuntimeVersion,
} from '@delorun/contract-home-layout'
import { RuntimeStoreError } from './errors.ts'
import { parseRuntimeVersion, type PointerName, type StorePaths } from './paths.ts'

const POSIX = process.platform !== 'win32'

/** The rename errors Windows reports while another process holds the file, which C1 retries. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** C1's two pointers. */
export interface RuntimePointers {
  /** The version `current` names. */
  readonly current: RuntimeVersion
  /** The version `previous` names, when the file exists. */
  readonly previous?: RuntimeVersion
}

/**
 * The durable steps of one pointer write, in order. `create` precedes the exclusive creation of the temporary file,
 * `write` the write of its bytes, `sync` its flush, `rename` the rename over the pointer (or, for a removal, the
 * unlink) and `sync-directory` the flush of `runtimes/`.
 */
export type PointerStepKind = 'create' | 'write' | 'sync' | 'rename' | 'sync-directory'

/** One durable step of a pointer write: which pointer, and which step is about to run. */
export interface PointerStep {
  /** The pointer being written. */
  readonly pointer: PointerName
  /** The step about to run. */
  readonly step: PointerStepKind
}

/**
 * Called before each durable step of a pointer write; the crash specs end the process there.
 * @param step - the step about to run.
 */
export type PointerStepObserver = (step: PointerStep) => void

/**
 * Read a pointer file whole.
 * @param path - the pointer's path.
 * @returns the version it names, `undefined` when the file is absent, or `malformed` when it is not exactly one
 *   version and one newline within 65 bytes, or not a regular file.
 */
export async function readPointerFile(path: string): Promise<RuntimeVersion | 'malformed' | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    // ELOOP: a symbolic link, which a pointer never is.
    if (code === 'ELOOP') return 'malformed'
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > POINTER_FILE_MAX_BYTES) return 'malformed'
    const bytes = await handle.readFile()
    if (bytes.byteLength > POINTER_FILE_MAX_BYTES) return 'malformed'
    const text = bytes.toString('utf8')
    if (!text.endsWith('\n')) return 'malformed'
    return parseRuntimeVersion(text.slice(0, -1)) ?? 'malformed'
  } finally {
    await handle.close()
  }
}

/**
 * Whether an installed directory exists for a version: `runtimes/<version>` is a directory, not a symbolic link.
 * @param paths - the store's paths.
 * @param version - the version.
 * @returns true when it is installed.
 */
export async function isInstalled(paths: StorePaths, version: RuntimeVersion): Promise<boolean> {
  try {
    return (await lstat(paths.version(version))).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Read `current` and `previous`. `current` must name an installed version; a `previous` that is absent, malformed or
 * names a version that is not installed reads as absent, because nothing runs from it without a switch.
 * @param paths - the store's paths.
 * @returns the pointers.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `current` is missing, empty, oversized, malformed or names a
 *   version with no installed directory.
 */
export async function readPointers(paths: StorePaths): Promise<RuntimePointers> {
  const path = paths.pointer(STORE_ENTRIES.current)
  const current = await readPointerFile(path)
  if (current === undefined) throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', path, `${path} does not exist, so no runtime is active`, ['reinstall'])
  if (current === 'malformed') throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', path, `${path} is not one runtime version and a newline`, ['reinstall', 'rollback'])
  if (!await isInstalled(paths, current)) throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', path, `${path} names ${current}, which is not installed in ${paths.root}`, ['reinstall', 'rollback'])
  const previous = await readPointerFile(paths.pointer(STORE_ENTRIES.previous))
  if (previous === undefined || previous === 'malformed' || !await isInstalled(paths, previous)) return { current }
  return { current, previous }
}

/**
 * Flush a directory's entries to disk; Linux and macOS only, because Windows cannot open a directory for flushing.
 * @param path - the directory.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (!POSIX) return
  const directory = await open(path, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/**
 * Rename, retrying for at most C1's 2,000 ms while Windows reports the target busy.
 * @param from - the source.
 * @param to - the target.
 * @param platform - the operating system, whose rename errors decide whether to retry.
 * @param renameFile - the rename to run.
 * @throws the rename's last error once the retries are spent, or at once for an error that is not retried.
 */
export async function renameWithRetry(from: string, to: string, platform: NodeJS.Platform, renameFile: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  const deadline = Date.now() + POINTER_RENAME_RETRY_MS
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    try {
      await renameFile(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      const wait = Math.min(delay, deadline - Date.now())
      if (platform !== 'win32' || !TRANSIENT_RENAME.has(code) || wait <= 0) throw error
      await sleep(wait)
    }
  }
}

/**
 * Replace one pointer, or remove it when `version` is `undefined`.
 * @param paths - the store's paths.
 * @param name - the pointer.
 * @param version - the version it will name.
 * @param observe - called before each durable step.
 * @throws {RuntimeStoreError} `POINTER_REPLACE_FAILED` when the rename or removal fails; the old pointer is unchanged.
 */
async function replacePointer(paths: StorePaths, name: PointerName, version: RuntimeVersion | undefined, observe: PointerStepObserver): Promise<void> {
  const path = paths.pointer(name)
  if (version === undefined) {
    observe({ pointer: name, step: 'rename' })
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RuntimeStoreError('POINTER_REPLACE_FAILED', path, `could not remove ${path}: ${(error as Error).message}`, [], { cause: error })
    }
  } else {
    const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
    observe({ pointer: name, step: 'create' })
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (POSIX ? constants.O_NOFOLLOW : 0), PROTECTED_FILE_MODE)
    try {
      try {
        observe({ pointer: name, step: 'write' })
        await handle.writeFile(`${version}\n`)
        observe({ pointer: name, step: 'sync' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      observe({ pointer: name, step: 'rename' })
      await renameWithRetry(temporary, path, process.platform)
    } catch (error) {
      await unlink(temporary).catch((_cleanupError: unknown) => {
        // The temporary file is gone already, or stays until retention removes `<pointer>.tmp-*` under store.lock.
      })
      throw new RuntimeStoreError('POINTER_REPLACE_FAILED', path, `could not replace ${path}; it still names its previous version: ${(error as Error).message}`, [], { cause: error })
    }
  }
  observe({ pointer: name, step: 'sync-directory' })
  await syncDirectory(paths.root)
}

/**
 * Write both pointers: `previous` first (replaced, or removed when absent from `pointers`), then `current`. The
 * caller holds `store.lock` and has checked that each named version is installed.
 * @param paths - the store's paths.
 * @param pointers - the values to write.
 * @param observe - called before each durable step; the crash specs end the process there.
 * @throws {RuntimeStoreError} `POINTER_REPLACE_FAILED` when a write fails; the pointers written before it stay.
 */
export async function writePointers(paths: StorePaths, pointers: RuntimePointers, observe: PointerStepObserver = () => {}): Promise<void> {
  await replacePointer(paths, STORE_ENTRIES.previous, pointers.previous, observe)
  await replacePointer(paths, STORE_ENTRIES.current, pointers.current, observe)
}
