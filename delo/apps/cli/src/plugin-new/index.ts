/**
 * `delorun plugin new <name> [--kind tool|preset|ui|bundle] [--dir <folder>]`: scaffold a plugin package that builds,
 * passes `delorun plugin check` and loads in a profile on the release that runs.
 *
 * Contract:
 * - The kind is `tool` by default; the folder is `<name without its scope>` resolved against the working directory
 *   unless `--dir` names another. The folder may exist only as an empty directory that is not a symbolic link, and its
 *   parent must exist.
 * - It refuses a name, a kind or a folder as [the scaffold](@delo/plugin-scaffold) does, a name with the usage code and a
 *   folder with the failure code, and writes only inside the folder.
 * - It prints the files it wrote and the commands that follow: install, build, check, `delorun plugin dev` and
 *   `delorun plugin add`.
 *
 * The files of each kind and the writer are in `@delo/plugin-scaffold`, which the studio's Create a plugin uses too.
 *
 * @module @delo/cli/plugin-new
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { bareName, checkKind, createPlugin, nextCommands, PLUGIN_KINDS, runningInstallation, ScaffoldError, type Installation, type PluginKind } from '@delo/plugin-scaffold'
import type { CommandContext, CommandResult } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { printable } from '../terminal-text.ts'
import { versions } from '../version.ts'

/** The usage line. */
export const PLUGIN_NEW_USAGE = `usage: delorun plugin new <name> [--kind ${PLUGIN_KINDS.join('|')}] [--dir <folder>]`

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
  if (parsed.values.dir === '') throw usage('--dir needs a folder')
  return { name, kind: checkKind(parsed.values.kind ?? 'tool'), dir: parsed.values.dir }
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
  const parseRefusal = (error: unknown): never => {
    if (error instanceof ScaffoldError) throw new CliError(error.kind === 'usage' ? EXIT.usage : EXIT.failed, `delorun plugin new: ${printable(error.message)}`)
    throw error
  }
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args)
  } catch (error) {
    return parseRefusal(error)
  }
  const { name, kind, dir } = parsed
  const typed = dir ?? bareName(name)
  const folder = resolve(typed)
  let files: readonly string[]
  try {
    files = await createPlugin({ name, kind, folder, running, installation })
  } catch (error) {
    return parseRefusal(error)
  }
  const commands = nextCommands(kind, typed, folder)
  const width = Math.max(...commands.map(([command]) => command.length))
  context.stdout([
    `Created ${name}, a ${kind} plugin, in ${folder}:`,
    ...files.map(file => `  ${file}`),
    '',
    'Next:',
    ...commands.map(([command, what]) => what === '' ? `  ${command}` : `  ${command.padEnd(width)}  ${what}`),
    '',
  ].map(printable).join('\n'))
  return EXIT.ok
}
