/**
 * The `changes` lines of `delorun doctor` (contract C21, "What verify and doctor report"): the protection setting, the
 * work session and the last failed reload in one (`run/<profile>/changes-work.json`), one line per plugin under Changes (whether it loaded at the last start, whether its active content is
 * the approved one, the `engines.dsh` and `engines.delorun` its active `package.json` declares, and what it registers that
 * changes a consent, a guard or the sandbox policy), the cause of a failed start or load named with the newest applied
 * change of the plugin, each change a failed start left out with its plugin and failure, each pending change and each
 * invariant that does not hold; and for the runtime this `delorun` runs from the store, the person's changes to the
 * harness itself: its approved files, its writable copy, the changes waiting there and the composed tree a start runs.
 *
 * A plugin that did not load or waits for review is `warn`, and so is a change left out at start; an invariant that does
 * not hold is `fail`. The protection setting is a `pass` line in either setting: off is the default, and a plugin whose
 * content loaded without review says so on its line. Nothing is
 * written: the consent check reads the active content from the store. Every message is escaped for the terminal, and a failure message a plugin or
 * a record carries is cut at a line's length ([terminal text](../terminal-text.ts)).
 *
 * @module @delorun/cli/doctor/changes
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  activeDirectory,
  BUILT_IN_CHECKS,
  changesStatus,
  compareVersions,
  harnessStatus,
  leftOutFact,
  isChangesError,
  readVersion,
  reviewChange,
  reviewInputOf,
  riskLines,
  compareCodeUnits,
  type ActiveContent,
  type ChangesStatus,
  type ContentVersion,
  type HarnessStatus,
  type PluginStatus,
} from '@delorun/changes'
import { resolveDelorunHome } from '@delorun/home'
import { outputLogger, quietOutput, verifiedSignedRuntime } from '../changes/harness-start.ts'
import { runtimeOfFile, type RunningRuntime } from '../update/runtime.ts'
import { isCarriedPackage } from '../changes/start.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { clipped, printable } from '../terminal-text.ts'
import { PROTECTION_WORDS } from '../verify/changes.ts'
import type { CheckResult, CheckStatus } from './checks.ts'

/** The built-in check whose findings `doctor` reports for each plugin's active content. */
export const CONSENT_CHECK_ID = 'built-in:consent-guard-sandbox'

/** The version requirements `doctor` reads from a plugin's `engines`. */
const ENGINES = ['dsh', 'delorun'] as const

/** What each kind of active content means, as the line says it. */
const CONTENT_WORDS: Readonly<Record<ActiveContent['kind'], string>> = {
  'approved': 'it runs the content you approved',
  'work-session': 'it runs its folder in your work session',
  'left-out': 'it runs the content from before a change a failed start left out',
}

/**
 * @param text - text of one or more lines.
 * @returns it as one line.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/gu, ' ')
}

/**
 * @param text - a failure message a plugin or a record carries.
 * @returns it as one line, escaped and cut at a line's length.
 */
function quotedFailure(text: string): string {
  return clipped(oneLine(text))
}

/**
 * @param status - the verdict.
 * @param message - the text, made one line with every character a terminal acts on escaped.
 * @returns the `changes` result.
 */
function line(status: CheckStatus, message: string): CheckResult {
  return { name: 'changes', status, message: printable(oneLine(message)) }
}

/**
 * @param error - a thrown value.
 * @returns its words for the person: a Changes failure's detail, otherwise the error as text, cut at a line's length.
 */
function reasonOf(error: unknown): string {
  return quotedFailure(isChangesError(error) ? error.detail : String(error))
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
  return declared.length === 0 ? 'it declares no dsh or delorun version requirement' : `it requires ${declared.join(' and ')}`
}

/**
 * What a plugin's active content registers that changes a consent, a guard or the sandbox policy: the built-in check
 * run over every file of the content as added.
 * @param home - the Delorun home.
 * @param version - the plugin's active content.
 * @returns the clause.
 */
async function registrations(home: string, version: ContentVersion): Promise<string> {
  const checks = BUILT_IN_CHECKS.filter(candidate => candidate.id === CONSENT_CHECK_ID)
  try {
    const manifest = await readVersion(home, version)
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
  return entry.loaded ? { failed: false, words: 'it loaded at the last start' } : { failed: true, words: `it did not load at the last start (${quotedFailure(String(entry.error))})` }
}

/**
 * @param status - the report.
 * @param plugin - one plugin under Changes.
 * @returns the clause on what its active directory holds.
 */
function contentWords(status: ChangesStatus, plugin: PluginStatus): string {
  if (plugin.active?.kind === 'left-out' && plugin.active.version === undefined) return 'nothing of it runs, because a failed start left out the change that added it or turned it on'
  const unreviewed = status.unreviewed.find(candidate => candidate.plugin === plugin.plugin)
  if (plugin.active?.kind === 'approved' && unreviewed !== undefined) return `it runs content that loaded without review (${unreviewed.id})`
  if (plugin.active !== undefined) return CONTENT_WORDS[plugin.active.kind]
  return plugin.approved === undefined ? 'nothing of it runs until you review it' : 'no content of it is recorded as running'
}

/**
 * The line for one plugin under Changes.
 * @param home - the Delorun home.
 * @param profile - the profile.
 * @param status - the report.
 * @param plugin - the plugin.
 * @returns the result.
 */
async function pluginLine(home: string, profile: string, status: ChangesStatus, plugin: PluginStatus): Promise<CheckResult> {
  const load = loadState(status, plugin)
  const parts = [load.words, contentWords(status, plugin)]
  const version = plugin.active?.version
  if (version !== undefined) {
    parts.push(await requirements(activeDirectory(home, profile, plugin.plugin)))
    parts.push(await registrations(home, version))
  }
  // A plugin waiting for review as an install loads nothing by design; its pending line says so.
  const expectedOut = plugin.approved === undefined && plugin.active === undefined
  const warn = load.failed && !expectedOut
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
    const named = withChange.filter(plugin => boot.failure!.includes(plugin.plugin))
    const failure = quotedFailure(boot.failure)
    if (named.length > 0) return named.map(plugin => line('warn', `${plugin.plugin} did not load at the last start: ${failure}. ${changedIn(plugin)}`))
    const [newest] = [...withChange].sort((a, b) => compareCodeUnits(b.lastApplied.at, a.lastApplied.at))
    return [line('warn', `The last start failed: ${failure}.${newest === undefined ? '' : ` The newest change you applied is to ${newest.plugin}. ${changedIn(newest)}`}`)]
  }
  return withChange.flatMap(plugin => {
    const entry = boot.plugins.find(candidate => candidate.plugin === plugin.plugin)
    return entry === undefined || entry.loaded ? [] : [line('warn', `${plugin.plugin} did not load at the last start: ${quotedFailure(String(entry.error))}. ${changedIn(plugin)}`)]
  })
}

/**
 * The `changes` lines for a profile's report.
 * @param home - the Delorun home.
 * @param profile - the profile.
 * @param status - the report.
 * @returns the results, in the order they print.
 */
export async function changesLines(home: string, profile: string, status: ChangesStatus): Promise<CheckResult[]> {
  // A protection record that cannot be read is named by its invariant line.
  const results: CheckResult[] = status.protection === undefined
    ? []
    : [line('pass', `protection is ${status.protection}: ${PROTECTION_WORDS[status.protection]}.`)]
  if (status.workSession !== undefined) {
    const { plugin, startedAt } = status.workSession
    results.push(line('pass', `you are working on ${plugin} since ${startedAt}: edits in its folder load live until delorun changes done ${plugin}.`))
  }
  if (status.workFailure !== undefined) {
    const { plugin, at, error } = status.workFailure
    results.push(line('warn', `the last reload of ${plugin} in a work session failed at ${at}: ${quotedFailure(error)}. Delorun went back to the version of it that last loaded.`))
  }
  if (status.workFailureUnreadable !== undefined) results.push(line('warn', `the record of the last failed reload in a work session cannot be read: ${status.workFailureUnreadable}`))
  for (const plugin of status.plugins) results.push(await pluginLine(home, profile, status, plugin))
  results.push(...causeLines(status))
  for (const { id, plugin, at, failure } of status.leftOut) {
    results.push(line('warn', `${plugin} runs without change ${id}, which a start at ${at} left out because it failed: ${quotedFailure(failure)}. To try it again: delorun changes apply ${id}. To undo it: delorun changes undo ${id}`))
  }
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
 * The `changes` lines about the harness itself: the files whose approved content differs from the signed release's,
 * the writable copy and the changes waiting there, the changes a failed start left out, and the composed tree a start
 * runs. A composed tree that fails its check is `fail`; one not checked, a change waiting and a change left out are
 * `warn`.
 * @param harness - the running runtime's harness.
 * @returns the results.
 */
export function harnessLines(harness: HarnessStatus): CheckResult[] {
  const { runtime, tree } = harness
  const results: CheckResult[] = []
  const reviewed = harness.approved.filter(({ unreviewed }) => !unreviewed)
  const unreviewed = harness.approved.filter(file => file.unreviewed)
  if (reviewed.length > 0) results.push(line('pass', `you approved changes to ${String(reviewed.length)} ${reviewed.length === 1 ? 'file' : 'files'} of Delorun ${runtime} itself: ${reviewed.map(({ file }) => file).join(', ')}.`))
  if (unreviewed.length > 0) results.push(line('pass', `changes to ${String(unreviewed.length)} ${unreviewed.length === 1 ? 'file' : 'files'} of Delorun ${runtime} itself loaded without review while protection was off: ${unreviewed.map(({ file, change }) => `${file} (${change})`).join(', ')}.`))
  if (harness.copy !== undefined) results.push(line('pass', `your copy of Delorun ${runtime} is in ${harness.copy}; delorun changes edit-harness --discard takes every change to Delorun itself back.`))
  for (const change of harness.pending) results.push(line('warn', `Delorun ${runtime} itself: ${change.file} waits for your review: delorun changes show ${change.id}`))
  for (const { id, plugin, at, failure } of harness.leftOut.map(leftOutFact)) {
    results.push(line('warn', `${plugin} runs without change ${id}, which a start at ${at} left out because it failed: ${quotedFailure(failure)}. To try it again: delorun changes apply ${id}. To undo it: delorun changes undo ${id}`))
  }
  switch (tree.kind) {
    case 'signed':
      break
    case 'not-built':
      results.push(line('pass', `Delorun ${runtime} runs your approved changes to it from its next start, from ${tree.directory}.`))
      break
    case 'passed':
      results.push(line('pass', `Delorun ${runtime} runs your approved changes to it from ${tree.directory}, which holds the signed release with exactly those files changed.`))
      break
    case 'failed':
      results.push(line('fail', tree.problem))
      break
    case 'not-checked':
      results.push(line('warn', `${tree.directory} was not checked, because the signed release of Delorun ${runtime} did not verify; see delorun verify.`))
      break
  }
  return results
}

/**
 * The `changes` check: resolve the home, then report Changes for the CLI profile, and the harness of the runtime this
 * `delorun` runs from the store. Nothing is written.
 * @param env - the environment, read for `DELORUN_HOME` and `DSH_HOME`.
 * @param profile - the CLI profile.
 * @param harness - reads the running runtime's harness; undefined outside the runtime store ({@link runningHarnessStatus}
 *   by default).
 * @returns the results.
 */
export async function checkChanges(env: Readonly<Record<string, string | undefined>>, profile: string, harness: (home: string) => Promise<HarnessStatus | undefined> = home => runningHarnessStatus(home, env)): Promise<CheckResult[]> {
  const home = (await resolveDelorunHome(env)).path
  const own = await harness(home)
  const harnessResults = own === undefined ? [] : harnessLines(own)
  if (!hasCliProfile(home, profile)) return [line('pass', `the profile ${profile} is not set up, so there are no changes to check.`), ...harnessResults]
  const status = await changesStatus({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage })
  return [...await changesLines(home, profile, status), ...harnessResults]
}

/**
 * The harness of the runtime this `delorun` runs from the store, its composed tree checked against the signed release.
 * @param home - the Delorun home.
 * @param env - the environment `delorun` was started with, read for the launcher's roots.
 * @param runtime - the runtime this `delorun` runs; this module's by default.
 * @returns the report, or undefined outside the runtime store.
 */
export async function runningHarnessStatus(home: string, env: Readonly<Record<string, string | undefined>>, runtime: RunningRuntime = runtimeOfFile(home, fileURLToPath(import.meta.url))): Promise<HarnessStatus | undefined> {
  if (!runtime.store) return undefined
  const signed = await verifiedSignedRuntime(home, runtime.version, env, outputLogger(quietOutput())).catch((_unverified: unknown) => {
    // An installation that does not verify leaves the tree unchecked, and the line says so; `delorun verify` names why.
    return undefined
  })
  return harnessStatus(home, runtime.version, signed)
}
