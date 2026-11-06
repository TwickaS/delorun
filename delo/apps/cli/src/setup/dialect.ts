/**
 * The sandbox dialect of this system, as far as setup needs it: whether the
 * dialect can express `docker-connect`, the rule that keeps confined commands
 * off the Docker socket (contract C1, "Enforcement per platform and dialect").
 * Setup labels Docker mode on a system whose dialect cannot, and this module
 * is that single decision.
 *
 * @module @delo/cli/setup/dialect
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The sandbox dialects C1 names. `none` is a system where no sandbox runs. */
export type SandboxDialect = 'bwrap' | 'seatbelt' | 'landlock' | 'windows-acl' | 'none'

/**
 * Whether a dialect confines `docker-connect` on a system where its probe proves it. Only bwrap and Seatbelt
 * express the rule; Landlock cannot deny a connect to a pathname socket, and Windows reports it only where its
 * pipe-denial test passes, which setup does not run.
 * @param dialect - the system's dialect.
 * @returns true when setup may describe Docker mode without the not-enforced label.
 */
export function dockerConnectEnforced(dialect: SandboxDialect): boolean {
  return dialect === 'bwrap' || dialect === 'seatbelt'
}

/**
 * The dialect a system runs: bwrap on Linux when `bwrap` is on the path, Landlock on Linux without it,
 * Seatbelt on macOS and windows-acl on Windows.
 * @param platform - the operating system's name, as `process.platform` gives it.
 * @param path - the executable search path.
 * @returns the dialect; `none` when the platform has no dialect this module names.
 */
export function probeSandboxDialect(platform: NodeJS.Platform, path: string | undefined): SandboxDialect {
  if (platform === 'darwin') return 'seatbelt'
  if (platform === 'win32') return 'windows-acl'
  if (platform !== 'linux') return 'none'
  const onPath = (path ?? '').split(delimiter).some(directory => directory !== '' && existsSync(join(directory, 'bwrap')))
  return onPath ? 'bwrap' : 'landlock'
}
