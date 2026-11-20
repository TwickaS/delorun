/**
 * The agent's `plugin_manager` actions that ran with protection off, recorded in Changes (contract C21, "The agent's
 * plugin actions with protection off"). With protection off the tool runs as upstream's does once the person's single
 * full-access approval is given, and each action that changed the profile is a logged change, applied and decided
 * `unreviewed`: an install, an update or a removal with the spec the agent passed, and every other action (a turn-on or
 * turn-off, a setting, a version exemption, an undo, a restore) as `plugin-setting-change`. The entries live in the
 * profile's agent-action log ([AgentLog](./types.ts)), a file of their own that a release without this feature never
 * reads, so going back to one still starts the profile; Changes lists and undoes them with the change log's entries.
 *
 * Recording is in two steps around the tool. {@link beginAgentAction} writes the entry before the tool runs, so a plugin
 * the action loads, or a Host that stops while it loads, never goes unrecorded: the entry then says Delorun did not see how
 * the action ended. {@link finishAgentAction} completes it with the profile history version upstream wrote and the
 * version before it, or removes it when the action changed nothing. The history is not a source to rebuild an entry from:
 * upstream saves the version after the load, so a crash in the load leaves no version.
 *
 * Undoing one brings back the files plugin management writes as the version before the action held them, and nothing
 * else: the home patch, Delorun's safety record and the update report keep what they hold now, the plugins the safety
 * record keeps disabled stay disabled, and an edit the person made by hand before the action, which upstream saves as a
 * version of its own, stays. It then installs the restored dependency set as upstream's restore does
 * (`install --ignore-scripts`, then `rebuild --pending`) through the plugin operation the person's Apply of an agent
 * request runs, under the profile write lock. It is refused unless the files plugin management writes are still as the
 * action left them, so a later change is undone first.
 *
 * @module @delorun/changes/agent-actions
 */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProfileVersion, ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { applyRestore, currentFiles, latestVersion, MANAGER_FILES, openHistory, planRestore, readSafetyRecord } from '@delorun/profile-safety'
import { locked, recordVersion, timeOf } from './action-support.ts'
import type { ActionResult, ChangesContext, ReloadHost } from './actions.ts'
import { changeId } from './ids.ts'
import { classifyPluginRequest, isPluginRequest, type PluginOperation } from './install-actions.ts'
import { PACKAGE_NAME_PATTERN } from './paths.ts'
import { ChangesError } from './errors.ts'
import { decisionOf, readAgentLog, readChangeLog, requirePresence, withoutDecision, writeAgentLog, type AtComputer } from './records.ts'
import type { AgentLog, ChangeEntry, ChangeId, ChangeKind, ChangeSubject } from './types.ts'

/** How many of the newest history versions {@link finishAgentAction} reads to find what an action wrote. */
const HISTORY_WINDOW = 50

/** The longest target, in characters, a summary quotes. */
const TARGET_SHOWN_CHARACTERS = 60

/** A target made of the characters of a package name, a plugin id or a version id, which a summary quotes as it is. */
const PLAIN_TARGET = /^[\w@.~:/-]+$/u

/** What the agent called `plugin_manager` with, as far as recording it needs. */
export interface AgentCall {
  /** The tool's `action`. */
  readonly action: string
  /** The tool's `target`, when it is a string. */
  readonly target?: string
  /** The tool's `enabled`, when it is the boolean. */
  readonly enabled?: boolean
}

/** What one agent action is recorded as, decided before the action runs, while the profile still shows what it changes. */
export interface AgentActionPlan {
  readonly kind: ChangeKind
  readonly subject: ChangeSubject
  readonly summary: string
  /** The profile's latest history version before the action; undefined before the history has one. */
  readonly before: string | undefined
  /** A digest of the files plugin management writes before the action, to tell whether the action changed them. */
  readonly files: string
}

/**
 * Whether a log entry records an agent's action that ran with protection off.
 * @param entry - a log entry.
 * @returns true for `plugin-setting-change`, and for an applied install, update or removal that names a spec and was decided `unreviewed`.
 */
export function isAgentAction(entry: Pick<ChangeEntry, 'kind' | 'subject' | 'decidedFrom'>): boolean {
  return entry.kind === 'plugin-setting-change' || (isPluginRequest(entry) && entry.decidedFrom === 'unreviewed')
}

/**
 * The words that name an action's target: a package name, a plugin id or a version id as it is, anything else quoted on one line and cut.
 * @param target - the call's target.
 * @returns the words, `the profile` for no target.
 */
function named(target: string | undefined): string {
  const text = target?.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (text === undefined || text === '') return 'the profile'
  if (PLAIN_TARGET.test(text) && text.length <= TARGET_SHOWN_CHARACTERS) return text
  return JSON.stringify(text.length <= TARGET_SHOWN_CHARACTERS ? text : `${text.slice(0, TARGET_SHOWN_CHARACTERS)}…`)
}

/**
 * Decide what an action is recorded as. An install or removal is classified as a request the person would review is, so
 * the entry reads the same either way; a call the classification refuses still goes to upstream, which gives its own
 * refusal, and is recorded as a setting change if it changed the profile.
 * @param ctx - the profile.
 * @param call - the call.
 * @returns the kind, subject and summary.
 */
async function classifyAction(ctx: Pick<ChangesContext, 'profileDir'>, call: AgentCall): Promise<Pick<AgentActionPlan, 'kind' | 'subject' | 'summary'>> {
  const target = call.target?.trim()
  if ((call.action === 'install_bundle' || call.action === 'remove_bundle') && target !== undefined && target !== '') {
    try {
      const { kind, subject, summary } = await classifyPluginRequest(ctx.profileDir, { action: call.action === 'install_bundle' ? 'install' : 'remove', spec: target })
      return { kind, subject, summary: summary.replace('The agent asks to ', 'The agent ran: ') }
    } catch {
      // A spec or a removal Delorun does not classify still ran in upstream's tool; it is recorded below as a setting change if the profile changed.
    }
  }
  const plugin = target !== undefined && PACKAGE_NAME_PATTERN.test(target) ? { plugin: target } : {}
  const switched = call.enabled === undefined ? '' : call.enabled ? 'turned on' : 'turned off'
  const words = (call.action === 'set_bundle' || call.action === 'set_plugin') && switched !== '' ? `The agent ${switched} ${named(target)}` : `The agent ran ${call.action} on ${named(target)}`
  return { kind: 'plugin-setting-change', subject: { ...plugin, setting: call.action }, summary: words }
}

/**
 * @param profileDir - the profile directory.
 * @returns a digest of the files plugin management writes, as they are now.
 */
function managerFilesDigest(profileDir: string): string {
  const files = currentFiles(profileDir)
  const hash = createHash('sha256')
  for (const name of MANAGER_FILES) hash.update(`${name}\0${files.get(name) ?? '\0absent'}\0`)
  return hash.digest('hex')
}

/**
 * Read what a call will be recorded as, before it runs, and check that both change logs can be read and written.
 * @param ctx - the profile.
 * @param call - the call.
 * @returns the plan, with the history version the profile holds now.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the change log or the agent-action log cannot be read.
 * @throws {Error} when the profile's history cannot be read.
 */
export async function planAgentAction(ctx: Pick<ChangesContext, 'home' | 'profile' | 'profileDir'>, call: AgentCall): Promise<AgentActionPlan> {
  await readChangeLog(ctx.home, ctx.profile)
  await readAgentLog(ctx.home, ctx.profile)
  const history = openHistory({ profileDir: ctx.profileDir })
  return { ...await classifyAction(ctx, call), before: await latestVersion(history), files: managerFilesDigest(ctx.profileDir) }
}

/**
 * @param log - the agent-action log.
 * @param entry - an entry.
 * @returns the log with the entry in place of the one with its id, or appended when none has it.
 */
function withAgentEntry(log: AgentLog, entry: ChangeEntry): AgentLog {
  const at = log.entries.findIndex(existing => existing.id === entry.id)
  return { ...log, entries: at < 0 ? [...log.entries, entry] : log.entries.with(at, entry) }
}

/**
 * @param log - the agent-action log.
 * @param id - a change id.
 * @returns the entry with the id, or undefined.
 */
export function findAgentEntry(log: AgentLog, id: ChangeId): ChangeEntry | undefined {
  return log.entries.find(entry => entry.id === id)
}

/** What an entry says until the action's end is known. */
const UNFINISHED_SUFFIX = '; Delorun did not see how it ended, so check what it changed with delorun changes list and delorun recover'

/**
 * Record an agent's action before the tool runs: an applied change decided `unreviewed` that says Delorun has not seen how
 * the action ended. {@link finishAgentAction} completes or removes it. The caller denies the call when this throws, so no
 * action runs unrecorded.
 * @param ctx - the profile.
 * @param plan - what {@link planAgentAction} read.
 * @returns the entry's id.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a log cannot be read.
 * @throws {Error} when the agent-action log cannot be written.
 */
export async function beginAgentAction(ctx: ChangesContext, plan: AgentActionPlan): Promise<ChangeId> {
  return locked(ctx, async () => {
    const log = await readChangeLog(ctx.home, ctx.profile)
    const agent = await readAgentLog(ctx.home, ctx.profile)
    const at = timeOf(ctx)
    for (let occurrence = 0; ; occurrence += 1) {
      const id = changeId(plan.kind, plan.subject, undefined, undefined, occurrence)
      if (log.entries.some(entry => entry.id === id) || findAgentEntry(agent, id) !== undefined) continue
      const entry: ChangeEntry = { id, kind: plan.kind, state: 'applied', subject: plan.subject, summary: `${plan.summary}${UNFINISHED_SUFFIX}`, createdAt: at, ...decisionOf(at, 'unreviewed') }
      await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, entry))
      return id
    }
  })
}

/** How an agent's action ended, as {@link finishAgentAction} found it. */
export interface FinishedAgentAction {
  /** The entry as it now stands; undefined when the action changed nothing and its entry was removed. */
  readonly entry?: ChangeEntry
  /** True when the action changed the files plugin management writes but the profile history holds no version of it: it is recorded, and cannot be undone. */
  readonly unsaved: boolean
}

/**
 * Complete an agent's action after the tool ran. The history versions upstream wrote since the action began say what it
 * did. One agent version: the entry carries it and the version before it, so undo brings the earlier profile back, unless
 * a version of another author lies between the two, which an undo would bring back with the rest. No agent version and
 * the files unchanged: the action changed nothing, and the entry is removed. No agent version and the files changed:
 * the version could not be saved; the entry stays without one. Several agent versions, as when two chats act at once:
 * the entry stays without one, because which version is whose cannot be told.
 * @param ctx - the profile.
 * @param plan - what {@link planAgentAction} read.
 * @param id - what {@link beginAgentAction} returned.
 * @returns how the action ended.
 * @throws {ChangesError} `RECORD_UNREADABLE` when a log cannot be read; `UNKNOWN_CHANGE` when the entry is gone.
 * @throws {Error} when the history or the agent-action log cannot be read or written; the action has run, so the caller reports it.
 */
export async function finishAgentAction(ctx: ChangesContext, plan: AgentActionPlan, id: ChangeId): Promise<FinishedAgentAction> {
  return locked(ctx, async () => {
    const agent = await readAgentLog(ctx.home, ctx.profile)
    const entry = findAgentEntry(agent, id)
    if (entry === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `The record of the agent's action ${id} is gone from the agent-action log.`)
    const listed = await openHistory({ profileDir: ctx.profileDir }).list(HISTORY_WINDOW)
    const boundary = plan.before === undefined ? -1 : listed.findIndex(version => version.id === plan.before)
    const fresh = plan.before === undefined || boundary < 0 ? listed : listed.slice(0, boundary)
    const agents = fresh.filter(version => version.changedBy.kind === 'agent')
    const finished: ChangeEntry = { ...entry, summary: plan.summary }
    if (agents.length === 0) {
      if (managerFilesDigest(ctx.profileDir) === plan.files) {
        await writeAgentLog(ctx.home, ctx.profile, { ...agent, entries: agent.entries.filter(candidate => candidate.id !== id) })
        return { unsaved: false }
      }
      await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, finished))
      return { entry: finished, unsaved: true }
    }
    const [version, ...others] = agents
    if (others.length > 0 || version === undefined) {
      await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, finished))
      return { entry: finished, unsaved: false }
    }
    const before = versionBefore(fresh, version, plan.before)
    const recorded: ChangeEntry = { ...finished, historyVersion: version.id, ...before === undefined ? {} : { historyBefore: before } }
    await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, recorded))
    return { entry: recorded, unsaved: false }
  })
}

/**
 * The version an undo of an agent's version brings back: the one just before it, which is the person's own earlier edit
 * when they made one, so the edit stays.
 * @param fresh - the versions written since the action began, newest first.
 * @param version - the agent's version in it.
 * @param before - the version that was latest before the action began.
 * @returns the version just before it; undefined when none exists or a version of another author than the manager's
 *   own recording of an outside edit lies between them.
 */
function versionBefore(fresh: readonly ProfileVersion[], version: ProfileVersion, before: string | undefined): ProfileVersionId | undefined {
  const older = fresh.slice(fresh.indexOf(version) + 1)
  if (older.some(candidate => candidate.changedBy.kind !== 'outside')) return undefined
  return older[0]?.id ?? (before === undefined ? undefined : brandString<ProfileVersionId>(before))
}

/** What undoing an agent's action is given. */
export interface AgentUndoOptions {
  /** Reloads the running Host. */
  readonly reload: ReloadHost
  /** Runs upstream's plugin operation, as the person's Apply of an agent request does. */
  readonly run: PluginOperation
}

/**
 * Bring the files plugin management writes back as one version held them, keep the plugins the safety record keeps
 * disabled disabled, and install that version's dependency set. The caller holds the profile's write lock.
 * @param ctx - the profile.
 * @param version - the history version to bring back.
 * @param run - the plugin operation.
 * @returns nothing when it worked, otherwise why it did not.
 */
async function restoreTo(ctx: ChangesContext, version: ProfileVersionId, run: PluginOperation): Promise<string | undefined> {
  const request = { profileDir: ctx.profileDir, homeDir: ctx.home, version, scope: 'manager' as const, revoked: readSafetyRecord(ctx.profileDir).disabled }
  const plan = await planRestore(request)
  await applyRestore(plan, request)
  if (!plan.lockfileChanged) return undefined
  const installed = await run(['install', '--ignore-scripts'])
  if (installed.exitCode !== 0) return installed.failure ?? installed.output ?? 'pnpm install failed'
  const built = await run(['rebuild', '--pending'])
  return built.exitCode === 0 ? undefined : built.failure ?? built.output ?? 'pnpm rebuild failed'
}

/**
 * Undo an agent's action: the files plugin management writes go back to the version before it, the Host reloads, and the
 * change is `undone`. A failed install or reload puts them back as the action left them, and the change stays applied with
 * the failure.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload and the plugin operation.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `UNKNOWN_CHANGE` for an id the
 *   agent-action log does not hold; `NOT_ALLOWED` for a change that is not applied, one with no earlier version, or one
 *   a later profile change follows; `OPERATION_FAILED` when the restored dependencies could not be installed.
 */
export async function undoAgentAction(ctx: ChangesContext, id: ChangeId, presence: AtComputer, options: AgentUndoOptions): Promise<ActionResult> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const agent = await readAgentLog(ctx.home, ctx.profile)
    const entry = findAgentEntry(agent, id)
    if (entry === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `No applied change has the id ${id}. See the changes: delorun changes list`)
    if (entry.state !== 'applied') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so there is nothing to undo.`)
    if (entry.historyVersion === undefined || entry.historyBefore === undefined) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} has no earlier profile version to go back to. Restore one with delorun recover.`)
    const asLeft = await planRestore({ profileDir: ctx.profileDir, homeDir: ctx.home, version: brandString<ProfileVersionId>(entry.historyVersion), scope: 'manager' })
    if (asLeft.writes.length > 0) throw new ChangesError('NOT_ALLOWED', id, `The profile changed after change ${id}; undo the later change first, or restore a profile version with delorun recover.`)
    const failure = await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyBefore), options.run)
    if (failure !== undefined) {
      await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyVersion), options.run)
      throw new ChangesError('OPERATION_FAILED', id, `Change ${id} was not undone: ${failure}`)
    }
    const at = timeOf(ctx)
    const recorded = await recordVersion(ctx, `Undid: ${entry.summary}`)
    const undone: ChangeEntry = { ...withoutDecision(entry), state: 'undone', ...decisionOf(at, presence) }
    await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, undone))
    const outcome = await options.reload()
    if (outcome === undefined) return { entry: undone, ...recorded, reload: { kind: 'not-running' } }
    if (outcome.ok) return { entry: undone, ...recorded, reload: { kind: 'reloaded' } }
    const back = await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyVersion), options.run)
    const wentBack = await recordVersion(ctx, `Went back: undoing ${entry.summary} failed to load`)
    const failed: ChangeEntry = { ...entry, lastFailure: { at: timeOf(ctx), failure: back === undefined ? outcome.error : `${outcome.error} (and the earlier version could not be installed again: ${back})` } }
    await writeAgentLog(ctx.home, ctx.profile, withAgentEntry(agent, failed))
    const again = await options.reload()
    return { entry: failed, ...recorded, reload: { kind: 'went-back', failure: outcome.error, ...wentBack, ...again === undefined ? {} : { again } } }
  })
}
