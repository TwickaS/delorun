/**
 * Resolution of a stdio server's configured start into the executable and
 * working directory the spawn uses, so the add-time consent reviews what runs
 * and the server runs what was reviewed. A configured `cwd` that is empty or
 * relative depends on the Host's working directory, and a bare `command`
 * depends on the `PATH` the child is started with; the same configuration can
 * therefore run a different executable when the Host starts elsewhere or its
 * `PATH` changes. {@link resolveServerStart} fixes both into absolute paths,
 * and the mcp-client plugin spawns the reviewed paths.
 *
 * The lookup follows the POSIX spawn that the stdio transport performs on
 * Linux and macOS (libuv's `execvp` over the child's `PATH`); on Windows the
 * transport resolves commands through `PATHEXT`, `cmd.exe` shims and script
 * interpreters, which this module does not reproduce, so a Windows start is
 * unresolved and no consent review runs.
 *
 * @module
 */

import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import type { McpServerCommand } from './consent.ts'
import type { StdioConfig } from './index.ts'
import { childSpawnEnv } from './transport.ts'

/**
 * Refusal of one server start because its command or working directory could
 * not be resolved to the absolute paths a consent review judges. The server
 * stays stopped: a start whose executable is unknown is never reviewed or
 * started.
 */
export class McpServerStartUnresolvedError extends Error {
  /** The server's configured namespace. */
  readonly serverName: string
  /** The configured executable. */
  readonly command: string
  /** The configured working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** Why the start could not be resolved. */
  readonly reason: string

  /**
   * @param config - the server's stdio configuration.
   * @param reason - why the start could not be resolved.
   */
  constructor(config: Pick<StdioConfig, 'serverName' | 'command' | 'cwd'>, reason: string) {
    super(
      `mcp-client(${config.serverName}): the command ${JSON.stringify(config.command)} could not be resolved to an executable, `
        + `so the add-time consent cannot review it and the server stays stopped — ${reason}. `
        + 'A server command runs outside the agent sandbox.',
    )
    this.name = 'McpServerStartUnresolvedError'
    this.serverName = config.serverName
    this.command = config.command
    this.cwd = config.cwd
    this.reason = reason
  }
}

/**
 * The canonical working directory a server start runs in.
 * @param config - the server's stdio configuration.
 * @param hostCwd - the Host's working directory at review time.
 * @returns the absolute directory with every symbolic link resolved.
 * @throws {McpServerStartUnresolvedError} when the directory does not exist or is not a directory.
 */
async function resolveCwd(config: StdioConfig, hostCwd: string): Promise<string> {
  const absolute = resolve(hostCwd, config.cwd)
  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch (_error) {
    // A directory that is missing or unreadable cannot be the reviewed one; the refusal names it.
    throw new McpServerStartUnresolvedError(config, `the working directory ${JSON.stringify(absolute)} does not exist or cannot be read`)
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new McpServerStartUnresolvedError(config, `the working directory ${JSON.stringify(canonical)} is not a directory`)
  }
  return canonical
}

/**
 * Whether a path names a file the spawn can execute: a regular file, after
 * symbolic links, with execute permission for this process.
 * @param path - the absolute candidate path.
 * @returns true when `execve` of the path would not fail for permission or file type.
 */
async function isExecutableFile(path: string): Promise<boolean> {
  let regular: boolean
  try {
    regular = (await stat(path)).isFile()
  } catch (_error) {
    // A missing or unreadable candidate is one `execvp` skips; the lookup tries the next PATH entry.
    return false
  }
  if (!regular) return false
  try {
    await access(path, constants.X_OK)
  } catch (_error) {
    // A file without execute permission is one `execvp` skips with EACCES.
    return false
  }
  return true
}

/**
 * The absolute path of the executable a command names, found as the stdio
 * transport's spawn finds it on POSIX: a command containing `/` is a path
 * resolved against the working directory; a bare command is looked up in each
 * entry of the child's `PATH` in order, where an empty entry is the working
 * directory and a relative entry is resolved against it. Symbolic links are
 * kept, so the path is the one the spawn executes.
 * @param config - the server's stdio configuration.
 * @param cwd - the resolved working directory.
 * @returns the absolute executable path.
 * @throws {McpServerStartUnresolvedError} when no executable file is found.
 */
async function resolveCommand(config: StdioConfig, cwd: string): Promise<string> {
  if (config.command.includes('/')) {
    const path = resolve(cwd, config.command)
    if (await isExecutableFile(path)) return path
    throw new McpServerStartUnresolvedError(config, `${JSON.stringify(path)} is not an executable file`)
  }
  const searchPath = childSpawnEnv(config.env)['PATH']
  if (searchPath === undefined) {
    throw new McpServerStartUnresolvedError(config, 'the server\'s environment sets no PATH to look the command up in')
  }
  for (const entry of searchPath.split(delimiter)) {
    const candidate = resolve(cwd, entry, config.command)
    if (await isExecutableFile(candidate)) return candidate
  }
  // The PATH value is not named: a configured PATH is an environment value, which no refusal shows.
  throw new McpServerStartUnresolvedError(config, `no executable file named ${JSON.stringify(config.command)} is in the server's PATH`)
}

/**
 * Resolve a stdio server's configured start into the start a consent review
 * judges: the configured command, arguments, environment and working
 * directory, the working directory resolved against the Host's current
 * working directory with every symbolic link resolved, and the absolute path
 * of the executable the spawn runs, looked up with the `PATH` of the
 * environment the stdio transport gives the child ({@link childSpawnEnv}).
 * @param config - the server's stdio configuration.
 * @returns the start under review.
 * @throws {McpServerStartUnresolvedError} on Windows, and when the working
 *   directory or the executable cannot be resolved.
 */
export async function resolveServerStart(config: StdioConfig): Promise<McpServerCommand> {
  if (process.platform === 'win32') {
    throw new McpServerStartUnresolvedError(config, 'resolving a command as the stdio transport starts it on Windows (PATHEXT, cmd.exe shims, script interpreters) is not supported')
  }
  const resolvedCwd = await resolveCwd(config, process.cwd())
  const resolvedCommand = await resolveCommand(config, resolvedCwd)
  return {
    serverName: config.serverName,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    resolvedCommand,
    resolvedCwd,
  }
}
