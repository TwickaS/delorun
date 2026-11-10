/**
 * What a start of a profile runs from the plugins the person links from folders. Before the profile boots, every
 * `link:` dependency names the plugin's active directory under `changes/`, never its folder, and the active directory
 * holds exactly one content version:
 *
 * 1. during a work session for the plugin, the folder's current content;
 * 2. otherwise, under protection `block`, the approved version, or nothing at all for a plugin with no approved version
 *    (upstream then skips its bundle as unresolvable, so nothing from the folder loads);
 * 3. under `warn` or `off`, the folder's current content.
 *
 * A link into the runtime store `runtimes/`, as Delo's own bundles carried by an installed release are linked, is left
 * alone: the store's start check covers it, and an update replaces it. A link to the directory the running installation
 * itself carries for the package name is left alone too, because a source checkout runs the whole harness, upstream
 * packages included, from the checkout, so copying Delo's bundles would not stop edits to the code the Host runs. A
 * link to anything but a directory, `file:` specs and registry plugins are left alone as well; every other folder is a
 * linked plugin. The first start under Changes (its change log has no `migratedAt`) approves every linked plugin as it is, so
 * nobody's working harness changes what it runs; a plugin linked from a folder at any later start waits for review. Every
 * profile write happens under upstream's profile write lock, and a start that changed the profile's files records one
 * profile history version.
 *
 * @module @delo/changes/enforce
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { openHistory } from '@delo/profile-safety'
import { changeId } from './ids.ts'
import { pointLinkAt, readLinks } from './link.ts'
import { activeDirectory, CHANGES_ENTRIES, profileChangesDirectory } from './paths.ts'
import { approvedOf, findEntry, readActiveRecord, readApproved, readChangeLog, readProtection, readWorkSession, withEntry, writeActiveRecord, writeApproved, writeChangeLog } from './records.ts'
import { holdsVersion, materialize, storeFolder } from './store.ts'
import { versionOf } from './tree.ts'
import { ACTIVE_RECORD_SCHEMA, type ActiveContent, type ApprovedRecord, type ChangeEntry, type ChangeId, type ChangeLog, type ContentVersion, type ProtectionLevel } from './types.ts'

/** How long a start waits for the profile write lock: upstream plugin management's default, which a `pnpm` run can hold. */
export const PROFILE_LOCK_WAIT_MS = 120_000

/** The profile a start is about to boot. */
export interface EnforceRequest {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
  /** The clock for the records' times; `() => new Date()` by default. */
  readonly now?: () => Date
  /** How long to wait for the profile write lock; {@link PROFILE_LOCK_WAIT_MS} by default. */
  readonly lockWaitMs?: number
  /**
   * Whether a `link:` dependency names a package of the harness itself: the directory the running installation
   * resolves for that package name, as a source checkout's setup links Delo's bundles. Such a link is left alone, like
   * a link into `runtimes/`. None is the harness's when absent.
   * @param name - the package name.
   * @param target - the folder the link names, absolute.
   * @returns true for the harness's own package.
   */
  readonly harnessLink?: (name: string, target: string) => boolean
}

/** A plugin the first start under Changes approved as it was. */
export interface ApprovedAtUpgrade {
  readonly plugin: string
  /** Its folder. */
  readonly source: string
}

/** A change waiting for review whose content this start does not load. */
export interface PendingAtStart {
  readonly id: ChangeId
  readonly plugin: string
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** What a start tells the person about the plugins it loads from folders. */
export interface StartChanges {
  readonly protection: ProtectionLevel
  /** Plugins approved at the upgrade that no start has named yet; this start marks them as named. */
  readonly approvedAtUpgrade: readonly ApprovedAtUpgrade[]
  /** Under `block`, the changes this start leaves out. */
  readonly pending: readonly PendingAtStart[]
  /** Under `warn`, the plugins whose running content is not the approved one. */
  readonly unapproved: readonly { readonly plugin: string }[]
  /** The plugin whose folder loads live, when a work session is open for a plugin of the profile. */
  readonly workSession?: { readonly plugin: string }
  /** The profile history version this start recorded, when it changed the profile's files. */
  readonly historyVersion?: string
}

/** The content version of an empty directory: what the active directory of a plugin with nothing to load holds. */
export const EMPTY_CONTENT_VERSION: ContentVersion = versionOf([])

/** One linked plugin whose spec names its active directory, as the start decides its content. */
interface ManagedPlugin {
  readonly plugin: string
  /** Its folder; undefined when neither the approved record nor a pending install names one. */
  readonly source: string | undefined
}

/**
 * Bring the profile's linked plugins under Changes and make each active directory hold the content this start loads.
 * Takes the profile write lock itself.
 * @param request - the home, the profile, its directory, the clock and the lock wait.
 * @returns what the start prints ({@link startNotice}).
 * @throws {ChangesError} when a record of Changes or the profile's manifest is not one Delo wrote, the store is
 *   corrupt, or a folder changed while it was read.
 * @throws {HistoryUnavailableError} when the profile changed and its history cannot record the change, so the start
 *   must not go on.
 */
export async function enforceApprovedContent(request: EnforceRequest): Promise<StartChanges> {
  const { home, profile, profileDir } = request
  const at = (request.now ?? (() => new Date()))().toISOString()
  return withFileLock(join(profileDir, 'package.json'), async () => {
    const protection = await readProtection(home)
    const workSession = await readWorkSession(home, profile)
    const scanCache = join(profileChangesDirectory(home, profile), CHANGES_ENTRIES.scanCache)
    const firstLog = await readChangeLog(home, profile)
    const migrating = firstLog.migratedAt === undefined
    let log = firstLog
    let approved = await readApproved(profileDir)
    const managed: ManagedPlugin[] = []
    const moved: { readonly plugin: string, readonly source: string }[] = []
    const upgraded: string[] = []
    const awaiting: string[] = []
    for (const link of await readLinks(profileDir)) {
      const active = activeDirectory(home, profile, link.name)
      if (resolve(link.target) === resolve(active)) {
        managed.push({ plugin: link.name, source: approvedOf(approved, link.name)?.source ?? pendingInstallSource(log, link.name) })
        continue
      }
      if (isHarnessLink(request, link.name, link.target) || !await namesDirectory(link.target)) continue
      const { version } = await storeFolder(home, link.target, { scanCache })
      const subject = { plugin: link.name, source: link.target }
      if (migrating) {
        approved = withApproval(approved, link.name, { source: link.target, version, approvedAt: at, approvedAtUpgrade: true })
        log = withNewEntry(log, {
          id: changeId('plugin-install', subject, undefined, version),
          kind: 'plugin-install',
          state: 'applied',
          subject,
          to: version,
          summary: `Approved at upgrade: ${link.name} from ${link.target}`,
          createdAt: at,
          decidedAt: at,
          decidedFrom: 'upgrade',
        })
        upgraded.push(link.name)
      } else if (approvedOf(approved, link.name)?.source !== link.target) {
        // A link back to the approved plugin's own folder, as an undo past the upgrade brings back, is moved silently.
        log = withNewEntry(log, {
          id: changeId('plugin-install', subject, undefined, version),
          kind: 'plugin-install',
          state: 'pending',
          subject,
          to: version,
          summary: `${link.name} from ${link.target} waits for your review`,
          createdAt: at,
        })
        awaiting.push(link.name)
      }
      moved.push({ plugin: link.name, source: link.target })
      managed.push({ plugin: link.name, source: link.target })
    }

    // The log names every new source before the profile's specs stop naming it; `migratedAt` is set only at the end,
    // so a start interrupted in between migrates the remaining links at the next start.
    if (log !== firstLog) await writeChangeLog(home, profile, log)
    if (upgraded.length > 0) await writeApproved(profileDir, approved)
    for (const { plugin } of moved) await pointLinkAt(profileDir, plugin, activeDirectory(home, profile, plugin))

    const pending: PendingAtStart[] = []
    const unapproved: { readonly plugin: string }[] = []
    const activeBefore = await readActiveRecord(home, profile)
    const activePlugins: Record<string, ActiveContent> = {}
    for (const { plugin, source } of managed) {
      const approvedVersion = approvedOf(approved, plugin)?.version
      // A folder that is gone leaves the approved content, and nothing to review.
      const folder = source === undefined || !await namesDirectory(source) ? undefined : { source, version: (await storeFolder(home, source, { scanCache })).version }
      let content: ActiveContent | undefined
      if (workSession?.plugin === plugin && folder !== undefined) {
        content = { version: folder.version, kind: 'work-session' }
      } else if (protection === 'block' || folder === undefined) {
        content = approvedVersion === undefined ? undefined : { version: approvedVersion, kind: 'approved' }
        if (protection === 'block' && folder !== undefined && folder.version !== approvedVersion) {
          const kind = approvedVersion === undefined ? 'plugin-install' : 'plugin-edit'
          pending.push({ id: changeId(kind, { plugin, source: folder.source }, approvedVersion, folder.version), plugin, kind })
        }
      } else {
        content = { version: folder.version, kind: folder.version === approvedVersion ? 'approved' : 'unapproved' }
        if (content.kind === 'unapproved' && protection === 'warn') unapproved.push({ plugin })
      }
      await holdContent(home, activeDirectory(home, profile, plugin), content?.version)
      if (content !== undefined) activePlugins[plugin] = content
    }
    if (JSON.stringify(activePlugins) !== JSON.stringify(activeBefore.plugins)) {
      await writeActiveRecord(home, profile, { schema: ACTIVE_RECORD_SCHEMA, plugins: activePlugins })
    }

    // An approval at upgrade without a history version, which an earlier start could not record, is recorded now.
    const unrecorded = log.entries.flatMap(entry => entry.decidedFrom === 'upgrade' && entry.historyVersion === undefined && entry.subject.plugin !== undefined ? [entry.subject.plugin] : [])
    const summary = historySummary(unrecorded, awaiting, moved.map(({ plugin }) => plugin))
    const historyVersion = summary === undefined ? undefined : await openHistory({ profileDir }).record(summary, { kind: 'person' })

    const shown: ApprovedAtUpgrade[] = []
    const entries = log.entries.map((entry): ChangeEntry => {
      let next = entry
      if (historyVersion !== undefined && entry.decidedFrom === 'upgrade' && entry.historyVersion === undefined) {
        next = { ...next, historyVersion }
      }
      if (entry.decidedFrom === 'upgrade' && entry.state === 'applied' && entry.shownAt === undefined && entry.subject.plugin !== undefined && entry.subject.source !== undefined) {
        shown.push({ plugin: entry.subject.plugin, source: entry.subject.source })
        next = { ...next, shownAt: at }
      }
      return next
    })
    const finalLog: ChangeLog = { ...log, ...migrating ? { migratedAt: at } : {}, entries }
    if (JSON.stringify(finalLog) !== JSON.stringify(firstLog)) await writeChangeLog(home, profile, finalLog)

    const session = workSession !== undefined && managed.some(({ plugin }) => plugin === workSession.plugin) ? { plugin: workSession.plugin } : undefined
    return {
      protection,
      approvedAtUpgrade: shown,
      pending,
      unapproved,
      ...session === undefined ? {} : { workSession: session },
      ...historyVersion === undefined ? {} : { historyVersion },
    }
  }, { waitMs: request.lockWaitMs ?? PROFILE_LOCK_WAIT_MS })
}

/**
 * The lines a start prints about the plugins it loads from folders, in the person's words.
 * @param changes - what {@link enforceApprovedContent} returned.
 * @returns the lines, each ending in a newline; empty when there is nothing to say.
 */
export function startNotice(changes: StartChanges): string {
  const lines: string[] = []
  for (const { plugin, source } of changes.approvedAtUpgrade) {
    lines.push(`Delo now runs the approved copy of ${plugin}, linked from ${source}. Edits in that folder wait for your review: delorun changes list.`)
  }
  if (changes.workSession !== undefined) {
    lines.push(`Working on ${changes.workSession.plugin}: edits in its folder load live until delorun changes done ${changes.workSession.plugin}.`)
  }
  for (const { id, plugin, kind } of changes.pending) {
    lines.push(kind === 'plugin-install'
      ? `${plugin} is not loaded until you review it: delorun changes show ${id}`
      : `${plugin} has changes waiting for your review and loads without them: delorun changes show ${id}`)
  }
  for (const { plugin } of changes.unapproved) {
    lines.push(`Warning: ${plugin} runs changes you have not reviewed (protection is set to warn).`)
  }
  return lines.map(line => `${line}\n`).join('')
}

/**
 * The folder of a plugin whose only record is a pending install.
 * @param log - the change log.
 * @param plugin - the package name.
 * @returns the folder the newest pending install of the plugin names, or undefined.
 */
function pendingInstallSource(log: ChangeLog, plugin: string): string | undefined {
  return log.entries.findLast(entry => entry.kind === 'plugin-install' && entry.state === 'pending' && entry.subject.plugin === plugin)?.subject.source
}

/**
 * @param log - the change log.
 * @param entry - an entry this start records.
 * @returns the log with the entry appended; the log as it is when it already has an entry with the id, which an
 *   earlier start recorded for the same folder content.
 */
function withNewEntry(log: ChangeLog, entry: ChangeEntry): ChangeLog {
  return findEntry(log, entry.id) === undefined ? withEntry(log, entry) : log
}

/**
 * @param record - the approved record.
 * @param plugin - a package name.
 * @param approval - its approval.
 * @returns the record with the plugin approved.
 */
function withApproval(record: ApprovedRecord, plugin: string, approval: ApprovedRecord['plugins'][string]): ApprovedRecord {
  return { ...record, plugins: { ...record.plugins, [plugin]: approval } }
}

/**
 * Make an active directory hold one version, or nothing. A directory that already holds it is left as it is; anything
 * else in it, such as a file changed or added since, is replaced.
 * @param home - the Delo home.
 * @param directory - the active directory.
 * @param version - the version; undefined for an empty directory.
 */
export async function holdContent(home: string, directory: string, version: ContentVersion | undefined): Promise<void> {
  if (await holdsVersion(directory, version ?? EMPTY_CONTENT_VERSION)) return
  if (version !== undefined) {
    await materialize(home, version, directory)
    return
  }
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
}

/**
 * @param home - the Delo home.
 * @param target - a link's folder, absolute.
 * @returns whether it lies inside the runtime store, whose own start check covers it.
 */
export function isInRuntimeStore(home: string, target: string): boolean {
  const path = relative(join(home, DELO_HOME_ENTRIES.runtimes), target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * @param request - the home and the harness's own links.
 * @param name - a linked package's name.
 * @param target - the folder its link names, absolute.
 * @returns whether the link is the harness's rather than a plugin's: into the runtime store, or to the directory the
 *   running installation carries for the name.
 */
export function isHarnessLink(request: Pick<EnforceRequest, 'home' | 'harnessLink'>, name: string, target: string): boolean {
  return isInRuntimeStore(request.home, target) || request.harnessLink?.(name, target) === true
}

/**
 * @param path - a path.
 * @returns whether it names a directory, following links; false when nothing is there.
 * @throws the filesystem error other than a missing path, such as `EACCES`.
 */
export async function namesDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing target, or a file where a directory is expected on the way, names no folder to load.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * The subject of the profile history version a start records.
 * @param upgraded - the plugins approved at the upgrade whose approval no history version holds yet.
 * @param awaiting - the plugins added since, which wait for review.
 * @param moved - every plugin whose spec this start moved to its active directory.
 * @returns the summary, or undefined when the start changed none of the profile's files.
 */
function historySummary(upgraded: readonly string[], awaiting: readonly string[], moved: readonly string[]): string | undefined {
  if (moved.length === 0 && upgraded.length === 0) return undefined
  const parts: string[] = []
  if (upgraded.length > 0) parts.push(`approved at upgrade ${upgraded.join(', ')}`)
  if (awaiting.length > 0) parts.push(`${awaiting.join(', ')} ${awaiting.length === 1 ? 'waits' : 'wait'} for your review`)
  const relinked = moved.filter(plugin => !upgraded.includes(plugin) && !awaiting.includes(plugin))
  if (relinked.length > 0) parts.push(`${relinked.join(', ')} linked to Delo's copy again`)
  return `Changes: ${parts.join('; ')}`
}
