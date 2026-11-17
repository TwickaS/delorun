/**
 * The agent's plugin requests: with the C16 switch `plugin_changes_pending` on, an agent's `plugin_manager` call that
 * would install, update or remove a plugin runs nothing and records a pending change instead
 * ({@link recordPluginRequest}, the one function `@delorun/plugin-changes` calls), and the person applies it at their
 * computer ({@link applyInstallChange}), which runs upstream's plugin operation under the profile's write lock with the
 * checks the plugin manager's `installBundle` runs: build scripts stay held back by pnpm's `allowBuilds` decisions, the
 * ones pnpm reports blocked are recorded as waiting for the person's decision, and a failed or refused operation puts
 * the profile's `package.json` and `pnpm-lock.yaml` back.
 *
 * A request whose spec names a folder, as a path, `file:<path>`, `link:<path>` or `<name>@file:<path>` and
 * `<name>@link:<path>`, never links the profile to that folder: applying it links the plugin to its active directory
 * under `changes/`, which holds nothing until the person applies the folder's content, and records that content as a
 * change waiting for review, as a start does for a plugin linked from a folder ([enforce](./enforce.ts)). Nothing the
 * agent asked for therefore loads before the person reviewed its content. A `<name>@<range>` spec whose range is no
 * registry version, range or tag and no such folder (`workspace:`, `npm:`, a git or URL source, a path) is refused, so
 * no spec that pnpm reads as a source of its own passes as a registry install.
 *
 * @module @delorun/changes/install-actions
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { recordPendingBuilds } from '@deepseek-ai/dsh-plugin-manager/operations'
import { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from '@deepseek-ai/dsh-plugin-manager'
import { PROTECTED_FILE_MODE } from '@delorun/contract-home-layout'
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
import { referenceRelease } from './tree.ts'

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

/** What one plugin operation did. */
export interface PluginOperationResult {
  /** Zero when the operation changed the profile as asked. */
  readonly exitCode: number
  /** The operation's diagnostics file; absent when it refused before pnpm ran. */
  readonly logPath?: string
  /** pnpm's output, which names the build scripts pnpm held back. */
  readonly output?: string
  /** Why the operation refused, in the person's words: an incompatible version, or a package that is no plugin bundle. */
  readonly failure?: string
}

/**
 * Upstream's profile plugin operation with these pnpm arguments, run by a caller that already holds the profile's write
 * lock, with the checks the plugin manager's `installBundle` runs around it: `runProfilePnpm` of
 * `@deepseek-ai/dsh-plugin-manager/operations` run as the plugin manager runs it. The caller puts the profile's
 * `package.json` and `pnpm-lock.yaml` back after a failure.
 * @param args - the pnpm arguments, such as `['add', spec]`.
 * @param folder - for a spec that names a folder, the folder whose package the link will hold once the person applies
 *   its content; the operation refuses it as the plugin manager refuses an incompatible package or one that is no
 *   plugin bundle.
 * @returns the exit code, the operation's diagnostics and why it refused.
 */
export type PluginOperation = (args: readonly string[], folder?: string) => Promise<PluginOperationResult>

/** What applying a plugin request is given. */
export interface InstallApplyOptions {
  /** Reloads the running Host. */
  readonly reload: ReloadHost
  /** Runs upstream's plugin operation. */
  readonly run: PluginOperation
  /**
   * Checks what the operation left, before the change is recorded and before anything reloads. A throw puts the
   * profile's `package.json` and `pnpm-lock.yaml` back and leaves the request pending.
   */
  readonly verify?: () => Promise<void>
}

/** How the running Host took an applied plugin request. */
export type InstallReload =
  /** Delorun is not running for the profile; the next start loads the change. */
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
    throw invalidSpec(spec, error)
  }
}

/** A registry version, range or dist-tag: what may follow `<name>@` for pnpm to install from the registry. */
const REGISTRY_RANGE = /^[\w.^~<>=|* +-]+$/

/** A range that names a folder by pnpm's folder protocols. */
const FOLDER_RANGE = /^(?:file|link):/

/**
 * Read an install spec as pnpm will, and refuse a `<name>@<range>` whose range names a source other than the registry or
 * a folder: upstream's parser reads such a spec as a registry install, which pnpm would install from that source.
 * @param spec - the spec, trimmed.
 * @returns its form; a `<name>@file:<path>` or `<name>@link:<path>` as the path or tarball the range names, with the
 *   name as `alias`.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept or one whose range names another source.
 */
function requestSpec(spec: string): ParsedInstallSpec & { readonly alias?: string } {
  const parsed = parsedSpec(spec)
  if (parsed.kind !== 'registry' || parsed.range === undefined || REGISTRY_RANGE.test(parsed.range)) return parsed
  if (FOLDER_RANGE.test(parsed.range)) {
    try {
      return { ...parseInstallSpec(parsed.range), alias: parsed.name }
    } catch (error) {
      throw invalidSpec(spec, error)
    }
  }
  throw new ChangesError('INVALID_REQUEST', spec, `${spec} is not a plugin spec this profile can install: ${parsed.range} after the package name is neither a registry version nor a folder (file: or link:).`)
}

/**
 * @param spec - the spec.
 * @param error - why upstream's parser refused it.
 * @returns the refusal of the request.
 */
function invalidSpec(spec: string, error: unknown): ChangesError {
  const reason = error instanceof InvalidInstallSpecError ? error.reason : String(error)
  return new ChangesError('INVALID_REQUEST', spec, `${spec} is not a plugin spec this profile can install: ${reason}.`, { cause: error })
}

/**
 * Decide what a request changes: a removal of a dependency, an update of a registry plugin the profile has, or an
 * install.
 * @param profileDir - the profile's directory.
 * @param request - the request.
 * @returns its kind, subject and summary.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept, one whose range names a source other than
 *   the registry or a folder, or a removal of a name that is no dependency; `RECORD_UNREADABLE` when the profile's
 *   manifest cannot be read.
 */
async function classify(profileDir: string, request: PluginRequest): Promise<Classified> {
  const spec = request.spec.trim()
  const dependencies = dependencyNames(await readProfileManifest(profileDir))
  if (request.action === 'remove') {
    if (!dependencies.has(spec)) throw new ChangesError('INVALID_REQUEST', spec, `${spec} is not a plugin of this profile, so there is nothing to remove.`)
    return { kind: 'plugin-remove', subject: { plugin: spec, spec }, summary: `The agent asks to remove ${spec}` }
  }
  const parsed = requestSpec(spec)
  if (parsed.kind === 'registry' && dependencies.has(parsed.name)) {
    return { kind: 'plugin-update', subject: { plugin: parsed.name, spec }, summary: `The agent asks to move ${parsed.name} to ${spec}` }
  }
  const plugin = parsed.kind === 'registry' ? parsed.name : parsed.alias
  return { kind: 'plugin-install', subject: { ...plugin === undefined ? {} : { plugin }, spec }, summary: `The agent asks to install ${spec}` }
}

/**
 * Record an agent's plugin request as a change waiting for the person's review. Nothing the profile runs changes: no
 * manifest, lockfile, `node_modules` or approval is written, only the change log. The same request while it waits keeps
 * its entry and id; a request for a change the person already decided is a new change with a new id.
 * @param ctx - the profile.
 * @param request - what the agent asked.
 * @returns the pending entry.
 * @throws {ChangesError} `INVALID_REQUEST` for a spec pnpm would not accept, one whose range names a source other than
 *   the registry or a folder, or a removal of a name that is no dependency; `RECORD_UNREADABLE` when the profile's
 *   manifest or the change log cannot be read.
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
  /** The folder a spec names, whose package the operation checks. */
  readonly folder?: string
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
 * @param alias - the name a `<name>@file:<path>` spec gives the plugin, which must be the package the folder holds.
 * @returns the operation.
 * @throws {ChangesError} `INVALID_REQUEST` when the folder names no valid package, or another package than `alias`.
 */
async function folderOperation(ctx: ChangesContext, log: ChangeLog, folder: string, at: string, alias: string | undefined): Promise<Operation> {
  const plugin = await folderName(folder)
  if (alias !== undefined && alias !== plugin) throw new ChangesError('INVALID_REQUEST', folder, `The folder ${folder} holds the package ${plugin}, not ${alias}.`)
  const active = activeDirectory(ctx.home, ctx.profile, plugin)
  const approval = approvedOf(await readApproved(ctx.profileDir), plugin)
  await holdContent(ctx.home, active, approval?.version, await referenceRelease(ctx.home, ctx.runningRelease))
  const args = ['add', `${plugin}@${LINK_PREFIX}${active}`]
  if (approval !== undefined) return { args, log, after: NOTHING_AFTER, folder }
  const scanCache = join(profileChangesDirectory(ctx.home, ctx.profile), CHANGES_ENTRIES.scanCache)
  const { version } = await storeFolder(ctx.home, folder, { scanCache })
  const subject = { plugin, source: folder }
  const id = changeId('plugin-install', subject, undefined, version)
  const entry: ChangeEntry = { id, kind: 'plugin-install', state: 'pending', subject, to: version, summary: `${plugin} from ${folder} waits for your review`, createdAt: at }
  return { args, log: findEntry(log, id) === undefined ? withEntry(log, entry) : log, after: NOTHING_AFTER, folderChange: id, folder }
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
  const parsed = requestSpec(spec)
  if (parsed.kind === 'path' && await namesDirectory(parsed.path)) return folderOperation(ctx, log, parsed.path, at, parsed.alias)
  return { args: ['add', spec], log, after: NOTHING_AFTER }
}

/** The profile files a plugin operation may rewrite and a failed one puts back, as the plugin manager restores them. */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/**
 * @param profileDir - the profile's directory.
 * @returns each restored file's path and its text, undefined when it does not exist.
 */
async function savedFiles(profileDir: string): Promise<ReadonlyMap<string, string | undefined>> {
  const files = new Map<string, string | undefined>()
  for (const name of RESTORED_FILES) {
    const path = join(profileDir, name)
    try {
      files.set(path, await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      files.set(path, undefined)
    }
  }
  return files
}

/**
 * Put the saved files back; a file that did not exist is removed.
 * @param files - the files {@link savedFiles} read.
 */
async function restoreFiles(files: ReadonlyMap<string, string | undefined>): Promise<void> {
  for (const [path, text] of files) {
    if (text === undefined) await rm(path, { force: true })
    else await writeFileAtomic(path, text, { mode: PROTECTED_FILE_MODE })
  }
}

/**
 * Why an operation failed, in the person's words: its own reason, or the build scripts pnpm held back, which
 * `recordPendingBuilds` of upstream's plugin manager records in the profile's `pnpm-workspace.yaml` as it does after a
 * failed `installBundle`, or its exit code.
 * @param profileDir - the profile's directory.
 * @param ran - what the operation did.
 * @returns the failure.
 */
async function failureOf(profileDir: string, ran: PluginOperationResult): Promise<string> {
  const diagnostics = ran.logPath === undefined ? '' : `; diagnostics: ${ran.logPath}`
  if (ran.failure !== undefined) return `${ran.failure}${diagnostics}`
  const exited = `the plugin operation exited ${String(ran.exitCode)}${diagnostics}`
  let pending: string[]
  try {
    pending = await recordPendingBuilds(profileDir, ran.output ?? '')
  } catch (error) {
    // The held-back build scripts are unknown, so the failure names that rather than a plain exit code.
    return `${exited}; the build scripts pnpm held back could not be recorded: ${error instanceof Error ? error.message : String(error)}`
  }
  if (pending.length === 0) return exited
  return `${exited}; nothing was installed, and pnpm holds back the build scripts of ${pending.join(', ')} until you decide under allowBuilds in ${join(profileDir, 'pnpm-workspace.yaml')}: true lets one run, false installs without it`
}

/**
 * Apply an agent's plugin request the person reviewed: run upstream's plugin operation for its spec under the profile's
 * write lock, record one profile history version, mark the request applied and reload the running Host. A failed
 * operation puts the profile's `package.json` and `pnpm-lock.yaml` back, records the build scripts pnpm held back as
 * waiting for the person's decision, and leaves the request pending with the failure; a failed reload leaves the change
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
    const files = await savedFiles(ctx.profileDir)
    const ran = await options.run(operation.args, operation.folder)
    if (ran.exitCode !== 0) {
      await restoreFiles(files)
      const failure = await failureOf(ctx.profileDir, ran)
      await writeChangeLog(ctx.home, ctx.profile, withEntry(log, { ...request, lastFailure: { at, failure } }))
      throw new ChangesError('OPERATION_FAILED', id, `Change ${id} was not applied: ${failure}`)
    }
    if (options.verify !== undefined) {
      try {
        await options.verify()
      } catch (error: unknown) {
        await restoreFiles(files)
        throw error
      }
    }
    await operation.after()
    const recorded = await recordVersion(ctx, `Applied: ${entry.summary}`)
    const applied: ChangeEntry = { ...request, state: 'applied', decidedAt: at, decidedFrom: presence.kind, ...recorded }
    await writeChangeLog(ctx.home, ctx.profile, withEntry(operation.log, applied))
    const outcome = await options.reload()
    const reload: InstallReload = outcome === undefined ? { kind: 'not-running' } : outcome.ok ? { kind: 'reloaded' } : { kind: 'failed', failure: outcome.error }
    return { entry: applied, ...recorded, ...operation.folderChange === undefined ? {} : { folderChange: operation.folderChange }, reload }
  })
}
