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
 * On Linux and macOS the lookup follows the POSIX spawn the stdio transport
 * performs (libuv's `execvp` over the child's `PATH`). On Windows the
 * transport spawns through `cross-spawn`, which looks a bare command up with
 * `PATHEXT`, wraps every file that is not an `.exe` or `.com` in
 * `%COMSPEC% /d /s /c` (Node refuses to spawn `.cmd` and `.bat` files without a
 * shell), and starts a file with a `#!` line through an interpreter it looks
 * up itself. The resolver finds the file with `PATH` and `PATHEXT` without
 * searching the working directory first, and the plugin spawns that absolute
 * file, so `cross-spawn` runs it directly or through the Host's `COMSPEC`,
 * whose canonical path the review is shown for a batch file; a
 * file with another extension, which would start through a file association,
 * a file with a `#!` line, and a batch script without an absolute `COMSPEC`
 * are left unresolved.
 *
 * @module
 */

import { constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
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

/** The file kinds the resolver tells apart. */
interface PathKind {
  /** A regular file, after symbolic links. */
  readonly file: boolean
  /** A directory, after symbolic links. */
  readonly directory: boolean
}

/**
 * The host facts and file operations a resolution reads. The plugin uses
 * {@link nodeStartHost}; tests pass a fake host to resolve as Windows or POSIX
 * on any operating system.
 */
export interface ServerStartHost {
  /** The platform whose spawn rules apply. */
  readonly platform: NodeJS.Platform
  /** The Host's working directory, against which a relative `cwd` resolves. */
  readonly cwd: string
  /** The Host's environment, read for `COMSPEC` on Windows. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * The canonical path of an existing path.
   * @param path - an absolute path.
   * @returns the path with every link resolved; rejects when it does not exist.
   */
  readonly realpath: (path: string) => Promise<string>
  /**
   * What a path names, following links.
   * @param path - an absolute path.
   * @returns the kind, or `undefined` when nothing is there.
   */
  readonly kind: (path: string) => Promise<PathKind | undefined>
  /**
   * Whether this process may execute a file (POSIX execute permission).
   * @param path - an absolute path of a regular file.
   * @returns true when execution is permitted.
   */
  readonly executable: (path: string) => Promise<boolean>
  /**
   * The first bytes of a file as text, for its `#!` line.
   * @param path - an absolute path of a regular file.
   * @returns up to 150 bytes, decoded; the empty string when unreadable.
   */
  readonly head: (path: string) => Promise<string>
}

/** The Node host: this process's platform, working directory, environment and file system. */
export const nodeStartHost: ServerStartHost = {
  platform: process.platform,
  get cwd() { return process.cwd() },
  env: process.env,
  realpath: path => realpath(path),
  kind: async (path) => {
    try {
      const info = await stat(path)
      return { file: info.isFile(), directory: info.isDirectory() }
    } catch (_missing) {
      // A missing or unreadable path is one the lookup skips.
      return undefined
    }
  },
  executable: async (path) => {
    try {
      await access(path, constants.X_OK)
      return true
    } catch (_denied) {
      // A file without execute permission is one `execvp` skips with EACCES.
      return false
    }
  },
  head: async (path) => {
    let handle
    try {
      handle = await open(path, 'r')
      const buffer = Buffer.alloc(150)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString()
    } catch (_unreadable) {
      // An unreadable file has no `#!` line cross-spawn could read either.
      return ''
    } finally {
      await handle?.close()
    }
  },
}

/**
 * The canonical working directory a server start runs in.
 * @param config - the server's stdio configuration.
 * @param host - the host facts and file operations.
 * @returns the absolute directory with every symbolic link resolved.
 * @throws {McpServerStartUnresolvedError} when the directory does not exist or is not a directory.
 */
async function resolveCwd(config: StdioConfig, host: ServerStartHost): Promise<string> {
  const absolute = pathOf(host).resolve(host.cwd, config.cwd)
  let canonical: string
  try {
    canonical = await host.realpath(absolute)
  } catch (_error) {
    // A directory that is missing or unreadable cannot be the reviewed one; the refusal names it.
    throw new McpServerStartUnresolvedError(config, `the working directory ${JSON.stringify(absolute)} does not exist or cannot be read`)
  }
  if ((await host.kind(canonical))?.directory !== true) {
    throw new McpServerStartUnresolvedError(config, `the working directory ${JSON.stringify(canonical)} is not a directory`)
  }
  return canonical
}

/** The path flavour of a host. */
function pathOf(host: ServerStartHost): typeof posix {
  return host.platform === 'win32' ? win32 : posix
}

/**
 * One variable of a child environment as Windows reads it: names compare
 * without case, and Node passes the first of several spellings in sorted order.
 * @param env - the child environment.
 * @param name - the variable's name.
 * @returns its value, or `undefined`.
 */
export function windowsEnvValue(env: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(env).sort().find(candidate => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/**
 * The absolute path of the executable a command names on POSIX, found as the
 * stdio transport's spawn finds it: a command containing `/` is a path
 * resolved against the working directory; a bare command is looked up in each
 * entry of the child's `PATH` in order, where an empty entry is the working
 * directory and a relative entry is resolved against it. Symbolic links are
 * kept, so the path is the one the spawn executes.
 * @param config - the server's stdio configuration.
 * @param cwd - the resolved working directory.
 * @param host - the host facts and file operations.
 * @returns the absolute executable path.
 * @throws {McpServerStartUnresolvedError} when no executable file is found.
 */
async function resolvePosixCommand(config: StdioConfig, cwd: string, host: ServerStartHost): Promise<string> {
  const isExecutable = async (path: string): Promise<boolean> => (await host.kind(path))?.file === true && await host.executable(path)
  if (config.command.includes('/')) {
    const path = posix.resolve(cwd, config.command)
    if (await isExecutable(path)) return path
    throw new McpServerStartUnresolvedError(config, `${JSON.stringify(path)} is not an executable file`)
  }
  const searchPath = childSpawnEnv(config.env)['PATH']
  if (searchPath === undefined) {
    throw new McpServerStartUnresolvedError(config, 'the server\'s environment sets no PATH to look the command up in')
  }
  for (const entry of searchPath.split(posix.delimiter)) {
    const candidate = posix.resolve(cwd, entry, config.command)
    if (await isExecutable(candidate)) return candidate
  }
  // The PATH value is not named: a configured PATH is an environment value, which no refusal shows.
  throw new McpServerStartUnresolvedError(config, `no executable file named ${JSON.stringify(config.command)} is in the server's PATH`)
}

/** The extensions Windows tries when the environment sets no `PATHEXT`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** The files Windows starts directly; cross-spawn runs every other file through `COMSPEC`. */
const DIRECT_EXECUTABLE = /\.(?:com|exe)$/iu

/** The files whose start the resolver reviews: programs, and the batch scripts `cmd.exe` runs itself. */
const REVIEWABLE = /\.(?:com|exe|bat|cmd)$/iu

/**
 * The absolute path of the file a command names on Windows. A command with a
 * `\` or `/` is a path resolved against the working directory; a bare command
 * is looked up in each absolute entry of the child's `PATH` in order, its
 * quotes removed. Unlike `cross-spawn`'s own lookup, the working directory is
 * not searched first and empty or relative `PATH` entries are skipped, so a
 * file a workspace holds is never picked by its name alone. In each place the
 * name itself is tried first when it has an extension, then the name with each
 * `PATHEXT` extension; a file qualifies when it is a regular file whose
 * extension `PATHEXT` lists, compared without case.
 * @param config - the server's stdio configuration.
 * @param cwd - the resolved working directory.
 * @param host - the host facts and file operations.
 * @returns the absolute file path, and for a `.bat` or `.cmd` file the canonical path of the `COMSPEC` that runs it.
 * @throws {McpServerStartUnresolvedError} when no file qualifies, the file is not an `.exe`, `.com`, `.bat` or `.cmd`
 *   file, it has a `#!` line, or a batch script has no absolute `COMSPEC` to run it.
 */
async function resolveWindowsCommand(config: StdioConfig, cwd: string, host: ServerStartHost): Promise<{ file: string; shell?: string }> {
  const env = childSpawnEnv(config.env)
  const extensions = (windowsEnvValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').filter(ext => ext.length > 0).map(ext => ext.toLowerCase())
  const named = win32.extname(config.command).length > 0
  const candidatesIn = (directory: string): string[] => {
    const base = win32.resolve(directory, config.command)
    return [...named ? [base] : [], ...extensions.map(ext => `${base}${ext}`)]
  }
  const qualifies = async (path: string): Promise<boolean> =>
    extensions.includes(win32.extname(path).toLowerCase()) && (await host.kind(path))?.file === true
  let directories: string[]
  if (/[\\/]/u.test(config.command)) {
    directories = [cwd]
  } else {
    const searchPath = windowsEnvValue(env, 'PATH')
    if (searchPath === undefined) {
      throw new McpServerStartUnresolvedError(config, 'the server\'s environment sets no PATH to look the command up in')
    }
    directories = searchPath.split(';').map(entry => entry.replace(/^"(.*)"$/u, '$1')).filter(entry => win32.isAbsolute(entry))
  }
  let found: string | undefined
  for (const directory of directories) {
    for (const candidate of candidatesIn(directory)) {
      if (await qualifies(candidate)) {
        found = candidate
        break
      }
    }
    if (found !== undefined) break
  }
  if (found === undefined) {
    throw new McpServerStartUnresolvedError(config, /[\\/]/u.test(config.command)
      ? `${JSON.stringify(win32.resolve(cwd, config.command))} is not a file whose extension PATHEXT lists`
      : `no file named ${JSON.stringify(config.command)} with an extension PATHEXT lists is in an absolute entry of the server's PATH`)
  }
  if (!REVIEWABLE.test(found)) {
    throw new McpServerStartUnresolvedError(config, `${JSON.stringify(found)} would start through the program its extension is associated with`)
  }
  if ((await host.head(found)).startsWith('#!')) {
    throw new McpServerStartUnresolvedError(config, `${JSON.stringify(found)} starts with a #! line, whose interpreter the Windows spawn looks up itself`)
  }
  if (DIRECT_EXECUTABLE.test(found)) return { file: found }
  return { file: found, shell: await resolveComspec(config, found, host) }
}

/**
 * The canonical path of the Host's `COMSPEC`, the command shell `cross-spawn` runs a batch file through.
 * @param config - the server's stdio configuration, named in a refusal.
 * @param file - the batch file, named in a refusal.
 * @param host - the host facts and file operations.
 * @returns the shell's absolute path with every link resolved.
 * @throws {McpServerStartUnresolvedError} when `COMSPEC` is unset, relative, or not an existing file.
 */
async function resolveComspec(config: StdioConfig, file: string, host: ServerStartHost): Promise<string> {
  const refused = (): McpServerStartUnresolvedError =>
    new McpServerStartUnresolvedError(config, `${JSON.stringify(file)} runs through COMSPEC, which is not set to an existing absolute file`)
  const comspec = Object.entries(host.env).find(([name]) => name.toUpperCase() === 'COMSPEC')?.[1]
  if (comspec === undefined || !win32.isAbsolute(comspec)) throw refused()
  let canonical: string
  try {
    canonical = await host.realpath(comspec)
  } catch (_missing) {
    // A shell that is missing or unreadable cannot be the reviewed one; the refusal names the batch file.
    throw refused()
  }
  if ((await host.kind(canonical))?.file !== true) throw refused()
  return canonical
}

/**
 * Resolve a stdio server's configured start into the start a consent review
 * judges: the configured command, arguments, environment and working
 * directory, the working directory resolved against the Host's current
 * working directory with every symbolic link resolved, and the absolute path
 * of the file the spawn runs, looked up with the `PATH` (and on Windows
 * `PATHEXT`) of the environment the stdio transport gives the child
 * ({@link childSpawnEnv}), and on Windows, for a `.bat` or `.cmd` file, the
 * canonical path of the Host's `COMSPEC` that runs it.
 * @param config - the server's stdio configuration.
 * @param host - the host facts and file operations; the plugin passes {@link nodeStartHost}.
 * @returns the start under review.
 * @throws {McpServerStartUnresolvedError} when the working directory or the
 *   executable cannot be resolved as the spawn would run it.
 */
export async function resolveServerStart(config: StdioConfig, host: ServerStartHost = nodeStartHost): Promise<McpServerCommand> {
  const resolvedCwd = await resolveCwd(config, host)
  const { file: resolvedCommand, shell } = host.platform === 'win32'
    ? await resolveWindowsCommand(config, resolvedCwd, host)
    : { file: await resolvePosixCommand(config, resolvedCwd, host) }
  return {
    serverName: config.serverName,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    resolvedCommand,
    resolvedCwd,
    ...shell === undefined ? {} : { resolvedShell: shell },
  }
}
