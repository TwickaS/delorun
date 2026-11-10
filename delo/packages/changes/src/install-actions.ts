/**
 * The agent's plugin requests: with the C16 switch `plugin_changes_pending` on, an agent's `plugin_manager` call that
 * would install, update or remove a plugin runs nothing and records a pending change instead
 * ({@link recordPluginRequest}, the one function `@delo/plugin-changes` calls), and the person applies it at their
 * computer ({@link applyInstallChange}), which runs upstream's plugin operation, the one `delorun plugin` runs, under
 * the profile's write lock.
 *
 * A request whose spec names a folder never links the profile to that folder: applying it links the plugin to its
 * active directory under `changes/`, which holds nothing until the person applies the folder's content, and records
 * that content as a change waiting for review, as a start does for a plugin linked from a folder
 * ([enforce](./enforce.ts)). Nothing the agent asked for therefore loads before the person reviewed its content.
 *
 * @module @delo/changes/install-actions
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from '@deepseek-ai/dsh-plugin-manager/src/install-spec.ts'
import type { ChangesContext, ReloadHost } from './actions.ts'
import { locked, recordVersion, timeOf } from './action-support.ts'
import { holdContent, namesDirectory } from './enforce.ts'
import { ChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { isJsonObject, LINK_PREFIX, LINK_SECTIONS, readProfileManifest, type JsonObject } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory } from './paths.ts'
import { approvedOf, findEntry, PACKAGE_NAME_PATTERN, readApproved, readChangeLog, requirePresence, withEntry, writeApproved, writeChangeLog, type AtComputer } from './records.ts'
import { storeFolder } from './store.ts'
import type { ChangeEntry, ChangeId, ChangeKind, ChangeLog, ChangeSubject } from './types.ts'

/** What the agent asked `plugin_manager` to do: `install_bundle` is `install`, `remove_bundle` is `remove`. */
export interface PluginRequest {
  readonly action: 'install' | 'remove'
  /** The install spec, or the name of the bundle to remove, as the agent passed it. */
  readonly spec: string
}

/** The kinds an agent's plugin request records. */
export type PluginRequestKind = Extract<ChangeKind, 'plugin-install' | 'plugin-update' | 'plugin-remove'>

/** Every {@link PluginRequestKind}. */
const REQUEST_KINDS: ReadonlySet<ChangeKind> = new Set<PluginRequestKind>(['plugin-install', 'plugin-update', 'plugin-remove'])

/**
 * Whether a log entry is an agent's plugin request: an install, update or removal whose subject names a spec. A plugin
 * install computed from a folder names its folder instead.
 * @param entry - a log entry.
 * @returns whether it is one.
 */
export function isPluginRequest(entry: Pick<ChangeEntry, 'kind' | 'subject'>): boolean {
  return REQUEST_KINDS.has(entry.kind) && entry.subject.spec !== undefined
}

/**
 * Upstream's profile plugin operation with these pnpm arguments, run by a caller that already holds the profile's write
 * lock: `runProfilePnpm` of `@deepseek-ai/dsh-plugin-manager/operations`, as `delorun plugin` runs it.
 * @param args - the pnpm arguments, such as `['add', spec]`.
 * @returns the exit code and the path of the operation's diagnostics.
 */
export type PluginOperation = (args: readonly string[]) => Promise<{ readonly exitCode: number, readonly logPath: string }>

/** What applying a plugin request is given. */
export interface InstallApplyOptions {
  /** Reloads the running Host. */
  readonly reload: ReloadHost
  /** Runs upstream's plugin operation. */
  readonly run: PluginOperation
}

/** How the running Host took an applied plugin request. */
export type InstallReload =
  /** Delo is not running for the profile; the next start loads the change. */
  | { readonly kind: 'not-running' }
  /** The running Host loaded the change. */
  | { readonly kind: 'reloaded' }
  /** The running Host failed to load it; the profile keeps the change, which the next start loads. */
  | { readonly kind: 'failed', readonly failure: string }

/** What applying a plugin request did. */
export interface InstallResult {
  /** The request's log entry, applied. */
  readonly entry: ChangeEntry
  /** The profile history version that holds it. */
  readonly historyVersion?: string
  /** For a spec that names a folder: the change that holds the folder's content, waiting for review. */
  readonly folderChange?: ChangeId
  /** How the running Host took it. */
  readonly reload: InstallReload
}

/** What recording one request decides from the spec and the profile's dependencies. */
interface Classified {
  readonly kind: PluginRequestKind
  readonly subject: ChangeSubject
  readonly summary: string
}

/**
 * @param manifest - the profile's manifest.
 * @returns the names of its plugin dependencies, in every section a plugin can be in.
 */
function dependencyNames(manifest: JsonObject): ReadonlySet<string> {
  return new Set(LINK_SECTIONS.flatMap((section) => {
    const entries = manifest[section]
    return isJsonObject(entries) ? Object.keys(entries) : []
  }))
}

/**
 * Read an install spec as pnpm will.
 * @param spec - the spec.
 * @returns its form.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept.
 */
function parsedSpec(spec: string): ParsedInstallSpec {
  try {
    return parseInstallSpec(spec)
  } catch (error) {
    const reason = error instanceof InvalidInstallSpecError ? error.reason : String(error)
    throw new ChangesError('INVALID_REQUEST', spec, `${spec} is not a plugin spec this profile can install: ${reason}.`, { cause: error })
  }
}

/**
 * Decide what a request changes: a removal of a dependency, an update of a registry plugin the profile has, or an
 * install.
 * @param profileDir - the profile's directory.
 * @param request - the request.
 * @returns its kind, subject and summary.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept or a removal of a name that is no
 *   dependency; `RECORD_UNREADABLE` when the profile's manifest cannot be read.
 */
async function classify(profileDir: string, request: PluginRequest): Promise<Classified> {
  const spec = request.spec.trim()
  const dependencies = dependencyNames(await readProfileManifest(profileDir))
  if (request.action === 'remove') {
    if (!dependencies.has(spec)) throw new ChangesError('INVALID_REQUEST', spec, `${spec} is not a plugin of this profile, so there is nothing to remove.`)
    return { kind: 'plugin-remove', subject: { plugin: spec, spec }, summary: `The agent asks to remove ${spec}` }
  }
  const parsed = parsedSpec(spec)
  if (parsed.kind === 'registry' && dependencies.has(parsed.name)) {
    return { kind: 'plugin-update', subject: { plugin: parsed.name, spec }, summary: `The agent asks to move ${parsed.name} to ${spec}` }
  }
  return { kind: 'plugin-install', subject: { ...parsed.kind === 'registry' ? { plugin: parsed.name } : {}, spec }, summary: `The agent asks to install ${spec}` }
}

/**
 * Record an agent's plugin request as a change waiting for the person's review. Nothing the profile runs changes: no
 * manifest, lockfile, `node_modules` or approval is written, only the change log. The same request while it waits keeps
 * its entry and id; a request for a change the person already decided is a new change with a new id.
 * @param ctx - the profile.
 * @param request - what the agent asked.
 * @returns the pending entry.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept or a removal of a name that is no
 *   dependency; `RECORD_UNREADABLE` when the profile's manifest or the change log cannot be read.
 */
export async function recordPluginRequest(ctx: ChangesContext, request: PluginRequest): Promise<ChangeEntry> {
  return locked(ctx, async () => {
    const { kind, subject, summary } = await classify(ctx.profileDir, request)
    const log = await readChangeLog(ctx.home, ctx.profile)
    for (let occurrence = 0; ; occurrence += 1) {
      const id = changeId(kind, subject, undefined, undefined, occurrence)
      const existing = findEntry(log, id)
      if (existing?.state === 'pending') return existing
      if (existing !== undefined) continue
      const entry: ChangeEntry = { id, kind, state: 'pending', subject, summary, createdAt: timeOf(ctx) }
      await writeChangeLog(ctx.home, ctx.profile, withEntry(log, entry))
      return entry
    }
  })
}

/** One request's operation: the pnpm arguments, the log to write once it ran, and what follows it. */
interface Operation {
  readonly args: readonly string[]
  /** The change log with every entry the operation adds before the request's own. */
  readonly log: ChangeLog
  /** Writes what follows a successful operation. */
  readonly after: () => Promise<void>
  /** The change that holds a folder's content. */
  readonly folderChange?: ChangeId
}

/** An operation with nothing after it. */
const NOTHING_AFTER = async (): Promise<void> => {}

/**
 * Read the package name a plugin folder declares.
 * @param folder - the folder.
 * @returns the name.
 * @throws {ChangesError} `INVALID_REQUEST` when its `package.json` cannot be read or names no valid package.
 */
async function folderName(folder: string): Promise<string> {
  let name: unknown
  try {
    name = (JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as { name?: unknown }).name
  } catch (error) {
    throw new ChangesError('INVALID_REQUEST', folder, `The folder ${folder} has no readable package.json: ${String(error)}`, { cause: error })
  }
  if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name)) throw new ChangesError('INVALID_REQUEST', folder, `The package.json in ${folder} names no valid package.`)
  return name
}

/**
 * The operation of a request for a folder: link the plugin to its active directory, and record the folder's content as
 * a change waiting for review unless the plugin is approved already, whose folder the listing compares with its
 * approved content.
 * @param ctx - the profile.
 * @param log - the change log.
 * @param folder - the folder the spec names.
 * @param at - the time the records carry.
 * @returns the operation.
 */
async function folderOperation(ctx: ChangesContext, log: ChangeLog, folder: string, at: string): Promise<Operation> {
  const plugin = await folderName(folder)
  const active = activeDirectory(ctx.home, ctx.profile, plugin)
  const approval = approvedOf(await readApproved(ctx.profileDir), plugin)
  await holdContent(ctx.home, active, approval?.version)
  const args = ['add', `${plugin}@${LINK_PREFIX}${active}`]
  if (approval !== undefined) return { args, log, after: NOTHING_AFTER }
  const scanCache = join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache)
  const { version } = await storeFolder(ctx.home, folder, { scanCache })
  const subject = { plugin, source: folder }
  const id = changeId('plugin-install', subject, undefined, version)
  const entry: ChangeEntry = { id, kind: 'plugin-install', state: 'pending', subject, to: version, summary: `${plugin} from ${folder} waits for your review`, createdAt: at }
  return { args, log: findEntry(log, id) === undefined ? withEntry(log, entry) : log, after: NOTHING_AFTER, folderChange: id }
}

/**
 * The operation that carries out one request.
 * @param ctx - the profile.
 * @param log - the change log.
 * @param entry - the pending request.
 * @param at - the time the records carry.
 * @returns the operation.
 */
async function operationFor(ctx: ChangesContext, log: ChangeLog, entry: ChangeEntry, at: string): Promise<Operation> {
  const spec = entry.subject.spec!
  if (entry.kind === 'plugin-remove') {
    return {
      args: ['remove', spec],
      log,
      after: async () => {
        // A removed plugin's approval goes with it, so linking it again later waits for review.
        const approved = await readApproved(ctx.profileDir)
        if (approvedOf(approved, spec) === undefined) return
        const { [spec]: _removed, ...plugins } = approved.plugins
        await writeApproved(ctx.profileDir, { ...approved, plugins })
      },
    }
  }
  const parsed = parsedSpec(spec)
  if (parsed.kind === 'path' && await namesDirectory(parsed.path)) return folderOperation(ctx, log, parsed.path, at)
  return { args: ['add', spec], log, after: NOTHING_AFTER }
}

/**
 * Apply an agent's plugin request the person reviewed: run upstream's plugin operation for its spec under the profile's
 * write lock, record one profile history version, mark the request applied and reload the running Host. A failed
 * operation leaves the request pending with the failure, and nothing else changes; a failed reload leaves the change
 * applied, for the next start to load.
 * @param ctx - the profile.
 * @param id - the change id the person reviewed.
 * @param presence - proof that the person is at their computer.
 * @param options - the Host's reload and upstream's plugin operation.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `UNKNOWN_CHANGE`;
 *   `NOT_ALLOWED` for a change that is no plugin request or is not pending; `INVALID_REQUEST` for a spec or folder
 *   pnpm would not accept; `OPERATION_FAILED` when upstream's operation failed.
 */
export async function applyInstallChange(ctx: ChangesContext, id: ChangeId, presence: AtComputer, options: InstallApplyOptions): Promise<InstallResult> {
  requirePresence(presence, id)
  return locked(ctx, async () => {
    const log = await readChangeLog(ctx.home, ctx.profile)
    const entry = findEntry(log, id)
    if (entry === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `No change has the id ${id}. See the changes: delorun changes list`)
    if (!isPluginRequest(entry)) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is not a plugin install, update or removal the agent asked for.`)
    if (entry.state !== 'pending') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so it cannot be applied.`)
    const at = timeOf(ctx)
    const operation = await operationFor(ctx, log, entry, at)
    const { lastFailure: _lastFailure, ...request } = entry
    const ran = await options.run(operation.args)
    if (ran.exitCode !== 0) {
      const failure = `the plugin operation exited ${String(ran.exitCode)}; diagnostics: ${ran.logPath}`
      await writeChangeLog(ctx.home, ctx.profile, withEntry(log, { ...request, lastFailure: { at, failure } }))
      throw new ChangesError('OPERATION_FAILED', id, `Change ${id} was not applied: ${failure}`)
    }
    await operation.after()
    const recorded = await recordVersion(ctx, `Applied ${id}: ${entry.summary}`)
    const applied: ChangeEntry = { ...request, state: 'applied', decidedAt: at, decidedFrom: presence.kind, ...recorded }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(operation.log, applied))
    const outcome = await options.reload()
    const reload: InstallReload = outcome === undefined ? { kind: 'not-running' } : outcome.ok ? { kind: 'reloaded' } : { kind: 'failed', failure: outcome.error }
    return { entry: applied, ...recorded, ...operation.folderChange === undefined ? {} : { folderChange: operation.folderChange }, reload }
  })
}
