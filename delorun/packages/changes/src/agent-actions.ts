/**
 * The agent's `plugin_manager` actions that ran with protection off, recorded in Changes (contract C21, "The agent's
 * plugin actions with protection off"). With protection off the tool runs as upstream's does once the person's single
 * full-access approval is given, and each action that changed the profile is a logged change, applied and decided
 * `unreviewed`: an install, an update or a removal with the spec the agent passed, and every other action (a turn-on or
 * turn-off, a setting, a version exemption, an undo, a restore) as `plugin-setting-change`. Each entry carries the
 * profile history version upstream wrote for the action and the version the profile held before it, so the person lists,
 * shows and undoes it like any other change.
 *
 * Undoing one brings back the profile's files as the version before the action held them, with the history restore
 * `delorun recover` uses ([profile safety](@delorun/profile-safety)), then installs the restored dependency set as
 * upstream's restore does (`install --ignore-scripts`, then `rebuild --pending`) through the plugin operation the person's
 * Apply of an agent request runs. It is refused unless the profile's files are still as the action left them, so a later
 * change is undone first.
 *
 * @module @delorun/changes/agent-actions
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { applyRestore, latestVersion, openHistory, planRestore } from '@delorun/profile-safety'
import { locked, recordVersion, timeOf } from './action-support.ts'
import type { ActionResult, ChangesContext, ReloadHost } from './actions.ts'
import { changeId } from './ids.ts'
import { classifyPluginRequest, isPluginRequest, type PluginOperation } from './install-actions.ts'
import { PACKAGE_NAME_PATTERN } from './paths.ts'
import { ChangesError } from './errors.ts'
import { decisionOf, findEntry, readChangeLog, requirePresence, withEntry, withoutDecision, writeChangeLog, type AtComputer } from './records.ts'
import type { ChangeEntry, ChangeKind, ChangeSubject } from './types.ts'

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
 * The words that name an action's target.
 * @param target - the call's target.
 * @returns the target, or `the profile` for none.
 */
function named(target: string | undefined): string {
  return target === undefined || target.trim() === '' ? 'the profile' : target.trim()
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
 * Read what a call will be recorded as, before it runs.
 * @param ctx - the profile.
 * @param call - the call.
 * @returns the plan, with the history version the profile holds now.
 * @throws {Error} when the profile's history cannot be read.
 */
export async function planAgentAction(ctx: Pick<ChangesContext, 'profileDir'>, call: AgentCall): Promise<AgentActionPlan> {
  const history = openHistory({ profileDir: ctx.profileDir })
  return { ...await classifyAction(ctx, call), before: await latestVersion(history) }
}

/**
 * Record an agent's action that ran, if it changed the profile: an applied change decided `unreviewed` carrying the
 * history version upstream wrote and the version before it. Nothing is recorded when the profile's history did not move.
 * @param ctx - the profile.
 * @param plan - what {@link planAgentAction} read before the action.
 * @returns the entry, or undefined when the action changed nothing.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the change log cannot be read.
 * @throws {Error} when the profile's history or the log cannot be read or written; the action has run, so the caller reports it unrecorded.
 */
export async function recordAgentAction(ctx: ChangesContext, plan: AgentActionPlan): Promise<ChangeEntry | undefined> {
  return locked(ctx, async () => {
    const after = await latestVersion(openHistory({ profileDir: ctx.profileDir }))
    if (after === undefined || after === plan.before) return undefined
    const log = await readChangeLog(ctx.home, ctx.profile)
    const at = timeOf(ctx)
    for (let occurrence = 0; ; occurrence += 1) {
      const id = changeId(plan.kind, plan.subject, undefined, undefined, occurrence)
      if (findEntry(log, id) !== undefined) continue
      const entry: ChangeEntry = {
        id,
        kind: plan.kind,
        state: 'applied',
        subject: plan.subject,
        summary: plan.summary,
        createdAt: at,
        ...decisionOf(at, 'unreviewed'),
        historyVersion: after,
        ...plan.before === undefined ? {} : { historyBefore: plan.before },
      }
      await writeChangeLog(ctx.home, ctx.profile, withEntry(log, entry))
      return entry
    }
  })
}

/** What undoing an agent's action is given. */
export interface AgentUndoOptions {
  /** Reloads the running Host. */
  readonly reload: ReloadHost
  /** Runs upstream's plugin operation, as the person's Apply of an agent request does. */
  readonly run: PluginOperation
}

/**
 * Bring the profile's files back as one version held them, and install that version's dependency set.
 * @param ctx - the profile.
 * @param version - the history version to bring back.
 * @param run - the plugin operation.
 * @returns nothing when it worked, otherwise why it did not.
 */
async function restoreTo(ctx: ChangesContext, version: ProfileVersionId, run: PluginOperation): Promise<string | undefined> {
  const request = { profileDir: ctx.profileDir, homeDir: ctx.home, version }
  const plan = await planRestore(request)
  await applyRestore(plan, request)
  if (!plan.lockfileChanged) return undefined
  const installed = await run(['install', '--ignore-scripts'])
  if (installed.exitCode !== 0) return installed.failure ?? installed.output ?? 'pnpm install failed'
  const built = await run(['rebuild', '--pending'])
  return built.exitCode === 0 ? undefined : built.failure ?? built.output ?? 'pnpm rebuild failed'
}

/**
 * Undo an agent's action: the profile goes back to the version before it, the Host reloads, and the change is `undone`.
 * A failed install or reload puts the profile back as the action left it, and the change stays applied with the failure.
 * @param ctx - the profile.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload and the plugin operation.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `UNKNOWN_CHANGE` for an id the
 *   log does not hold; `NOT_ALLOWED` for a change that is not an applied agent action, one with no earlier version, or one
 *   a later profile change follows; `OPERATION_FAILED` when the restored dependencies could not be installed.
 */
export async function undoAgentAction(ctx: ChangesContext, id: ChangeEntry['id'], presence: AtComputer, options: AgentUndoOptions): Promise<ActionResult> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const log = await readChangeLog(ctx.home, ctx.profile)
    const entry = findEntry(log, id)
    if (entry === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `No applied change has the id ${id}. See the changes: delorun changes list`)
    if (!isAgentAction(entry)) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is not an action the agent ran with protection off.`)
    if (entry.state !== 'applied') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so there is nothing to undo.`)
    if (entry.historyVersion === undefined || entry.historyBefore === undefined) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} has no earlier profile version to go back to. Restore one with delorun recover.`)
    const asLeft = await planRestore({ profileDir: ctx.profileDir, homeDir: ctx.home, version: brandString<ProfileVersionId>(entry.historyVersion) })
    if (asLeft.writes.length > 0) throw new ChangesError('NOT_ALLOWED', id, `The profile changed after change ${id}; undo the later change first, or restore a profile version with delorun recover.`)
    const failure = await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyBefore), options.run)
    if (failure !== undefined) {
      await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyVersion), options.run)
      throw new ChangesError('OPERATION_FAILED', id, `Change ${id} was not undone: ${failure}`)
    }
    const at = timeOf(ctx)
    const recorded = await recordVersion(ctx, `Undid: ${entry.summary}`)
    const undone: ChangeEntry = { ...withoutDecision(entry), state: 'undone', ...decisionOf(at, presence) }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(log, undone))
    const outcome = await options.reload()
    if (outcome === undefined) return { entry: undone, ...recorded, reload: { kind: 'not-running' } }
    if (outcome.ok) return { entry: undone, ...recorded, reload: { kind: 'reloaded' } }
    const back = await restoreTo(ctx, brandString<ProfileVersionId>(entry.historyVersion), options.run)
    const wentBack = await recordVersion(ctx, `Went back: undoing ${entry.summary} failed to load`)
    const failed: ChangeEntry = { ...entry, lastFailure: { at: timeOf(ctx), failure: back === undefined ? outcome.error : `${outcome.error} (and the earlier version could not be installed again: ${back})` } }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(log, failed))
    const again = await options.reload()
    return { entry: failed, ...recorded, reload: { kind: 'went-back', failure: outcome.error, ...wentBack, ...again === undefined ? {} : { again } } }
  })
}
