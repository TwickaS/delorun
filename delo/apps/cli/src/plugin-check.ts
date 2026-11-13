/**
 * `delorun plugin check <directory>` (contract C17, "Checking a plugin before it is installed"; contract C22): what a
 * plugin's declared version ranges admit against the release that runs. It reads the plugin's `package.json` as JSON,
 * imports and runs none of its files, and decides both axes with `@delo/update`'s `evaluatePluginAxes`, which is
 * upstream's `evaluatePluginCompatibility` and `evaluateDeloRequirement`, the evaluation the installer, the start's
 * preflight and the update report run, with no exemption. It prints, for each axis, what is
 * declared and whether this release meets it, what is undeclared, and the range that targets the running Delo minor.
 *
 * @module @delo/cli/plugin-check
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from '@deepseek-ai/dsh-app-boot'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { messageOf } from '@delo/install'
import { targetRange } from '@delo/plugin-scaffold'
import { evaluatePluginAxes, type AxisDecision } from '@delo/update'
import semver from 'semver'
import { CliError, EXIT } from './exit.ts'
import type { CommandContext, CommandResult } from './command.ts'
import { printable } from './terminal-text.ts'
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
 * Read a regular file of at most `limit` bytes without following a symbolic link or waiting on a FIFO: the file is
 * opened with `O_NOFOLLOW` and `O_NONBLOCK`, must be a regular file by the descriptor's own `fstat`, and at most
 * `limit + 1` bytes are read, so a link to a device, a FIFO or an endless file cannot hang the command or exhaust its
 * memory.
 * @param path - the file.
 * @param limit - the largest size accepted.
 * @returns the file's text.
 * @throws {Error} when the file is a link, not a regular file, larger than the limit, or cannot be read.
 */
export async function readRegularFile(path: string, limit: number): Promise<string> {
  // Windows defines neither O_NOFOLLOW nor O_NONBLOCK; an undefined flag ORs as 0, and the fstat below still refuses
  // anything but a regular file there.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('it is not a regular file')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > limit) throw new Error(`it has more than ${String(limit)} bytes, the limit`)
    }
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Read a plugin's manifest without importing anything.
 * @param directory - the plugin's directory.
 * @param command - the command that reads it, for the refusal; `delorun plugin check` by default.
 * @returns the parsed `package.json`.
 * @throws {CliError} when the file is missing, a link, not a regular file, larger than {@link PLUGIN_MANIFEST_LIMIT}, not
 *   JSON or not an object.
 */
export async function readPluginManifest(directory: string, command = 'delorun plugin check'): Promise<Record<string, unknown>> {
  const path = join(directory, 'package.json')
  let text: string
  try {
    text = await readRegularFile(path, PLUGIN_MANIFEST_LIMIT)
  } catch (error) {
    throw new CliError(EXIT.failed, `${command}: ${printable(path)} cannot be read: ${printable(messageOf(error))}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new CliError(EXIT.failed, `${command}: ${printable(path)} is not JSON: ${printable(messageOf(error))}`)
  }
  if (!isObject(value)) throw new CliError(EXIT.failed, `${command}: ${printable(path)} is not a package manifest object`)
  return value
}

/**
 * What a manifest declares on the DSH axis, for the line that says it is met: `engines.dsh`, or its DSH peers.
 * @param manifest - the plugin's manifest.
 * @returns the declaration as the line names it.
 */
function dshDeclaration(manifest: Readonly<Record<string, unknown>>): string {
  const engines = manifest['engines']
  if (isObject(engines) && typeof engines['dsh'] === 'string') return `engines.dsh "${engines['dsh']}"`
  // Called only for a met axis: without engines.dsh it was met by peers, which upstream read as an object of ranges.
  const peers = Object.entries(manifest['peerDependencies'] as Readonly<Record<string, string>>)
  return `its DSH peers (${peers.filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')).map(([name, range]) => `${name} "${range}"`).join(', ')})`
}

/**
 * The line about the upstream axis.
 * @param decision - the axis's decision.
 * @param manifest - the plugin's manifest, for what it declares.
 * @param dsh - the running DSH version.
 * @returns the line.
 */
function dshLine(decision: AxisDecision, manifest: Readonly<Record<string, unknown>>, dsh: string): string {
  switch (decision.kind) {
    case 'compatible':
      return `DSH axis: ${dshDeclaration(manifest)} admits DSH ${dsh}; without engines.dsh every DSH peer must admit it, and engines.dsh alone decides when it is declared.`
    case 'undeclared':
    case 'none':
      return `DSH axis: undeclared, so the plugin loads on any DSH. Declare "engines": { "dsh": "^${dsh}" }, or the range you test against, to state it.`
    case 'unreadable':
      return 'DSH axis: engines.dsh or a DSH peer is declared in a form Delo cannot read.'
    case 'unmet':
    case 'exempted':
    case 'not-carried':
      return `DSH axis: it requires DSH ${decision.requirement}, which DSH ${dsh} does not meet.`
  }
}

/**
 * The line about the Delo axis.
 * @param decision - the axis's decision.
 * @param delo - the running Delo version.
 * @returns the line.
 */
function deloLine(decision: AxisDecision, delo: string): string {
  switch (decision.kind) {
    case 'none':
    case 'undeclared':
      return `Delo axis: undeclared, so the plugin loads on any Delo and Delo promises it nothing. To target Delorun ${delo} and its patches, declare "engines": { "delo": "${targetRange(delo)}" }.`
    case 'unreadable':
      return `Delo axis: engines.delo is declared in a form Delo cannot read, so Delo refuses the plugin. Declare a range such as "${targetRange(delo)}".`
    case 'compatible':
      return `Delo axis: engines.delo admits Delo ${delo}.`
    case 'unmet':
    case 'exempted':
    case 'not-carried':
      return `Delo axis: engines.delo "${decision.requirement}" does not admit Delo ${delo}.`
  }
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
  const manifest = await readPluginManifest(directory)
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : '(no name)'
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '(no version)'
  const lines = [
    `${name}@${version}, read from ${join(directory, 'package.json')}; none of its files ran.`,
    `This is Delo ${running.delo} on DSH ${running.dsh}.`,
  ]
  const axes = { from: running.dsh, to: running.dsh }
  const decisions = evaluatePluginAxes(manifest, { dsh: axes, delo: { from: running.delo, to: running.delo } }, { dsh: {}, delo: {} }, `${name}@${version}`)
  lines.push(dshLine(decisions.dsh, manifest, running.dsh), deloLine(decisions.delo, running.delo))
  let verdict: string
  let exit: CommandResult
  try {
    const issue = evaluatePluginCompatibility(manifest, {}, running.dsh, running.delo)
    verdict = issue === undefined ? 'The installer admits it on this release.' : `The installer refuses it on this release: ${pluginCompatibilityWarning(issue)}`
    exit = issue === undefined ? EXIT.ok : EXIT.failed
  } catch (error) {
    verdict = `The installer refuses it: ${messageOf(error)}.`
    exit = EXIT.failed
  }
  lines.push(verdict, 'Within one Delo minor the DSH version stays the same; contract C22 states what each Delo version promises a plugin.')
  // Every line can carry the manifest's own strings, so each is printed with the characters a terminal acts on escaped.
  context.stdout(`${lines.map(printable).join('\n')}\n`)
  return exit
}
