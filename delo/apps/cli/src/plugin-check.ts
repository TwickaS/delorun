/**
 * `delorun plugin check <directory>` (contract C17, "Checking a plugin before it is installed"; contract C21): what a
 * plugin's declared version ranges admit against the release that runs. It reads the plugin's `package.json` as JSON,
 * imports and runs none of its files, and decides both axes with upstream's `evaluatePluginCompatibility`, the
 * evaluation the installer and the start's preflight run, with no exemption. It prints, for each axis, what is
 * declared and whether this release meets it, what is undeclared, and the range that targets the running Delo minor.
 *
 * @module @delo/cli/plugin-check
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from '@deepseek-ai/dsh-app-boot'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { messageOf } from '@delo/install'
import semver from 'semver'
import { CliError, EXIT } from './exit.ts'
import type { CommandContext, CommandResult } from './command.ts'
import { versions } from './version.ts'

/** The largest `package.json` the command reads; a larger file is refused unread. */
export const PLUGIN_MANIFEST_LIMIT = 1_048_576

/** The usage line. */
const USAGE = 'usage: delorun plugin check <directory>'

/**
 * Whether a value is a plain JSON object.
 * @param value - the value.
 * @returns true for an object that is not an array.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a plugin's manifest without importing anything.
 * @param directory - the plugin's directory.
 * @returns the parsed `package.json`.
 * @throws {CliError} when the file is missing, larger than {@link PLUGIN_MANIFEST_LIMIT}, not JSON or not an object.
 */
async function readManifest(directory: string): Promise<Record<string, unknown>> {
  const path = join(directory, 'package.json')
  let text: string
  try {
    const size = (await stat(path)).size
    if (size > PLUGIN_MANIFEST_LIMIT) throw new Error(`it has ${String(size)} bytes, above the limit of ${String(PLUGIN_MANIFEST_LIMIT)}`)
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun plugin check: ${path} cannot be read: ${messageOf(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun plugin check: ${path} is not JSON: ${messageOf(error)}`)
  }
  if (!isObject(value)) throw new CliError(EXIT.failed, `delorun plugin check: ${path} is not a package manifest object`)
  return value
}

/**
 * The range that targets a Delo release's minor: every patch of it, and no later minor.
 * @param delo - the running Delo version.
 * @returns `^<major>.<minor>.0`, which before 1.0 admits only that minor's patches.
 */
export function targetRange(delo: string): string {
  return `^${String(semver.major(delo))}.${String(semver.minor(delo))}.0`
}

/**
 * Whether a version meets a range, as upstream decides it: prereleases take part, and an empty range is unmet.
 * @param version - the version.
 * @param range - the range.
 * @returns true when it is met.
 */
function meets(version: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(version, range, { includePrerelease: true })
}

/**
 * The lines about the upstream axis.
 * @param engines - the manifest's `engines` object, or an empty one.
 * @param manifest - the plugin's manifest, for its peer dependencies.
 * @param dsh - the running DSH version.
 * @returns one line per declaration, or the line that says nothing is declared.
 */
function dshLines(engines: Record<string, unknown>, manifest: Record<string, unknown>, dsh: string): string[] {
  if (Object.hasOwn(engines, 'dsh')) {
    const declared = engines['dsh']
    if (typeof declared !== 'string') return ['DSH axis: engines.dsh is not a string, so it cannot be read.']
    return [`DSH axis: engines.dsh "${declared}" ${meets(dsh, declared) ? 'admits' : 'does not admit'} DSH ${dsh}; it alone decides this axis, so peer dependencies are not read.`]
  }
  const declaredPeers = manifest['peerDependencies']
  const peers = isObject(declaredPeers) ? Object.entries(declaredPeers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) : []
  if (peers.length === 0) return [`DSH axis: undeclared, so the plugin loads on any DSH. Declare "engines": { "dsh": "^${dsh}" }, or the range you test against, to state it.`]
  return peers.map(([name, range]) => {
    if (typeof range !== 'string') return `DSH axis: peer ${name} is not a string, so it cannot be read.`
    const admits = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) || meets(dsh, range)
    return `DSH axis: peer ${name} "${range}" ${admits ? 'admits' : 'does not admit'} DSH ${dsh}; without engines.dsh every DSH peer must admit it.`
  })
}

/**
 * The line about the Delo axis.
 * @param engines - the manifest's `engines` object, or an empty one.
 * @param delo - the running Delo version.
 * @returns the line.
 */
function deloLine(engines: Record<string, unknown>, delo: string): string {
  if (!Object.hasOwn(engines, 'delo')) {
    return `Delo axis: undeclared, so the plugin loads on any Delo and Delo promises it nothing. To target Delorun ${delo} and its patches, declare "engines": { "delo": "${targetRange(delo)}" }.`
  }
  const declared = engines['delo']
  if (typeof declared !== 'string') return `Delo axis: engines.delo is not a string, so Delo cannot read it and refuses the plugin. Declare a range such as "${targetRange(delo)}".`
  return `Delo axis: engines.delo "${declared}" ${meets(delo, declared) ? 'admits' : 'does not admit'} Delo ${delo}.`
}

/**
 * Run `delorun plugin check`.
 * @param args - the arguments after `check`: one directory.
 * @param context - where the command writes.
 * @param running - the release to check against; this Delo's two versions by default.
 * @returns 0 when the installer would admit the plugin on this release, 1 when it would refuse it.
 * @throws {CliError} with the usage code for a wrong command line; with the failure code when the manifest cannot be
 *   read.
 */
export async function runPluginCheck(args: readonly string[], context: CommandContext, running: VersionOutput = versions()): Promise<CommandResult> {
  if (args.length !== 1 || args[0]!.startsWith('-')) throw new CliError(EXIT.usage, `delorun plugin check: ${USAGE}`)
  const directory = resolve(args[0]!)
  const manifest = await readManifest(directory)
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : '(no name)'
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '(no version)'
  const lines = [
    `${name}@${version}, read from ${join(directory, 'package.json')}; none of its files ran.`,
    `This is Delo ${running.delo} on DSH ${running.dsh}.`,
  ]
  let verdict: string
  let exit: CommandResult
  try {
    const engines = manifest['engines'] ?? {}
    if (isObject(engines)) lines.push(...dshLines(engines, manifest, running.dsh), deloLine(engines, running.delo))
    else lines.push('engines is not an object, so neither axis can be read.')
    const issue = evaluatePluginCompatibility(manifest, {}, running.dsh, running.delo)
    verdict = issue === undefined ? 'The installer admits it on this release.' : `The installer refuses it on this release: ${pluginCompatibilityWarning(issue)}`
    exit = issue === undefined ? EXIT.ok : EXIT.failed
  } catch (error) {
    verdict = `The installer refuses it: ${messageOf(error)}.`
    exit = EXIT.failed
  }
  lines.push(verdict, 'Within one Delo minor the DSH version stays the same; contract C21 states what each Delo version promises a plugin.')
  context.stdout(`${lines.join('\n')}\n`)
  return exit
}
