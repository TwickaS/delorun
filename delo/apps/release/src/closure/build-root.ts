/**
 * The directory `build-closure` exports a commit's tree to and stages each platform in. A reproducible build uses the
 * fixed root `closure.json` names, because bundlers embed absolute paths and every builder must embed the same ones;
 * one build at a time holds it through a lock file beside it, `<root>.lock`, which records the holder's process id and
 * is created exclusively, so a second build on the computer refuses instead of removing the first one's tree. A build
 * from existing artifacts already embeds the worktree's paths and is local only, so it takes a fresh directory
 * `<root>-<suffix>` of its own and any number run side by side. A claimed root is released, its lock or its own
 * directory removed, when the build ends; a build killed by a signal leaves the lock, and the next build's refusal
 * names the process and whether it still runs.
 *
 * @module @delo/release/closure/build-root
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The marker that identifies a build root `build-closure` created, so it never removes another directory. */
export const BUILD_ROOT_MARKER = '.delo-release-build-root'

/** How a build claims its root: the shared fixed root under a lock, or a fresh directory of its own. */
export type BuildRootKind = 'fixed' | 'unique'

/** A build root this process holds. */
export interface ClaimedBuildRoot {
  /** The directory, empty but for {@link BUILD_ROOT_MARKER}. */
  readonly path: string
  /** Gives the root up: removes the lock of a fixed root, or the whole directory of a unique one. */
  readonly release: () => Promise<void>
}

/** The fixed root is held by another build, or by a build that ended without giving it up. */
export class BuildRootBusyError extends Error {
  /** The lock file. */
  readonly lock: string
  /** The process id the lock records, or `undefined` when the file names none. */
  readonly holder: number | undefined
  /** Whether that process still runs. */
  readonly running: boolean

  /**
   * @param lock - the lock file.
   * @param holder - the process id the lock records, or `undefined` when the file names none.
   * @param running - whether that process still runs.
   */
  constructor(lock: string, holder: number | undefined, running: boolean) {
    super(running
      ? `the build root is in use by build-closure process ${String(holder)} (${lock}); wait for it to finish`
      : `${lock} names ${holder === undefined ? 'no process' : `process ${String(holder)}, which has ended`}; if no build-closure runs on this computer, remove the lock and run again`)
    this.name = 'BuildRootBusyError'
    this.lock = lock
    this.holder = holder
    this.running = running
  }
}

/**
 * Whether a process runs.
 * @param pid - its id.
 * @returns true when it exists, even when this user may not signal it.
 */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Empty a root this command created, or create it.
 * @param root - the directory.
 * @throws Error when the directory exists without {@link BUILD_ROOT_MARKER}.
 */
async function freshRoot(root: string): Promise<void> {
  if (existsSync(root)) {
    if (!existsSync(join(root, BUILD_ROOT_MARKER))) throw new Error(`${root} exists and was not created by build-closure; remove it by hand`)
    await rm(root, { recursive: true, force: true })
  }
  await mkdir(root, { recursive: true, mode: 0o755 })
  await writeFile(join(root, BUILD_ROOT_MARKER), '')
}

/**
 * Claim a build root for one build.
 * @param root - the fixed root `closure.json` names.
 * @param kind - `fixed` for a reproducible build, `unique` for a build from existing artifacts.
 * @returns the claimed directory and the function that gives it up.
 * @throws BuildRootBusyError when another build holds the fixed root, or its lock outlived its build.
 * @throws Error when the fixed root exists without {@link BUILD_ROOT_MARKER}.
 */
export async function claimBuildRoot(root: string, kind: BuildRootKind): Promise<ClaimedBuildRoot> {
  await mkdir(dirname(root), { recursive: true })
  if (kind === 'unique') {
    const path = await mkdtemp(`${root}-`)
    await writeFile(join(path, BUILD_ROOT_MARKER), '')
    return { path, release: () => rm(path, { recursive: true, force: true }) }
  }
  const lock = `${root}.lock`
  try {
    await writeFile(lock, `${String(process.pid)}\n`, { flag: 'wx', mode: 0o644 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const recorded = Number.parseInt(await readFile(lock, 'utf8'), 10)
    const holder = Number.isSafeInteger(recorded) && recorded > 0 ? recorded : undefined
    throw new BuildRootBusyError(lock, holder, holder !== undefined && processRuns(holder))
  }
  try {
    await freshRoot(root)
  } catch (error) {
    await rm(lock, { force: true })
    throw error
  }
  return { path: root, release: () => rm(lock, { force: true }) }
}
