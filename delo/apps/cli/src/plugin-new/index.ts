/**
 * `delorun plugin new <name> [--kind tool|preset|ui|bundle] [--dir <folder>]`: scaffold a plugin package that builds,
 * passes `delorun plugin check` and loads in a profile on the release that runs.
 *
 * Contract:
 * - The kind is `tool` by default; the folder is `<name without its scope>` resolved against the working directory
 *   unless `--dir` names another. The folder may exist only as an empty directory that is not a symbolic link, and its
 *   parent must exist.
 * - It refuses, with the usage code, a name npm would not publish, a name under the `@deepseek-ai/` or `@delo/` scope,
 *   and a name the installation ships, because a profile resolves a shipped package before a profile install
 *   ([installation](./installation.ts)). It refuses a folder that exists and is not empty with the failure code.
 * - It writes only inside the folder, creates no file that exists, and removes what it wrote when a write fails.
 * - The package declares `engines.dsh` as `^<running DSH>` and `engines.delo` as the range `delorun plugin check`
 *   recommends for the running Delo; the DSH packages a plugin with code shares with the host are peer and
 *   development dependencies on `^<running DSH>`, and `@deepseek-ai/cordis` on `~<installed cordis>`.
 * - It prints the files it wrote and the commands that follow: install, build, check, `delorun plugin dev` and
 *   `delorun plugin add`.
 *
 * The files of each kind are in [scaffold](./scaffold.ts) and [templates](./templates.ts).
 *
 * @module @delo/cli/plugin-new
 */
import { lstat, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { messageOf } from '@delo/install'
import type { CommandContext, CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { printable } from '../terminal-text.ts'
import { versions } from '../version.ts'
import { installationShips, installedCordisVersion, RESERVED_SCOPES, runningInstallation, type Installation } from './installation.ts'
import { bareName, PLUGIN_KINDS, scaffoldFiles, type PluginKind, type ScaffoldFile } from './scaffold.ts'
import { nextCommands } from './templates.ts'

/** The usage line. */
export const PLUGIN_NEW_USAGE = `usage: delorun plugin new <name> [--kind ${PLUGIN_KINDS.join('|')}] [--dir <folder>]`

/** An npm package name: lowercase URL-safe characters, an optional scope, no leading dot or underscore (upstream's install-spec rule). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

/** The longest name the npm registry accepts. */
const PACKAGE_NAME_MAX_LENGTH = 214

/** Names the npm registry refuses although they match {@link PACKAGE_NAME}. */
const REFUSED_NAMES = new Set(['node_modules', 'favicon.ico'])

/** The options the command takes. */
const OPTIONS = { kind: { type: 'string' }, dir: { type: 'string' } } as const

/**
 * A usage error.
 * @param message - what is wrong and what to do.
 * @returns the error.
 */
function usage(message: string): CliError {
  return new CliError(EXIT.usage, `delorun plugin new: ${message}`)
}

/**
 * Read the command line.
 * @param args - the arguments after `new`.
 * @returns the name, kind and folder option.
 * @throws {CliError} with the usage code for an unknown option, a missing or extra name, or an unknown kind.
 */
function parse(args: readonly string[]): { readonly name: string, readonly kind: PluginKind, readonly dir: string | undefined } {
  let parsed: ReturnType<typeof parseArgs<{ args: string[], options: typeof OPTIONS, strict: true, allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...args], options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    // parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for an unknown or malformed option.
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') === true) throw usage(`${error.message}; ${PLUGIN_NEW_USAGE}`)
    throw error
  }
  const [name, ...rest] = parsed.positionals
  if (name === undefined || rest.length > 0) throw usage(PLUGIN_NEW_USAGE)
  const kind = parsed.values.kind ?? 'tool'
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) throw usage(`there is no plugin kind ${JSON.stringify(printable(kind))}; choose one of ${PLUGIN_KINDS.join(', ')}`)
  if (parsed.values.dir === '') throw usage('--dir needs a folder')
  return { name, kind: kind as PluginKind, dir: parsed.values.dir }
}

/**
 * Refuse a name a new plugin cannot take by its form alone.
 * @param name - the name.
 * @throws {CliError} with the usage code for a name npm would not publish or one under a reserved scope.
 */
function checkName(name: string): void {
  const shown = JSON.stringify(printable(name))
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name) || REFUSED_NAMES.has(bareName(name)) || isBuiltin(name)) {
    throw usage(`${shown} is not a package name npm publishes; use lowercase letters, digits, "-", "." and "_", not first a "." or "_", optionally after a scope such as @you/, and not the name of a Node.js module`)
  }
  const scope = RESERVED_SCOPES.find(reserved => name.startsWith(reserved))
  if (scope !== undefined) throw usage(`${shown} is under the ${scope.slice(0, -1)} scope, which only its own packages use; name the plugin under your own scope, such as @you/${bareName(name)}`)
}

/**
 * Check that the folder can take the scaffold: an empty directory, or a new one whose parent exists.
 * @param folder - the folder's absolute path.
 * @returns whether the folder must be created.
 * @throws {CliError} with the failure code for a folder that exists and is not an empty directory, or a missing parent.
 */
async function checkFolder(folder: string): Promise<boolean> {
  const shown = printable(folder)
  const status = await lstat(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CliError(EXIT.failed, `delorun plugin new: ${shown} cannot be read: ${printable(messageOf(error))}`)
  })
  if (status === undefined) {
    // The parent may be reached through a symbolic link, such as /tmp on macOS; only the new folder must not be one.
    const parent = await stat(dirname(folder)).catch((_error: unknown) => undefined /* reported as missing below */)
    if (parent?.isDirectory() !== true) throw new CliError(EXIT.failed, `delorun plugin new: ${printable(dirname(folder))} is not a folder; create it first, or choose another folder with --dir`)
    return true
  }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new CliError(EXIT.failed, `delorun plugin new: ${shown} exists and is not a folder; choose another folder with --dir`)
  if ((await readdir(folder)).length > 0) throw new CliError(EXIT.failed, `delorun plugin new: ${shown} is not empty; choose a new or empty folder with --dir`)
  return false
}

/**
 * Write the scaffold into the folder, creating no file or directory that exists. When a write fails, what this call
 * wrote is removed: the folder when this call created it, otherwise each file and directory it created.
 * @param folder - the folder's absolute path.
 * @param create - whether to create the folder.
 * @param files - the files.
 * @throws {CliError} with the failure code when a write fails.
 */
async function writeScaffold(folder: string, create: boolean, files: readonly ScaffoldFile[]): Promise<void> {
  const directories = [...new Set(files.flatMap((file) => {
    const parts = file.path.split('/').slice(0, -1)
    return parts.map((_part, index) => parts.slice(0, index + 1).join('/'))
  }))]
  const created: { readonly path: string, readonly directory: boolean }[] = []
  let ownsFolder = false
  try {
    if (create) {
      await mkdir(folder)
      ownsFolder = true
    }
    for (const directory of directories) {
      const path = join(folder, ...directory.split('/'))
      await mkdir(path)
      created.push({ path, directory: true })
    }
    for (const file of files) {
      const path = join(folder, ...file.path.split('/'))
      await writeFile(path, file.text, { flag: 'wx' })
      created.push({ path, directory: false })
    }
  } catch (error) {
    if (ownsFolder) await rm(folder, { recursive: true, force: true })
    else for (const { path, directory } of created.reverse()) await (directory ? rmdir(path) : rm(path, { force: true }))
    throw new CliError(EXIT.failed, `delorun plugin new: ${printable(folder)} could not be written, and what this command wrote there is removed: ${printable(messageOf(error))}`)
  }
}

/**
 * Run `delorun plugin new`.
 * @param args - the arguments after `new`.
 * @param context - where the command writes.
 * @param running - the release the plugin targets; this Delo's two versions by default.
 * @param installation - the installation whose shipped packages a name may not take and whose cordis version the
 *   plugin declares; the one this `delorun` runs on by default.
 * @returns 0 once the folder is written.
 * @throws {CliError} with the usage code for a wrong command line or a refused name; with the failure code for a
 *   folder that cannot take the scaffold or a write that fails.
 */
export async function runPluginNew(args: readonly string[], context: CommandContext, running: VersionOutput = versions(), installation: Installation = runningInstallation()): Promise<CommandResult> {
  const { name, kind, dir } = parse(args)
  checkName(name)
  const typed = dir ?? bareName(name)
  const folder = resolve(typed)
  const create = await checkFolder(folder)
  if (await installationShips(installation, name)) {
    throw usage(`${JSON.stringify(printable(name))} is a package this Delo installation ships, and a profile loads the shipped package instead of a plugin of the same name; choose another name, such as @you/${bareName(name)}`)
  }
  const files = scaffoldFiles({ name, kind, dsh: running.dsh, delo: running.delo, cordis: installedCordisVersion(installation) })
  await writeScaffold(folder, create, files)
  const commands = nextCommands(kind, typed, folder)
  const width = Math.max(...commands.map(([command]) => command.length))
  context.stdout([
    `Created ${name}, a ${kind} plugin, in ${folder}:`,
    ...files.map(file => `  ${file.path}`),
    '',
    'Next:',
    ...commands.map(([command, what]) => what === '' ? `  ${command}` : `  ${command.padEnd(width)}  ${what}`),
    '',
  ].map(printable).join('\n'))
  return EXIT.ok
}
