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
import { RUNNER_PROTECTION, pathAliasCoverage } from '@deepseek-ai/dsh-sandbox-local'
import type { AliasCoverage } from '@deepseek-ai/dsh-sandbox-local'

/** The sandbox dialects C1 names. `none` is a system where no sandbox runs. */
export type SandboxDialect = 'bwrap' | 'seatbelt' | 'landlock' | 'windows-acl' | 'none'

/**
 * Whether a dialect confines `docker-connect` on a system where its probe proves it, as upstream's sandbox profiles
 * report it (`RUNNER_PROTECTION`): bwrap and Seatbelt express the rule; Landlock cannot deny a connect to a pathname
 * socket, and the Windows profile adds no pipe rule, so Windows reports it only where its pipe-denial test passes,
 * which setup does not run. Where the Docker socket's other mounts cannot be found, the rule is not described as
 * enforced either.
 * @param dialect - the system's dialect.
 * @param coverage - whether every other mount of the Docker socket can be found ({@link probeDockerAliasCoverage}).
 * @returns true when setup may describe Docker mode without the not-enforced label.
 */
export function dockerConnectEnforced(dialect: SandboxDialect, coverage: AliasCoverage = 'complete'): boolean {
  return dialect !== 'none' && RUNNER_PROTECTION[dialect].socketConnect && coverage === 'complete'
}

/**
 * Whether the other mounts of the Docker sockets setup can see, the rootful `/var/run/docker.sock` and a rootless
 * `$XDG_RUNTIME_DIR/docker.sock`, can all be found on this system.
 * @param runtimeDirectory - `$XDG_RUNTIME_DIR`.
 * @param coverageOf - the coverage of one path; upstream's sandbox report when omitted.
 * @returns `unknown` when one of them lies where aliases cannot be found or the mount table cannot be read.
 */
export function probeDockerAliasCoverage(
  runtimeDirectory: string | undefined,
  coverageOf: (path: string) => AliasCoverage = pathAliasCoverage,
): AliasCoverage {
  const sockets = ['/var/run/docker.sock', ...runtimeDirectory === undefined || runtimeDirectory === '' ? [] : [join(runtimeDirectory, 'docker.sock')]]
  try {
    return sockets.some(socket => coverageOf(socket) === 'unknown') ? 'unknown' : 'complete'
  } catch {
    // The mount table could not be read, so the sockets' other mounts cannot be found.
    return 'unknown'
  }
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
