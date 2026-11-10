/**
 * The `changes` lines of `delorun doctor` (contract C21, "What verify and doctor report"): the protection setting, the
 * work session and the last failed reload in one (`run/<profile>/changes-work.json`), one line per plugin under Changes (whether it loaded at the last start, whether its active content is
 * the approved one, the `engines.dsh` and `engines.delo` its active `package.json` declares, and what it registers that
 * changes a consent, a guard or the sandbox policy), the cause of a failed start or load named with the newest applied
 * change of the plugin, each pending change and each invariant that does not hold.
 *
 * A plugin that did not load, runs content the person did not approve or waits for review is `warn`; an invariant that
 * does not hold is `fail`. Nothing is written: the consent check reads the active content from the store.
 *
 * @module @delo/cli/doctor/changes
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeDirectory,
  BUILT_IN_CHECKS,
  changesStatus,
  compareVersions,
  isChangesError,
  readVersion,
  reviewChange,
  reviewInputOf,
  riskLines,
  compareCodeUnits,
  type ActiveContent,
  type ChangesStatus,
  type PluginStatus,
  type ProtectionLevel,
} from '@delo/changes'
import { resolveDeloHome } from '@delo/home'
import { isCarriedPackage } from '../changes/start.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import type { CheckResult, CheckStatus } from './checks.ts'

/** The built-in check whose findings `doctor` reports for each plugin's active content. */
export const CONSENT_CHECK_ID = 'built-in:consent-guard-sandbox'

/** The version requirements `doctor` reads from a plugin's `engines`. */
const ENGINES = ['dsh', 'delo'] as const

/** What each protection setting means, as the line says it. */
const PROTECTION_WORDS: Readonly<Record<ProtectionLevel, string>> = {
  block: 'changes you have not approved do not run',
  warn: 'changes you have not approved run, and every start says so',
  off: 'changes you have not approved run without notice',
}

/** What each kind of active content means, as the line says it. */
const CONTENT_WORDS: Readonly<Record<ActiveContent['kind'], string>> = {
  'approved': 'it runs the content you approved',
  'work-session': 'it runs its folder in your work session',
  'unapproved': 'it runs content you have not approved',
}

/**
 * @param status - the verdict.
 * @param message - the text, made one line.
 * @returns the `changes` result.
 */
function line(status: CheckStatus, message: string): CheckResult {
  return { name: 'changes', status, message: message.replace(/\s*\n\s*/gu, ' ') }
}

/**
 * @param error - a thrown value.
 * @returns its words for the person: a Changes failure's detail, otherwise the error as text.
 */
function reasonOf(error: unknown): string {
  return isChangesError(error) ? error.detail : String(error)
}

/**
 * The version requirements an active directory's `package.json` declares.
 * @param directory - the plugin's active directory.
 * @returns the clause.
 */
async function requirements(directory: string): Promise<string> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    return `its package.json does not read (${reasonOf(error)})`
  }
  const engines = (manifest as { engines?: Readonly<Record<string, unknown>> } | null)?.engines
  const declared = ENGINES.flatMap((name) => {
    const range = engines?.[name]
    return typeof range === 'string' ? [`${name} ${range}`] : []
  })
  return declared.length === 0 ? 'it declares no dsh or delo version requirement' : `it requires ${declared.join(' and ')}`
}

/**
 * What a plugin's active content registers that changes a consent, a guard or the sandbox policy: the built-in check
 * run over every file of the content as added.
 * @param home - the Delo home.
 * @param plugin - the plugin, with its active content.
 * @returns the clause.
 */
async function registrations(home: string, plugin: PluginStatus & { readonly active: NonNullable<PluginStatus['active']> }): Promise<string> {
  const checks = BUILT_IN_CHECKS.filter(candidate => candidate.id === CONSENT_CHECK_ID)
  try {
    const manifest = await readVersion(home, plugin.active.version)
    const input = await reviewInputOf(home, undefined, manifest, await compareVersions(home, undefined, manifest))
    const summary = reviewChange(input, checks)
    if (summary.kinds.length === 0) return 'it registers nothing that changes a consent, a guard or the sandbox policy'
    const found = riskLines(summary).slice(1).join('; ')
    return `it ${found.charAt(0).toLowerCase()}${found.slice(1)}`
  } catch (error) {
    return `its content could not be read from the store (${reasonOf(error)})`
  }
}

/**
 * @param status - the report.
 * @param plugin - one plugin under Changes.
 * @returns whether the last start loaded it, and the clause that says so.
 */
function loadState(status: ChangesStatus, plugin: PluginStatus): { readonly failed: boolean, readonly words: string } {
  const { boot } = status
  if (boot === undefined) return { failed: false, words: 'no start has recorded what loaded yet' }
  if (boot.failure !== undefined) return { failed: true, words: 'the last start failed' }
  const entry = boot.plugins.find(candidate => candidate.plugin === plugin.plugin)
  if (entry === undefined) return { failed: false, words: 'it was not under Changes at the last start' }
  return entry.loaded ? { failed: false, words: 'it loaded at the last start' } : { failed: true, words: `it did not load at the last start (${String(entry.error)})` }
}

/**
 * @param plugin - one plugin under Changes.
 * @returns the clause on what its active directory holds.
 */
function contentWords(plugin: PluginStatus): string {
  if (plugin.active !== undefined) return CONTENT_WORDS[plugin.active.kind]
  return plugin.approved === undefined ? 'nothing of it runs until you review it' : 'no content of it is recorded as running'
}

/**
 * The line for one plugin under Changes.
 * @param home - the Delo home.
 * @param profile - the profile.
 * @param status - the report.
 * @param plugin - the plugin.
 * @returns the result.
 */
async function pluginLine(home: string, profile: string, status: ChangesStatus, plugin: PluginStatus): Promise<CheckResult> {
  const load = loadState(status, plugin)
  const parts = [load.words, contentWords(plugin)]
  if (plugin.active !== undefined) {
    parts.push(await requirements(activeDirectory(home, profile, plugin.plugin)))
    parts.push(await registrations(home, { ...plugin, active: plugin.active }))
  }
  // A plugin waiting for review as an install loads nothing by design; its pending line says so.
  const expectedOut = plugin.approved === undefined && plugin.active === undefined
  const warn = (load.failed && !expectedOut) || plugin.active?.kind === 'unapproved'
  return line(warn ? 'warn' : 'pass', `${plugin.plugin} from ${plugin.source}: ${parts.join('; ')}.`)
}

/**
 * @param plugin - a plugin with its newest applied change.
 * @returns the clause naming the change and its undo.
 */
function changedIn(plugin: PluginStatus & { readonly lastApplied: NonNullable<PluginStatus['lastApplied']> }): string {
  const { id, summary } = plugin.lastApplied
  return `It changed in ${id} (${summary}): delorun changes undo ${id}`
}

/**
 * The lines that name the cause of a failed start or a plugin that did not load, with the newest applied change of
 * that plugin.
 * @param status - the report.
 * @returns the results.
 */
function causeLines(status: ChangesStatus): CheckResult[] {
  const { boot } = status
  if (boot === undefined) return []
  const withChange = status.plugins.filter((plugin): plugin is PluginStatus & { lastApplied: NonNullable<PluginStatus['lastApplied']> } => plugin.lastApplied !== undefined)
  if (boot.failure !== undefined) {
    const failure = boot.failure
    const named = withChange.filter(plugin => failure.includes(plugin.plugin))
    if (named.length > 0) return named.map(plugin => line('warn', `${plugin.plugin} did not load at the last start: ${failure}. ${changedIn(plugin)}`))
    const [newest] = [...withChange].sort((a, b) => compareCodeUnits(b.lastApplied.at, a.lastApplied.at))
    return [line('warn', `The last start failed: ${failure}.${newest === undefined ? '' : ` The newest change you applied is to ${newest.plugin}. ${changedIn(newest)}`}`)]
  }
  return withChange.flatMap(plugin => {
    const entry = boot.plugins.find(candidate => candidate.plugin === plugin.plugin)
    return entry === undefined || entry.loaded ? [] : [line('warn', `${plugin.plugin} did not load at the last start: ${String(entry.error)}. ${changedIn(plugin)}`)]
  })
}

/**
 * The `changes` lines for a profile's report.
 * @param home - the Delo home.
 * @param profile - the profile.
 * @param status - the report.
 * @returns the results, in the order they print.
 */
export async function changesLines(home: string, profile: string, status: ChangesStatus): Promise<CheckResult[]> {
  // A protection record that cannot be read is named by its invariant line.
  const results: CheckResult[] = status.protection === undefined ? [] : [line('pass', `protection is set to ${status.protection}: ${PROTECTION_WORDS[status.protection]}.`)]
  if (status.workSession !== undefined) {
    const { plugin, startedAt } = status.workSession
    results.push(line('pass', `you are working on ${plugin} since ${startedAt}: edits in its folder load live until delorun changes done ${plugin}.`))
  }
  if (status.workFailure !== undefined) {
    const { plugin, at, error } = status.workFailure
    results.push(line('warn', `the last reload of ${plugin} in a work session failed at ${at}: ${error}. Delo went back to the version of it that last loaded.`))
  }
  if (status.workFailureUnreadable !== undefined) results.push(line('warn', `the record of the last failed reload in a work session cannot be read: ${status.workFailureUnreadable}`))
  for (const plugin of status.plugins) results.push(await pluginLine(home, profile, status, plugin))
  results.push(...causeLines(status))
  if (status.bootUnreadable !== undefined) results.push(line('warn', `the record of the last start cannot be read: ${status.bootUnreadable}`))
  for (const change of status.pending) {
    const next = change.id === undefined ? 'run delorun changes list' : `delorun changes show ${change.id}`
    results.push(line('warn', change.kind === 'plugin-install'
      ? `${change.plugin} from ${change.source} waits for your review: ${next}`
      : `${change.plugin} has changes in ${change.source} waiting for your review: ${next}`))
  }
  for (const broken of status.invariants) results.push(line('fail', broken))
  return results
}

/**
 * The `changes` check: resolve the home, then report Changes for the CLI profile. Nothing is written.
 * @param env - the environment, read for `DELO_HOME` and `DSH_HOME`.
 * @param profile - the CLI profile.
 * @returns the results.
 */
export async function checkChanges(env: Readonly<Record<string, string | undefined>>, profile: string): Promise<CheckResult[]> {
  const home = (await resolveDeloHome(env)).path
  if (!hasCliProfile(home, profile)) return [line('pass', `the profile ${profile} is not set up, so there are no changes to check.`)]
  const status = await changesStatus({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage })
  return changesLines(home, profile, status)
}
