/**
 * The folders Delorun never registers as a workspace: the filesystem root, the person's home directory itself, the Delorun
 * home, upstream's stock home, a folder inside either home and a folder that contains either home. The sandbox refuses
 * a writable root that equals, lies inside or contains its protected home (`HOME_IN_WRITABLE_ROOT`), and the home
 * directory and the filesystem root expose everything the person has, so every Delorun path that adds a workspace asks
 * this module first.
 *
 * @module @delorun/home/workspace-location
 */
import { homedir } from 'node:os'
import { isAbsolute, join, parse, sep } from 'node:path'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { UPSTREAM_HOME_DIR_NAME } from '@delorun/contract-home-layout'

/**
 * Why a folder cannot be a workspace.
 *
 * - `filesystem-root`: the folder is a filesystem root, such as `/` or `C:\`.
 * - `home-directory`: the folder is the person's home directory itself.
 * - `delorun-home`: the folder is the Delorun home or lies inside it.
 * - `contains-delorun-home`: the folder contains the Delorun home.
 * - `stock-home`: the folder is upstream's stock home (`~/.dsh`) or lies inside it.
 * - `contains-stock-home`: the folder contains the stock home.
 * - `not-absolute`: the path is not absolute, so it names no folder by itself.
 */
export type WorkspaceLocationProblem =
  | 'filesystem-root'
  | 'home-directory'
  | 'delorun-home'
  | 'contains-delorun-home'
  | 'stock-home'
  | 'contains-stock-home'
  | 'not-absolute'

/** The homes a workspace location is held against. */
export interface WorkspaceLocationHomes {
  /** The person's home directory. */
  readonly osHome: string
  /** The Delorun home, as `resolveDelorunHome` returns it. */
  readonly delorunHome: string
  /** Upstream's stock home, `~/.dsh`. */
  readonly stockHome: string
}

/**
 * The homes of this process: the OS home directory, the given Delorun home and `~/.dsh`.
 * @param delorunHome - the resolved Delorun home.
 * @returns the homes a location is held against.
 */
export function workspaceLocationHomes(delorunHome: string): WorkspaceLocationHomes {
  const osHome = homedir()
  return { osHome, delorunHome, stockHome: join(osHome, UPSTREAM_HOME_DIR_NAME) }
}

/**
 * Compare two canonical paths as the platform's default filesystem does: without case on Windows and macOS.
 * @param path - a canonical path.
 * @returns the comparison key.
 */
function comparable(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/**
 * Whether one comparable path equals another or lies inside it.
 * @param path - the candidate.
 * @param base - the directory; never a filesystem root, which the caller refuses first.
 * @returns true when `path` is `base` or below it.
 */
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base + sep)
}

/**
 * Hold a folder against the locations Delorun never registers as a workspace. Symbolic links are resolved first, and a
 * missing tail is kept as written, so a folder not created yet is checked where it would be created.
 * @param path - the candidate folder.
 * @param homes - the homes to hold it against.
 * @returns the first problem, or `undefined` when the folder may be a workspace.
 */
export async function workspaceLocationProblem(path: string, homes: WorkspaceLocationHomes): Promise<WorkspaceLocationProblem | undefined> {
  if (!isAbsolute(path)) return 'not-absolute'
  const [candidate, osHome, delorunHome, stockHome] = await Promise.all(
    [path, homes.osHome, homes.delorunHome, homes.stockHome].map(async each => comparable(await canonicalizeWatchPath(each))),
  ) as [string, string, string, string]
  if (candidate === comparable(parse(candidate).root)) return 'filesystem-root'
  if (candidate === osHome) return 'home-directory'
  if (within(candidate, delorunHome)) return 'delorun-home'
  if (within(delorunHome, candidate)) return 'contains-delorun-home'
  if (within(candidate, stockHome)) return 'stock-home'
  if (within(stockHome, candidate)) return 'contains-stock-home'
  return undefined
}

/**
 * The English sentence that names a problem and what to do instead, for terminal and log output. The studio shows its
 * own locale-owned copy for the same codes.
 * @param problem - the problem.
 * @returns one sentence.
 */
export function workspaceLocationMessage(problem: WorkspaceLocationProblem): string {
  switch (problem) {
    case 'filesystem-root':
      return 'A filesystem root cannot be a workspace, because it holds everything on the computer; choose or create a folder of its own.'
    case 'home-directory':
      return 'Your home folder itself cannot be a workspace, because it holds everything you have and Delorun\'s own home; create or choose a folder inside it.'
    case 'delorun-home':
      return 'Delorun\'s own home, and any folder inside it, cannot be a workspace; choose or create a folder elsewhere.'
    case 'contains-delorun-home':
      return 'This folder contains Delorun\'s own home, so it cannot be a workspace; create or choose a folder inside it that does not.'
    case 'stock-home':
      return 'DeepSeek Harness\'s own home, and any folder inside it, cannot be a workspace; choose or create a folder elsewhere.'
    case 'contains-stock-home':
      return 'This folder contains DeepSeek Harness\'s own home, so it cannot be a workspace; create or choose a folder inside it that does not.'
    case 'not-absolute':
      return 'A workspace needs a full path, starting at the filesystem root.'
    /* v8 ignore next 2 -- closed-union default only defends a future widening of WorkspaceLocationProblem */
    default:
      return assertNever(problem)
  }
}

/* v8 ignore next 3 -- reached only when WorkspaceLocationProblem widens without this switch */
function assertNever(value: never): never {
  throw new Error(`unhandled workspace location problem ${String(value)}`)
}
