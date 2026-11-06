/**
 * Resolve the Delo home (contract C1, "The home directory"): `DELO_HOME` when
 * it is set and not blank, otherwise `~/.delo`, with the refusals of a home
 * that is relative, the filesystem root, the OS home directory, or upstream's
 * `~/.dsh` or a path inside it.
 *
 * @module @delo/cli/home/resolve
 */
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { canonicalizeWatchPath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { DELO_HOME_DIR_NAME, DELO_HOME_ENV, DSH_HOME_ENV, UPSTREAM_HOME_DIR_NAME } from '@delo/contract-home-layout'
import { HomeLayoutError } from './errors.ts'

/** The resolved Delo home. */
export interface DeloHome {
  /** Absolute, normalised path of the home; every runtime process gets it as `DSH_HOME`. */
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
 * Resolve the Delo home from the environment and refuse the homes C1 forbids.
 * @param env - the inherited environment, read for `DELO_HOME` and `DSH_HOME`.
 * @returns the home and the ignored `DSH_HOME`, if any.
 * @throws {HomeLayoutError} `HOME_INVALID` for a relative home, the filesystem root or the OS home directory;
 *   `HOME_IS_DSH_HOME` for upstream's `~/.dsh` or a path inside it. Symbolic links are resolved before comparing.
 */
export async function resolveDeloHome(env: Readonly<Record<string, string | undefined>>): Promise<DeloHome> {
  const osHome = homedir()
  const configured = env[DELO_HOME_ENV]
  const selected = configured !== undefined && configured.trim().length > 0 ? configured : join(osHome, DELO_HOME_DIR_NAME)
  const expanded = expandHomePath(selected)
  if (!isAbsolute(expanded)) {
    throw new HomeLayoutError('HOME_INVALID', expanded, `${DELO_HOME_ENV} must be an absolute path or start with ~, got ${JSON.stringify(selected)}`)
  }
  const path = resolve(expanded)
  const canonical = comparable(await canonicalizeWatchPath(path))
  if (canonical === comparable(parse(canonical).root) || canonical === comparable(await canonicalizeWatchPath(osHome))) {
    throw new HomeLayoutError('HOME_INVALID', path, `the Delo home cannot be the filesystem root or your home directory itself; set ${DELO_HOME_ENV} to a directory of its own, such as ~/${DELO_HOME_DIR_NAME}`)
  }
  const dshHome = comparable(await canonicalizeWatchPath(join(osHome, UPSTREAM_HOME_DIR_NAME)))
  if (canonical === dshHome || canonical.startsWith(dshHome + sep)) {
    throw new HomeLayoutError('HOME_IS_DSH_HOME', path, `the Delo home cannot be DeepSeek Harness's own home ~/${UPSTREAM_HOME_DIR_NAME} or lie inside it; set ${DELO_HOME_ENV} to another directory, such as ~/${DELO_HOME_DIR_NAME}`)
  }
  const inherited = env[DSH_HOME_ENV]
  const inheritedPath = inherited !== undefined && inherited.trim().length > 0 ? resolve(expandHomePath(inherited)) : undefined
  return inheritedPath === undefined || inheritedPath === path ? { path } : { path, ignoredDshHome: inheritedPath }
}
