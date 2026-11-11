/**
 * The plugin install check where `delorun` runs it: after `delorun plugin` changes a profile's packages, at each start
 * before the Host boots, and in `delorun verify`. The check itself is `@delo/plugin-install-check`'s; this module reads
 * its settings from the profile's composed `delo-plugin-install-check` row, so the switch and settings a person changes
 * in the profile's `cordis.patch.yml` hold for the CLI as for the Host, and prints what it found.
 *
 * Every finding is printed and none stops the command, except a known critical advisory: `delorun plugin` then puts the
 * profile's `package.json` and lockfile back as they were before the command, installs them again, and exits 1 naming
 * the advisory and `--allow-advisory <id>`, which installs it anyway. The checks never stop a start; a plugin whose
 * installed files differ from its record is a warning at every start until it is reinstalled or removed.
 *
 * @module @delo/cli/plugin-install-check
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { Config, installationNames, resolveSettings } from '@delo/plugin-install-check'
import { checkProfileTrust, LockfileError, reconcileProfile, type InstallCheckSettings, type InstallFinding, type PackageCheck, type PluginTrustStatus } from '@delo/plugin-install-check/check'
import type { CommandOutput } from './command.ts'
import { CliError, EXIT } from './exit.ts'
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

/** What the check after a package operation found. */
export interface InstallCheckOutcome {
  /** The plugins refused for a known critical advisory. */
  readonly refused: readonly string[]
}

/**
 * Check every plugin a package operation installed or changed, print each finding, and remove the records of removed
 * plugins.
 * @param request - the profile directory, its settings, the allowed advisories and the output.
 * @returns the refused plugins; none when the profile's lockfile does not read, which is printed as a warning.
 */
export async function checkAfterOperation(request: { readonly profileDir: string, readonly check: ProfileCheckSettings, readonly allowedAdvisories: readonly string[], readonly output: CommandOutput }): Promise<InstallCheckOutcome> {
  let result
  try {
    result = await reconcileProfile({ profileDir: request.profileDir, allowedAdvisories: request.allowedAdvisories, knownNames: request.check.knownNames, now: Date.now }, request.check.settings)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    request.output.stderr(`delorun: warning: the plugins this command installed were not checked: ${printable(error.message)}\n`)
    return { refused: [] }
  }
  for (const { name, check } of result.checked) printCheck(request.output, name, check)
  return { refused: result.checked.flatMap(({ name, check }) => check.kind === 'checked' && check.blocking.length > 0 ? [name] : []) }
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
