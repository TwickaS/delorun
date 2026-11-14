/**
 * Resolve the Delorun home (contract C1, "The home directory"): `DELORUN_HOME` when
 * it is set and not blank, otherwise `~/.delorun`, with the refusals of a home
 * that is relative, the filesystem root, the OS home directory, or upstream's
 * `~/.dsh` or a path inside it. The resolved path has its ancestors'
 * symbolic links resolved, so it names the home as the files under it name
 * themselves; a home that is itself a link stays a link, which C1's mode
 * checks refuse.
 *
 * @module @delorun/home/resolve
 */
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { canonicalizeWatchPath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { DELORUN_HOME_DIR_NAME, DELORUN_HOME_ENV, DSH_HOME_ENV, UPSTREAM_HOME_DIR_NAME } from '@delorun/contract-home-layout'
import { HomeLayoutError } from './errors.ts'

/** The resolved Delorun home. */
export interface DelorunHome {
  /**
   * Absolute path of the home whose parent directory has every symbolic link in its existing part resolved, a part
   * that does not exist yet appended as given, and the home's own name kept; every runtime process gets it as
   * `DSH_HOME`.
   */
  readonly path: string
  /** The inherited `DSH_HOME`, resolved, when it was set, not blank and named another directory; `delorun` ignores it. */
  readonly ignoredDshHome?: string
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
 * Resolve the Delorun home from the environment and refuse the homes C1 forbids.
 * @param env - the inherited environment, read for `DELORUN_HOME` and `DSH_HOME`.
 * @returns the home, its ancestors' symbolic links resolved, and the ignored `DSH_HOME`, if any: one that names the
 *   home in either spelling is not reported.
 * @throws {HomeLayoutError} `HOME_INVALID` for a relative home, the filesystem root or the OS home directory;
 *   `HOME_IS_DSH_HOME` for upstream's `~/.dsh` or a path inside it. Every symbolic link, the home's own included,
 *   is resolved before comparing, and a refusal names the home as it was given.
 * @throws the filesystem's error when an existing part of the path cannot be resolved, such as a file where a
 *   directory belongs.
 */
export async function resolveDelorunHome(env: Readonly<Record<string, string | undefined>>): Promise<DelorunHome> {
  const osHome = homedir()
  const configured = env[DELORUN_HOME_ENV]
  const selected = configured !== undefined && configured.trim().length > 0 ? configured : join(osHome, DELORUN_HOME_DIR_NAME)
  const expanded = expandHomePath(selected)
  if (!isAbsolute(expanded)) {
    throw new HomeLayoutError('HOME_INVALID', expanded, `${DELORUN_HOME_ENV} must be an absolute path or start with ~, got ${JSON.stringify(selected)}`)
  }
  const spelled = resolve(expanded)
  const path = join(await canonicalizeWatchPath(dirname(spelled)), basename(spelled))
  const canonical = comparable(await canonicalizeWatchPath(spelled))
  if (canonical === comparable(parse(canonical).root) || canonical === comparable(await canonicalizeWatchPath(osHome))) {
    throw new HomeLayoutError('HOME_INVALID', spelled, `the Delorun home cannot be the filesystem root or your home directory itself; set ${DELORUN_HOME_ENV} to a directory of its own, such as ~/${DELORUN_HOME_DIR_NAME}`)
  }
  const dshHome = comparable(await canonicalizeWatchPath(join(osHome, UPSTREAM_HOME_DIR_NAME)))
  if (canonical === dshHome || canonical.startsWith(dshHome + sep)) {
    throw new HomeLayoutError('HOME_IS_DSH_HOME', spelled, `the Delorun home cannot be DeepSeek Harness's own home ~/${UPSTREAM_HOME_DIR_NAME} or lie inside it; set ${DELORUN_HOME_ENV} to another directory, such as ~/${DELORUN_HOME_DIR_NAME}`)
  }
  const inherited = env[DSH_HOME_ENV]
  const inheritedPath = inherited !== undefined && inherited.trim().length > 0 ? resolve(expandHomePath(inherited)) : undefined
  return inheritedPath === undefined || inheritedPath === path || inheritedPath === spelled ? { path } : { path, ignoredDshHome: inheritedPath }
}
