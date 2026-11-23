/**
 * The plugin install check where `delorun` runs it: around `delorun plugin`'s package operations, at each start before
 * the Host boots, and in `delorun verify`. The check itself is `@delorun/plugin-install-check`'s; this module reads its
 * settings from the profile's composed `delorun-plugin-install-check` row, so the switch and settings a person changes in
 * the profile's `cordis.patch.yml` hold for the CLI as for the Host, prints what it found, and sets the row's
 * `npmMirror` for `delorun plugin mirror on|off`.
 *
 * An operation that installs packages runs in three steps: pnpm resolves it into the profile's lockfile only, the check
 * reads that lockfile, and only then pnpm installs the lockfile and runs the build scripts the profile allows, after
 * which each checked plugin is recorded. Every finding is printed and none stops the command, except a known critical
 * advisory and a check that cannot run: `delorun plugin` then puts the profile's `package.json` and lockfile back as they
 * were, so nothing was fetched into the profile and no script ran, and exits 1. A refused advisory names
 * `--allow-advisory <id>`, which installs it anyway. The checks never stop a start; a plugin whose installed files differ
 * from its record is a warning at every start until it is reinstalled or removed.
 *
 * @module @delorun/cli/plugin-install-check
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { Config, installationNames, resolveSettings } from '@delorun/plugin-install-check'
import { checkProfileTrust, forgetRemoved, LockfileError, reconcileProfile, recordInstalled, type InstallCheckSettings, type InstallFinding, type PackageCheck, type PendingRecord, type PluginTrustStatus } from '@delorun/plugin-install-check/check'
import type { CommandOutput } from './command.ts'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { setPatchRow } from '@delorun/setup-apply'
import { composedRow, isRecord, patchLayers } from './patch-layers.ts'
import { printable } from './terminal-text.ts'

/** The row that carries the check's switch and settings. */
export const INSTALL_CHECK_ROW = 'delorun-plugin-install-check'

/** A GHSA id, as `--allow-advisory` takes it. */
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u

/** The check's settings for a profile, and the names its installation carries. */
export interface ProfileCheckSettings {
  readonly settings: InstallCheckSettings
  readonly knownNames: ReadonlySet<string>
}

/**
 * The check's settings for a profile, from its composed `delorun-plugin-install-check` row.
 * @param home - the Delorun home.
 * @param profileDir - the profile directory.
 * @param installAnchor - the installation's `package.json`, as upstream's profile boot names it.
 * @returns the settings, or `undefined` when the profile has no such row or the row is disabled or switched off.
 * @throws {CliError} when the row's settings do not validate, naming the row and the reason.
 */
export function profileCheckSettings(home: string, profileDir: string, installAnchor: string): ProfileCheckSettings | undefined {
  if (!existsSync(join(profileDir, 'package.json'))) return undefined
  const profile = loadProfileDirectory('delorun', profileDir, installAnchor)
  const row = composedRow(patchLayers(home, profile, []), INSTALL_CHECK_ROW)
  if (row === undefined || row.disabled === true) return undefined
  let config: Config
  try {
    // The schema validates every field the patch gives before anything reads it.
    config = Config(isRecord(row.config) ? row.config as Partial<Config> : {})
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun: the ${INSTALL_CHECK_ROW} row of the profile ${profile.name} has settings that do not validate: ${error instanceof Error ? error.message : String(error)}; fix them in ${profile.patchPath}`)
  }
  if (!config.enabled) return undefined
  return { settings: resolveSettings(config), knownNames: installationNames(installAnchor) }
}

/**
 * Take `--allow-advisory <id>` and `--allow-advisory=<id>` out of `delorun plugin`'s arguments.
 * @param args - the arguments after `plugin`.
 * @returns the allowed GHSA ids and the arguments upstream receives.
 * @throws {CliError} `EXIT.usage` when a value is missing or not a GHSA id.
 */
export function takeAllowedAdvisories(args: readonly string[]): { readonly allowed: readonly string[], readonly rest: readonly string[] } {
  const allowed: string[] = []
  const rest: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--') {
      rest.push(...args.slice(index))
      break
    }
    let value: string | undefined
    if (argument === '--allow-advisory') value = args[++index]
    else if (argument.startsWith('--allow-advisory=')) value = argument.slice('--allow-advisory='.length)
    else {
      rest.push(argument)
      continue
    }
    if (value === undefined || !GHSA.test(value)) throw new CliError(EXIT.usage, `delorun plugin: --allow-advisory takes a GitHub advisory id such as GHSA-xxxx-xxxx-xxxx${value === undefined ? '' : `, not ${JSON.stringify(printable(value))}`}`)
    allowed.push(value)
  }
  return { allowed, rest }
}

/**
 * One finding as a line.
 * @param finding - the finding.
 * @returns the line, without control characters.
 */
function findingLine(finding: InstallFinding): string {
  return `  ${finding.severity}: ${printable(finding.title)}${finding.line > 0 ? ` (${finding.path}:${String(finding.line)})` : ''}\n`
}

/**
 * Print one plugin's check.
 * @param output - where to print.
 * @param name - the plugin.
 * @param check - the check.
 */
function printCheck(output: CommandOutput, name: string, check: PackageCheck): void {
  if (check.kind === 'skipped') return
  const subject = check.kind === 'checked' && check.version !== undefined ? `${printable(name)} ${printable(check.version)}` : printable(name)
  if (check.kind === 'checked' && (check.blocking.length > 0 || check.refused.length > 0)) {
    // Only an advisory can be allowed from the command line.
    const ids = check.blocking.flatMap(finding => finding.advisory === undefined ? [] : [finding.advisory])
    const allowable = check.refused.length === 0 && ids.length === check.blocking.length
    output.stderr(`delorun: refused ${subject}: ${check.refused.length > 0 ? 'its integrity differs from the primary registry\'s' : allowable ? 'a known critical advisory affects it' : 'a critical finding affects it'}, so it was not installed:\n`)
    for (const finding of check.findings) output.stderr(findingLine(finding))
    if (allowable) output.stderr(`  To install it anyway, run the same command with ${ids.map(id => `--allow-advisory ${id}`).join(' ')}\n`)
    return
  }
  if (check.findings.length === 0) {
    output.stderr(`delorun: checked ${subject}: no warnings\n`)
    return
  }
  output.stderr(`delorun: checked ${subject}: ${String(check.findings.length)} ${check.findings.length === 1 ? 'warning' : 'warnings'}, which you should read before you use it:\n`)
  for (const finding of check.findings) output.stderr(findingLine(finding))
}

/** What the check of a resolved package operation found. */
export interface ResolvedCheck {
  /** The plugins refused for a critical finding. */
  readonly refused: readonly string[]
  /** Whether the check could not run, which refuses the installation; the cause is printed. */
  readonly checkFailed: boolean
  /** What to record of each plugin that passed, once it is installed and built. */
  readonly pending: readonly PendingRecord[]
}

/**
 * Check every plugin a resolved package operation adds or changes in the profile's lockfile, before anything is
 * installed, print every finding, and remove the records of removed plugins. A check that throws for any reason refuses
 * the installation: no advisory id allows it, and its cause is printed.
 * @param request - the profile directory, its settings, the allowed advisories, the registries the operation asks and
 *   the output.
 * @returns the refused plugins and what to record of the others; `checkFailed` set when the check could not run.
 */
export async function checkResolved(request: { readonly profileDir: string, readonly check: ProfileCheckSettings, readonly allowedAdvisories: readonly string[], readonly registries: readonly string[], readonly output: CommandOutput }): Promise<ResolvedCheck> {
  let result
  try {
    result = await reconcileProfile({ profileDir: request.profileDir, allowedAdvisories: request.allowedAdvisories, knownNames: request.check.knownNames, registries: request.registries, now: Date.now, compareFiles: false }, request.check.settings)
  } catch (error) {
    request.output.stderr(`delorun: the plugins this command installs could not be checked, so they are refused: ${printable(error instanceof Error ? error.message : String(error))}. Fix the cause, then run the command again.\n`)
    return { refused: [], checkFailed: true, pending: [] }
  }
  for (const { name, check } of result.checked) printCheck(request.output, name, check)
  return {
    refused: result.checked.flatMap(({ name, check }) => check.kind === 'checked' && (check.blocking.length > 0 || check.refused.length > 0) ? [name] : []),
    checkFailed: false,
    pending: result.checked.flatMap(({ check }) => check.kind === 'checked' && check.pending !== undefined ? [check.pending] : []),
  }
}

/**
 * Record each checked plugin once the operation installed it and ran its builds. A record that cannot be written is
 * printed as a warning: the plugin stays installed and reads as unrecorded.
 * @param profileDir - the profile directory.
 * @param pending - what the check left to record.
 * @param maxFiles - the most files recorded per package.
 * @param output - where a warning goes.
 */
export async function recordAfterInstall(profileDir: string, pending: readonly PendingRecord[], maxFiles: number, output: CommandOutput): Promise<void> {
  for (const each of pending) {
    try {
      await recordInstalled(profileDir, each, { now: Date.now, maxFiles })
    } catch (error) {
      output.stderr(`delorun: warning: ${printable(each.name)} is installed, but its files were not recorded, so changes to it cannot be detected: ${printable(error instanceof Error ? error.message : String(error))}\n`)
    }
  }
}

/**
 * Remove the records of the plugins an operation removed; a lockfile that does not read leaves them, as a warning.
 * @param profileDir - the profile directory.
 * @param output - where a warning goes.
 */
export async function forgetRemovedPlugins(profileDir: string, output: CommandOutput): Promise<void> {
  try {
    await forgetRemoved(profileDir)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    output.stderr(`delorun: warning: the install records were not brought up to date: ${printable(error.message)}\n`)
  }
}

/** The pnpm commands that only read the profile or the registry, which `delorun plugin` runs without the install check. */
const READ_ONLY = new Set(['ls', 'list', 'll', 'la', 'why', 'outdated', 'view', 'info', 'show', 'help', 'root', 'bin', 'licenses'])

/** The options that print pnpm's usage or version and change nothing. */
const USAGE_OR_VERSION = new Set(['--version', '-v', '--help', '-h'])

/** pnpm's options that take their value as the next argument; `--name=value` carries its value inside the argument. */
const VALUE_OPTIONS = new Set(['--registry', '--loglevel', '-C', '--dir', '--filter', '-F', '--reporter', '--workspace-dir', '--store-dir', '--config'])

/**
 * The arguments pnpm runs: the arguments after `plugin` without `--profile`, which upstream's parser takes first.
 * @param args - the arguments after `plugin`.
 * @returns the arguments without `--profile` and its value.
 */
function pnpmArguments(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--profile') index++
    else if (!args[index]!.startsWith('--profile=')) kept.push(args[index]!)
  }
  return kept
}

/**
 * The index of pnpm's command word: its first argument that is neither an option nor the value of one of
 * {@link VALUE_OPTIONS}. An option without `=` that is not in that list, and `--`, make the command unknown: pnpm may
 * take the next argument as that option's value (`--prefix` does).
 * @param args - pnpm's arguments.
 * @returns the index, or `undefined` when there is no command word or it cannot be told apart from an option's value.
 */
function commandIndexOf(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (VALUE_OPTIONS.has(argument)) index++
    else if (!argument.startsWith('-')) return index
    else if (!argument.includes('=')) return undefined
  }
  return undefined
}

/**
 * The pnpm command word of `delorun plugin`'s arguments.
 * @param args - the arguments after `plugin`, without `--allow-advisory`.
 * @returns the command word, or `undefined` when there is none or it cannot be told apart from an option's value.
 */
export function pnpmCommand(args: readonly string[]): string | undefined {
  const pnpm = pnpmArguments(args)
  const index = commandIndexOf(pnpm)
  return index === undefined ? undefined : pnpm[index]
}

/**
 * Whether `delorun plugin`'s arguments may change the profile's packages or lockfile, so the install check runs before
 * anything is installed. Exempt are the read-only commands, `audit` without `--fix`, `config get` and `config list`, and
 * no arguments or arguments that ask only for usage or version output, which pnpm answers without changing anything.
 * Every other argument list is checked: an unknown command, `--`, an option whose value cannot be told apart from the
 * command, and each command that installs or changes packages.
 * @param args - the arguments after `plugin`, without `--allow-advisory`.
 * @returns true unless the arguments are exempt.
 */
export function installsPackages(args: readonly string[]): boolean {
  const pnpm = pnpmArguments(args)
  if (pnpm.every(argument => USAGE_OR_VERSION.has(argument))) return false
  const index = commandIndexOf(pnpm)
  if (index === undefined) return true
  const command = pnpm[index]!
  if (READ_ONLY.has(command)) return false
  if (command === 'audit') return pnpm.some(argument => argument === '--fix' || argument.startsWith('--fix='))
  if (command === 'config') return !['get', 'list'].includes(pnpm[index + 1] ?? '')
  return true
}

/**
 * The arguments with `--profile <profile>` first when they name no profile, which upstream's parser requires and
 * `delorun` defaults.
 * @param args - the arguments after `plugin`.
 * @param profile - the profile `delorun` selected.
 * @returns the arguments upstream receives.
 */
export function withProfile(args: readonly string[], profile: string): string[] {
  return args.some(argument => argument === '--profile' || argument.startsWith('--profile=')) ? [...args] : ['--profile', profile, ...args]
}

/** The pnpm words for removing a package; `pnpm remove` takes no `--ignore-scripts` option, only the `ignore-scripts` setting. */
const REMOVE_COMMANDS = new Set(['remove', 'rm', 'uninstall', 'un'])

/**
 * The arguments that resolve an installing operation into the lockfile without installing anything or running any
 * script: pnpm runs an approved git dependency's `prepare` while it resolves unless scripts are ignored. `pnpm remove`
 * rejects the `--ignore-scripts` option, so a removal gets the same protection as the `ignore-scripts` setting.
 * @param args - the arguments after `plugin`.
 * @returns them with `--lockfile-only` and the script-ignoring flag added and `--frozen-lockfile` removed.
 */
export function resolveOnly(args: readonly string[]): string[] {
  const kept = args.filter(argument => argument !== '--frozen-lockfile')
  const ignoreScripts = REMOVE_COMMANDS.has(pnpmCommand(kept) ?? '') ? '--config.ignore-scripts=true' : '--ignore-scripts'
  return [...kept, ...['--lockfile-only', ignoreScripts].filter(flag => !kept.includes(flag))]
}

/**
 * The registry URLs an operation names, which the check compares with the registries pnpm reads.
 * @param args - the arguments after `plugin`.
 * @returns the URLs, in argument order.
 */
export function registryUrls(args: readonly string[]): string[] {
  const urls: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const prefixed = ['--registry=', '--config.registry='].find(prefix => argument.startsWith(prefix))
    if (prefixed !== undefined) urls.push(argument.slice(prefixed.length))
    else if (argument === '--registry' && args[index + 1] !== undefined) {
      urls.push(args[index + 1]!)
      index++
    }
  }
  return urls
}

/** The flags that restrict what pnpm fetches or runs; `--ignore-scripts` keeps the install scripts from running. */
const RESTRICTING_FLAGS = new Set(['--ignore-scripts', '--offline', '--prefer-offline'])

/** The options that take their value as the next argument and restrict or report what pnpm does. */
const RESTRICTING_VALUE_OPTIONS = new Set(['--registry', '--loglevel', '--reporter'])

/** The prefixes of the options that carry their value inside the argument, or are `--config.*` settings. */
const RESTRICTING_INLINE = ['--registry=', '--loglevel=', '--reporter=', '--config.']

/**
 * The options every step of an operation repeats: the flags that restrict what pnpm fetches or runs, the registry, the
 * `--config.*` settings, and the options that set how it reports. The installation step runs the install scripts, so it
 * takes them too. The options that choose which project pnpm acts on are not repeated.
 * @param args - the arguments after `plugin`.
 * @returns the options in argument order, each with its separate value.
 */
export function carriedOptions(args: readonly string[]): string[] {
  const carried: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--') break
    if (RESTRICTING_FLAGS.has(argument) || RESTRICTING_INLINE.some(prefix => argument.startsWith(prefix))) carried.push(argument)
    else if (RESTRICTING_VALUE_OPTIONS.has(argument) && args[index + 1] !== undefined) {
      carried.push(argument, args[index + 1]!)
      index++
    }
  }
  return carried
}

/**
 * Turn the npm mirror on or off for a profile: write the `delorun-plugin-install-check` row's composed settings with
 * `npmMirror` into the profile's own `cordis.patch.yml`. The plugin manager asks the mirror from the next start.
 * @param home - the Delorun home.
 * @param profileDir - the profile directory.
 * @param installAnchor - the installation's `package.json`.
 * @param on - the setting.
 * @throws {CliError} when the profile has no such row, or its settings hold an expression this cannot restate.
 */
export function setNpmMirror(home: string, profileDir: string, installAnchor: string, on: boolean): void {
  if (!existsSync(join(profileDir, 'package.json'))) throw new CliError(EXIT.failed, `delorun plugin mirror: ${profileDir} holds no profile; run delorun setup first`)
  const profile = loadProfileDirectory('delorun', profileDir, installAnchor)
  const row = composedRow(patchLayers(home, profile, []), INSTALL_CHECK_ROW)
  if (row === undefined) throw new CliError(EXIT.failed, `delorun plugin mirror: the profile ${profile.name} has no ${INSTALL_CHECK_ROW} row, which holds the setting; it does not load Delorun's bundle`)
  const config = isRecord(row.config) ? row.config : {}
  if (!Object.values(config).every(isPlainValue)) throw new CliError(EXIT.failed, `delorun plugin mirror: the ${INSTALL_CHECK_ROW} row in ${profile.patchPath} sets a value with an expression; set npmMirror: ${String(on)} there by hand`)
  setPatchRow(profile.patchPath, { id: INSTALL_CHECK_ROW, config: { ...config, npmMirror: on } })
}

/**
 * Whether a value is plain YAML data: a string, number, boolean, null, or an array or record of them.
 * @param value - the value.
 * @returns true when it is.
 */
function isPlainValue(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isPlainValue)
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isPlainValue)
}

/** The `delorun plugin mirror` usage line. */
const MIRROR_USAGE = 'usage: delorun plugin mirror [--profile <name>] on|off'

/**
 * Run `delorun plugin mirror on|off`.
 * @param args - the arguments after `mirror`.
 * @param request - the home, the profile, its directory, the installation anchor and the output.
 * @returns {@link EXIT.ok}.
 * @throws {CliError} `EXIT.usage` without exactly `on` or `off`; see {@link setNpmMirror}.
 */
export function runMirror(args: readonly string[], request: { readonly home: string, readonly profile: string, readonly profileDir: string, readonly installAnchor: string, readonly output: CommandOutput }): ExitCode {
  const words = args.filter((argument, index) => argument !== '--profile' && args[index - 1] !== '--profile' && !argument.startsWith('--profile='))
  const value = words.length === 1 ? words[0] : undefined
  if (value !== 'on' && value !== 'off') throw new CliError(EXIT.usage, MIRROR_USAGE)
  setNpmMirror(request.home, request.profileDir, request.installAnchor, value === 'on')
  request.output.stdout(value === 'on'
    ? `The npm mirror is on for the profile ${request.profile}: plugin installs ask registry.npmmirror.com when the first registry cannot be reached or lacks the package. It applies from the next start.\n`
    : `The npm mirror is off for the profile ${request.profile}: plugin installs ask only the first registry. It applies from the next start.\n`)
  return EXIT.ok
}

/**
 * Print what a change check found: one warning per changed plugin, and one line for plugins without a record.
 * @param output - where to print.
 * @param profile - the profile's name.
 * @param status - the check's result.
 */
export function printTrust(output: CommandOutput, profile: string, status: PluginTrustStatus): void {
  if (status.problem !== undefined) output.stderr(`delorun: warning: the installed plugins of the profile ${profile} were not checked for changes: ${printable(status.problem)}\n`)
  for (const plugin of status.plugins.filter(each => each.state === 'changed')) {
    output.stderr(`delorun: warning: ${String(plugin.changedCount)} ${plugin.changedCount === 1 ? 'file' : 'files'} of the plugin ${printable(plugin.name)} in the profile ${profile} changed since it was installed, such as ${printable(plugin.changedFiles[0] ?? '')}. If you did not change it, reinstall it with: delorun plugin --profile ${profile} add ${printable(plugin.name)}@${printable(plugin.version ?? '')}\n`)
  }
  const unrecorded = status.plugins.filter(each => each.state === 'unrecorded')
  if (unrecorded.length > 0) {
    output.stderr(`delorun: ${String(unrecorded.length)} ${unrecorded.length === 1 ? 'plugin' : 'plugins'} of the profile ${profile} (${unrecorded.map(each => printable(each.name)).join(', ')}) ${unrecorded.length === 1 ? 'has' : 'have'} no install record, so changes to ${unrecorded.length === 1 ? 'it' : 'them'} cannot be detected; reinstalling records ${unrecorded.length === 1 ? 'it' : 'them'}\n`)
  }
}

/**
 * Compare a profile's installed plugins with their records, write its trust status and print what changed. A failure
 * of the check is printed and stops nothing.
 * @param request - the home, the profile, its directory, the installation anchor, the depth and the output.
 * @returns the status, or `undefined` when the check is off or could not run.
 */
export async function checkInstalledPlugins(request: { readonly home: string, readonly profile: string, readonly profileDir: string, readonly installAnchor: string, readonly full: boolean, readonly output: CommandOutput }): Promise<PluginTrustStatus | undefined> {
  try {
    const check = profileCheckSettings(request.home, request.profileDir, request.installAnchor)
    if (check === undefined) return undefined
    const status = await checkProfileTrust(request.profileDir, { full: request.full, now: Date.now, maxFiles: check.settings.maxFiles })
    printTrust(request.output, request.profile, status)
    return status
  } catch (error) {
    request.output.stderr(`delorun: warning: the installed plugins of the profile ${request.profile} could not be checked for changes: ${printable(error instanceof Error ? error.message : String(error))}\n`)
    return undefined
  }
}
