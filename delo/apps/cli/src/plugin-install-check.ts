/**
 * The plugin install check where `delorun` runs it: around `delorun plugin`'s package operations, at each start before
 * the Host boots, and in `delorun verify`. The check itself is `@delo/plugin-install-check`'s; this module reads its
 * settings from the profile's composed `delo-plugin-install-check` row, so the switch and settings a person changes in
 * the profile's `cordis.patch.yml` hold for the CLI as for the Host, prints what it found, and sets the row's
 * `npmMirror` for `delorun plugin mirror on|off`.
 *
 * An operation that installs packages runs in three steps: pnpm resolves it into the profile's lockfile only, the check
 * reads that lockfile, and only then pnpm installs the lockfile and runs the build scripts the profile allows, after
 * which each checked plugin is recorded. Every finding is printed and none stops the command, except a known critical
 * advisory: `delorun plugin` then puts the profile's `package.json` and lockfile back as they were, so nothing was
 * fetched into the profile and no script ran, and exits 1 naming `--allow-advisory <id>`, which installs it anyway. The
 * checks never stop a start; a plugin whose installed files differ from its record is a warning at every start until it
 * is reinstalled or removed.
 *
 * @module @delo/cli/plugin-install-check
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { Config, installationNames, resolveSettings } from '@delo/plugin-install-check'
import { checkProfileTrust, forgetRemoved, LockfileError, reconcileProfile, recordInstalled, type InstallCheckSettings, type InstallFinding, type PackageCheck, type PendingRecord, type PluginTrustStatus } from '@delo/plugin-install-check/check'
import type { CommandOutput } from './command.ts'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { setPatchRow } from './setup/writes.ts'
import { composedRow, isRecord, patchLayers } from './patch-layers.ts'
import { printable } from './terminal-text.ts'

/** The row that carries the check's switch and settings. */
export const INSTALL_CHECK_ROW = 'delo-plugin-install-check'

/** A GHSA id, as `--allow-advisory` takes it. */
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u

/** The check's settings for a profile, and the names its installation carries. */
export interface ProfileCheckSettings {
  readonly settings: InstallCheckSettings
  readonly knownNames: ReadonlySet<string>
}

/**
 * The check's settings for a profile, from its composed `delo-plugin-install-check` row.
 * @param home - the Delo home.
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
  if (check.kind === 'checked' && check.blocking.length > 0) {
    output.stderr(`delorun: refused ${subject}: a known critical advisory affects it, so it was not installed:\n`)
    for (const finding of check.findings) output.stderr(findingLine(finding))
    output.stderr(`  To install it anyway, run the same command with ${check.blocking.map(finding => `--allow-advisory ${finding.advisory ?? ''}`).join(' ')}\n`)
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
  /** The plugins refused for a known critical advisory. */
  readonly refused: readonly string[]
  /** What to record of each plugin that passed, once it is installed and built. */
  readonly pending: readonly PendingRecord[]
}

/**
 * Check every plugin a resolved package operation adds or changes in the profile's lockfile, before anything is
 * installed, print every finding, and remove the records of removed plugins.
 * @param request - the profile directory, its settings, the allowed advisories, the registries the operation asks and
 *   the output.
 * @returns the refused plugins and what to record of the others; none when the profile's lockfile does not read,
 *   which is printed as a warning.
 */
export async function checkResolved(request: { readonly profileDir: string, readonly check: ProfileCheckSettings, readonly allowedAdvisories: readonly string[], readonly registries: readonly string[], readonly output: CommandOutput }): Promise<ResolvedCheck> {
  let result
  try {
    result = await reconcileProfile({ profileDir: request.profileDir, allowedAdvisories: request.allowedAdvisories, knownNames: request.check.knownNames, registries: request.registries, now: Date.now, compareFiles: false }, request.check.settings)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    request.output.stderr(`delorun: warning: the plugins this command installs were not checked: ${printable(error.message)}\n`)
    return { refused: [], pending: [] }
  }
  for (const { name, check } of result.checked) printCheck(request.output, name, check)
  return {
    refused: result.checked.flatMap(({ name, check }) => check.kind === 'checked' && check.blocking.length > 0 ? [name] : []),
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

/** The pnpm commands that install packages, which `delorun plugin` checks between resolving and installing. */
const INSTALLING = new Set(['add', 'install', 'i', 'update', 'up', 'upgrade'])

/**
 * The pnpm command an argument list runs: its first argument that is neither an option nor `--profile`'s value.
 * @param args - the arguments after `plugin`.
 * @returns the command, or `undefined`.
 */
function pnpmCommandOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--') return undefined
    if (argument === '--profile') { index++; continue }
    if (!argument.startsWith('-')) return argument
  }
  return undefined
}

/**
 * Whether `delorun plugin`'s arguments run a pnpm command that installs packages.
 * @param args - the arguments after `plugin`, without `--allow-advisory`.
 * @returns true for `add`, `install`, `update` and their aliases, unless the person already asked for the lockfile only.
 */
export function installsPackages(args: readonly string[]): boolean {
  const command = pnpmCommandOf(args)
  return command !== undefined && INSTALLING.has(command) && !args.includes('--lockfile-only')
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

/**
 * The arguments that resolve an installing operation into the lockfile without installing anything.
 * @param args - the arguments after `plugin`.
 * @returns them with `--lockfile-only` added and `--frozen-lockfile` removed.
 */
export function resolveOnly(args: readonly string[]): string[] {
  return [...args.filter(argument => argument !== '--frozen-lockfile'), '--lockfile-only']
}

/**
 * The registry options an operation names, which its installation step repeats and the check compares.
 * @param args - the arguments after `plugin`.
 * @returns the options as given, and the URLs they name.
 */
export function registryOptions(args: readonly string[]): { readonly options: readonly string[], readonly urls: readonly string[] } {
  const options: string[] = []
  const urls: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const prefixed = ['--registry=', '--config.registry='].find(prefix => argument.startsWith(prefix))
    if (prefixed !== undefined) {
      options.push(argument)
      urls.push(argument.slice(prefixed.length))
    } else if (argument === '--registry' && args[index + 1] !== undefined) {
      options.push(argument, args[index + 1]!)
      urls.push(args[index + 1]!)
      index++
    }
  }
  return { options, urls }
}

/**
 * Turn the npm mirror on or off for a profile: write the `delo-plugin-install-check` row's composed settings with
 * `npmMirror` into the profile's own `cordis.patch.yml`. The plugin manager asks the mirror from the next start.
 * @param home - the Delo home.
 * @param profileDir - the profile directory.
 * @param installAnchor - the installation's `package.json`.
 * @param on - the setting.
 * @throws {CliError} when the profile has no such row, or its settings hold an expression this cannot restate.
 */
export function setNpmMirror(home: string, profileDir: string, installAnchor: string, on: boolean): void {
  if (!existsSync(join(profileDir, 'package.json'))) throw new CliError(EXIT.failed, `delorun plugin mirror: ${profileDir} holds no profile; run delorun setup first`)
  const profile = loadProfileDirectory('delorun', profileDir, installAnchor)
  const row = composedRow(patchLayers(home, profile, []), INSTALL_CHECK_ROW)
  if (row === undefined) throw new CliError(EXIT.failed, `delorun plugin mirror: the profile ${profile.name} has no ${INSTALL_CHECK_ROW} row, which holds the setting; it does not load Delo's bundle`)
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
