/**
 * The plan of a stock-home import: what it carries into the Delo home, what
 * the Delo home already holds, what it holds back or leaves behind and why,
 * and what keeps it from going on. Planning reads both homes and writes
 * nothing, so a person sees the whole plan before anything changes.
 *
 * The stock home is walked by `lstat` from its real root down, through the
 * entries the layout table names: a symbolic link, a pipe, socket or device,
 * an entry on another file system, and a name upstream does not write are
 * listed and never read, and a file with a hard link the walk did not meet
 * inside the stock home is listed and never copied. Chats are carried whole,
 * with every generation they hold and byte for byte, or not at all. An
 * attachment is carried only when its bytes have the digest its path names. A
 * chat whose identifier the Delo home holds with other content is a collision,
 * and so is an attachment whose content address the Delo home holds with other
 * bytes; either keeps the import from going on, because an import never
 * overwrites.
 *
 * Chats, attachments and the workspace list are data, and the import carries
 * them. Everything that can change what the harness runs or what the agent is
 * told is planned per category, for the person to say yes to after seeing it:
 * the profiles, the settings layers, the instructions, the skills and the
 * DeepSeek key. Every text the plan shows is the text that lands: a layer is
 * split ({@link splitPatchLayer}) and its held-back rows land in an inert file,
 * and the import checks each stock file's digest again before it writes what
 * the plan derived from it.
 *
 * @module @delo/archive/dsh-import/plan
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { isProfileSafetyError } from '@delo/profile-safety'
import { ARCHIVE_LIMITS } from '@delo/contract-archive-and-trash'
import { parseDocument } from 'yaml'
import { ChatLogScan } from './chats.ts'
import { compareCredentials, CREDENTIALS_PATH, readCredentials, type DshImportCredential } from './credentials.ts'
import { DshImportError, systemCode } from './errors.ts'
import { splitPatchLayer, splitSettingsLayer, wholeHeld, type HeldRow, type SplitLayer } from './layers.ts'
import {
  attachmentAddress,
  decodeSessionName,
  DESKTOP_PROFILE_NAME,
  isProfileName,
  isProjectName,
  isRuntimeState,
  isSafeSegment,
  isSessionName,
  PROFILE_CARRIED_FILES,
  PROFILE_SKIPS,
  rootEntryKind,
  sessionFileKind,
  STOCK_IMPORT_DIRECTORY,
  storageUnitKind,
  type DshImportSkipReason,
} from './layout.ts'
import { carryNotes, landManifest, type DshImportPlugin } from './profiles.ts'
import { compareNames, SourceReader, type DshHashedFile, type DshImportFile, type InspectedEntry } from './source.ts'
import type { WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import { inside, mergeRegistries, parseRegistry, REGISTRY_PATH, restrictRegistry, sensitiveFolder, type Registry, type SensitiveFolders } from './workspaces.ts'

/** The limits one stock-home import applies. */
export interface DshImportLimits {
  /** The names the walk lists at most. */
  readonly maxEntries: number
  /** The bytes one carried file holds at most. */
  readonly maxFileBytes: number
  /** The bytes every file the import copies holds together at most. */
  readonly maxTotalBytes: number
}

/** The limits an import applies by default: contract C8's numbers for one archive. */
export const DSH_IMPORT_LIMITS: DshImportLimits = {
  maxEntries: ARCHIVE_LIMITS.maxEntries,
  maxFileBytes: ARCHIVE_LIMITS.maxEntryBytes,
  maxTotalBytes: ARCHIVE_LIMITS.maxTotalBytes,
}

/** The bytes a document the import parses in memory holds at most: a profile manifest, a layer, the workspace list, the instructions. */
export const PARSED_DOCUMENT_BYTES = 16 * 1024 * 1024

/** The bytes the credentials document holds at most. */
export const CREDENTIALS_DOCUMENT_BYTES = 1024 * 1024

/** The bytes of a skill's `SKILL.md` the plan reads for its description. */
const SKILL_DOCUMENT_BYTES = 1024 * 1024

/** The paths the plan lists per reason it leaves entries behind; the totals count every one. */
export const SKIPPED_LIST_LIMIT = 100

/**
 * Resolve the limits of one import.
 * @param maxTotalBytes - the person's total, from `--max-size`; contract C8's 4 GiB when absent.
 * @returns the limits, with one file never allowed more than the total.
 */
export function resolveDshImportLimits(maxTotalBytes?: number): DshImportLimits {
  const total = maxTotalBytes ?? DSH_IMPORT_LIMITS.maxTotalBytes
  return { ...DSH_IMPORT_LIMITS, maxTotalBytes: total, maxFileBytes: Math.min(DSH_IMPORT_LIMITS.maxFileBytes, total) }
}

/** What one stock-home import reads. */
export interface DshImportOptions {
  /** The stock home; its real path is the root nothing is read outside of. */
  readonly sourceHome: string
  /** The Delo home the import writes into. */
  readonly targetHome: string
  /** Whether chats go beside the chats the Delo home already holds. */
  readonly merge?: boolean
  /** The limits; {@link DSH_IMPORT_LIMITS} by default. */
  readonly limits?: DshImportLimits
  /** The bundles Delo appends to every carried profile. */
  readonly deloBundles: readonly string[]
  /** Profile names the Delo home holds or is about to create, which a stock profile never takes. */
  readonly reservedProfiles?: readonly string[]
  /** The plan's identifier, which names the directory its held-back files land in; a UUID by default. */
  readonly planId?: string
  /** The person's home directory, which no workspace or chat may stand in, nor in a hidden folder directly under it. */
  readonly personHome?: string
}

/** Whether a carried item is new to the Delo home or already there with the same content. */
export type DshImportState = 'new' | 'present'

/** The categories a person says yes to one by one; chats, attachments and the workspace list are data and need none. */
export type DshImportCategory = 'profiles' | 'settings' | 'instructions' | 'skills' | 'credentials'

/** The categories in the order a person is asked about them. */
export const DSH_IMPORT_CATEGORIES: readonly DshImportCategory[] = ['profiles', 'settings', 'instructions', 'skills', 'credentials']

/** One stock file the plan read whole, with the digest the import checks again before it writes what was derived from it. */
export interface DshImportText {
  /** The stock file, with the digest the plan read. */
  readonly file: DshHashedFile
  /** The lowercase hexadecimal SHA-256 of the bytes the plan read. */
  readonly sha256: string
}

/** One chat: a Session directory with every generation it holds. */
export interface DshImportChat {
  /** `sessions/<project>/<session>`. */
  readonly path: string
  /** The Session identifier its header names. */
  readonly id: string
  /** The working folder its header names, or `undefined` for a chat without one. */
  readonly cwd: string | undefined
  /** Its generations, each with the digest the plan read. */
  readonly files: readonly DshHashedFile[]
  /** New, or already in the Delo home byte for byte. */
  readonly state: DshImportState
}

/** One configuration layer, split into the rows that land and the rows held back. */
export interface DshImportLayer {
  /** The stock layer. */
  readonly source: DshImportText
  /** A profile's patch layer, the home patch, or the earlier settings document. */
  readonly kind: 'profile-patch' | 'home-patch' | 'settings'
  /** Where the carried rows land, home-relative. */
  readonly target: string
  /** `new` when they land, `present` when the Delo home holds the same text, `taken` when it holds another file there, which the import never replaces. */
  readonly state: 'new' | 'present' | 'taken'
  /** The text that lands at {@link target}, or `undefined` when nothing lands there. */
  readonly carried: string | undefined
  /** The rows or sections that land. */
  readonly carriedLabels: readonly string[]
  /** The rows or sections held back, each with why. */
  readonly held: readonly HeldRow[]
  /** Where the inert file of the held-back rows lands, or `undefined` when nothing is held back. */
  readonly heldPath: string | undefined
  /** The inert file's text. */
  readonly heldText: string | undefined
  /** The `!!js` expressions the stock layer holds; none of them lands. */
  readonly expressions: number
}

/** One profile as it lands under its own name. */
export interface DshImportProfile {
  /** The profile's name. */
  readonly name: string
  /** The stock manifest. */
  readonly source: DshImportText
  /** The manifest as it lands: a name, `private`, the registry dependencies and the bundle list. */
  readonly manifest: string
  /** The patch layer, when the stock profile holds one. */
  readonly patch: DshImportLayer | undefined
  /** The bundle list as it lands. */
  readonly bundles: readonly string[]
  /** Every bundle and plugin with what the import does with it. */
  readonly plugins: readonly DshImportPlugin[]
  /** The rows and settings the carry check found do not carry, one sentence each. */
  readonly carry: readonly string[]
}

/** The instructions for every chat: the home's `AGENTS.md`. */
export interface DshImportInstructions {
  /** The stock document. */
  readonly source: DshImportText
  /** New, or already in the Delo home byte for byte. */
  readonly state: DshImportState
  /** Its whole text, which the person reads before saying yes. */
  readonly text: string
  /** How many lines it holds. */
  readonly lines: number
}

/** One skill directory or file under `skills/`. */
export interface DshImportSkill {
  /** `skills/<name>`. */
  readonly path: string
  /** Its files, each with the digest the plan read. */
  readonly files: readonly DshHashedFile[]
  /** The first line of the `description` its `SKILL.md` declares, when it declares one the plan reads. */
  readonly description: string | undefined
  /** The whole text of its `SKILL.md`, which tells the agent what to do, or `undefined` when it holds none. */
  readonly instructions: string | undefined
  /** The bytes its files hold. */
  readonly bytes: number
}

/** One workspace of the stock list, as the preview names it. */
export interface DshImportWorkspace {
  /** Its identifier. */
  readonly id: string
  /** Its title, which the preview never shows without its folder. */
  readonly title: string
  /** Its folder. */
  readonly path: string
  /** The chats filed under it that the import carries. */
  readonly chats: number
  /** Why it is held back, or `undefined` when it is carried. */
  readonly held: string | undefined
}

/** The workspace registrations and how they land. */
export interface DshImportRegistry {
  /** The stock registry document. */
  readonly source: DshImportText
  /** The stock list with only the workspaces and chats the import carries, which is what lands. */
  readonly registry: Registry
  /** Every workspace of the stock list, carried or held. */
  readonly listed: readonly DshImportWorkspace[]
  /** The workspaces the import carries. */
  readonly workspaces: number
  /** `copy` into a home without a list, `merge` into the Delo home's list, `present` when the Delo home already holds them. */
  readonly mode: 'copy' | 'merge' | 'present'
}

/** The stored credentials, by name. */
export interface DshImportCredentials {
  /** The stock document. */
  readonly file: DshImportFile
  /** Each credential's name and state. */
  readonly entries: readonly DshImportCredential[]
}

/** One entry the import leaves behind. */
export interface DshImportSkip {
  /** Its path relative to the stock home. */
  readonly path: string
  /** Why. */
  readonly reason: DshImportSkipReason
  /** More about why, when the reason alone does not say it. */
  readonly detail?: string
}

/** What an import will do, before it writes anything. */
export interface DshHomeImportPlan {
  /** The plan's identifier, which names the directory its held-back files land in. */
  readonly id: string
  /** The stock home's real path. */
  readonly source: string
  /** The device of the stock home's root. */
  readonly sourceDevice: number
  /** The Delo home's path. */
  readonly target: string
  /** Whether the plan goes beside the Delo home's chats. */
  readonly merge: boolean
  /** The limits the plan was checked against. */
  readonly limits: DshImportLimits
  /** The bundles appended to every carried profile. */
  readonly deloBundles: readonly string[]
  /** The chats, in path order. */
  readonly chats: readonly DshImportChat[]
  /** The attachment files the Delo home does not hold yet, each with the digest its path names. */
  readonly attachments: readonly DshHashedFile[]
  /** The attachment files it already holds. */
  readonly attachmentsPresent: number
  /** The workspace registrations, when the stock home holds a list the import reads. */
  readonly registry: DshImportRegistry | undefined
  /** The profiles that land after a yes to profiles. */
  readonly profiles: readonly DshImportProfile[]
  /** The home patch and the earlier settings, which land after a yes to settings. */
  readonly layers: readonly DshImportLayer[]
  /** The instructions, which land after a yes to them. */
  readonly instructions: DshImportInstructions | undefined
  /** The skills, which land after a yes to skills. */
  readonly skills: readonly DshImportSkill[]
  /** The stored credentials, when the stock home holds a document the import reads. */
  readonly credentials: DshImportCredentials | undefined
  /** The entries left behind, in path order, at most {@link SKIPPED_LIST_LIMIT} per reason. */
  readonly skipped: readonly DshImportSkip[]
  /** How many entries are left behind for each reason, every one counted. */
  readonly skippedTotals: Readonly<Partial<Record<DshImportSkipReason, number>>>
  /** The chats the Delo home holds before the import. */
  readonly deloChats: number
  /** The bytes the import copies when every category is taken, credentials aside. */
  readonly bytes: number
  /** What keeps the import from going on; empty when it can. */
  readonly blockers: readonly DshImportError[]
}

/**
 * Read the stock home and the Delo home and plan the import, writing nothing.
 * @param options - the two homes, whether to merge, the limits, Delo's bundles and the reserved profile names.
 * @returns the plan.
 * @throws DshImportError `DSH_IMPORT_SOURCE_UNUSABLE` when the stock home is missing, is not a DeepSeek Harness home or overlaps the Delo home, `DSH_IMPORT_SOURCE_CHANGED` when a directory changes during the walk, `DSH_IMPORT_TOO_MANY_ENTRIES`, `DSH_IMPORT_ENTRY_TOO_LARGE` or `DSH_IMPORT_TOTAL_TOO_LARGE` past a limit, and `DSH_IMPORT_TARGET_REFUSED` when a Delo home directory the import writes into is not a directory.
 */
export async function planDshHomeImport(options: DshImportOptions): Promise<DshHomeImportPlan> {
  const limits = options.limits ?? DSH_IMPORT_LIMITS
  const target = resolve(options.targetHome)
  const source = await realSource(options.sourceHome)
  await refuseOverlap(source.path, target)
  const planner = new Planner(new SourceReader(source.path, limits.maxEntries, source.dev), target, options)
  return planner.plan(limits)
}

/**
 * The real path of the stock home, which must be a directory.
 * @param path - the stock home as the person named it.
 * @returns its real path, resolved once: the person chose it, and nothing under it is followed; and its device.
 * @throws DshImportError `DSH_IMPORT_SOURCE_UNUSABLE` when it is missing or not a directory.
 */
async function realSource(path: string): Promise<{ readonly path: string, readonly dev: number }> {
  let real: string
  let stats: Stats
  try {
    real = await realpath(resolve(path))
    stats = await lstat(real)
  } catch (error: unknown) {
    throw new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', `the DeepSeek Harness home could not be read (${systemCode(error)})`)
  }
  if (!stats.isDirectory()) throw new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', 'the DeepSeek Harness home is not a directory')
  return { path: real, dev: stats.dev }
}

/**
 * Refuse two homes where one holds the other.
 * @param source - the stock home's real path.
 * @param target - the Delo home's path.
 * @throws DshImportError `DSH_IMPORT_SOURCE_UNUSABLE` when they are one directory or either lies inside the other.
 */
async function refuseOverlap(source: string, target: string): Promise<void> {
  // A Delo home that does not exist yet, or that cannot be resolved, overlaps by its path alone.
  const real = await realpath(target).catch(() => target)
  if (!inside(source, real) && !inside(real, source)) return
  throw new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', 'the DeepSeek Harness home and the Delo home overlap, and an import never reads the home it writes into')
}

/**
 * The SHA-256 of bytes in memory.
 * @param bytes - the bytes.
 * @returns the lowercase hexadecimal digest.
 */
export function digestOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The walk of one plan, with what it has found so far. */
class Planner {
  private readonly id: string
  private readonly chats: DshImportChat[] = []
  private readonly attachments: DshHashedFile[] = []
  private attachmentsPresent = 0
  private registry: DshImportRegistry | undefined
  /** The stock list as read, its document, the workspace each chat is filed under, and why each held workspace is held. */
  private stock: { readonly registry: Registry, readonly source: DshImportText, readonly filed: ReadonlyMap<string, string>, readonly held: ReadonlyMap<string, string> } | undefined
  private readonly profiles: DshImportProfile[] = []
  private readonly layers: DshImportLayer[] = []
  private instructions: DshImportInstructions | undefined
  private readonly skills: DshImportSkill[] = []
  private credentials: DshImportCredentials | undefined
  private readonly skipped: DshImportSkip[] = []
  private readonly totals: Partial<Record<DshImportSkipReason, number>> = {}
  private readonly blockers: DshImportError[] = []
  /** Whether the walk met a chat generation, a profile manifest or a workspace list: what makes the directory a DeepSeek Harness home. */
  private marked = false
  /** The stock home patch's text when the plan read it, and the home patch a profile runs under in the Delo home. */
  private homePatches: { readonly stock: string | undefined, readonly landed: string | null | undefined, readonly own: boolean } = { stock: undefined, landed: undefined, own: false }

  /**
   * @param reader - the stock home's reader.
   * @param target - the Delo home.
   * @param options - the plan's options.
   */
  constructor(private readonly reader: SourceReader, private readonly target: string, private readonly options: DshImportOptions) {
    this.id = options.planId ?? randomUUID()
  }

  /**
   * Walk both homes.
   * @param limits - the limits.
   * @returns the plan.
   */
  async plan(limits: DshImportLimits): Promise<DshHomeImportPlan> {
    const names = await this.reader.list('')
    if (!names.some(name => rootEntryKind(name).kind !== 'skip' || ['logs', 'cache'].includes(name))) throw notStockHome()
    const deloSessions = await this.deloSessions()
    // The home patch decides which home patch every profile lands under, and the workspace list which chats are
    // carried, so both are read first.
    const first = ['cordis.patch.yml', 'storages']
    const ordered = [...first.filter(name => names.includes(name)), ...names.filter(name => !first.includes(name))]
    if (!names.includes('cordis.patch.yml')) this.homePatches = this.ownHomePatch(await this.targetText('cordis.patch.yml'))
    for (const name of ordered) await this.root(name, deloSessions)
    if (!this.marked) throw notStockHome()
    this.dropEscaping()
    await this.finishRegistry()
    const merge = this.options.merge === true
    if (deloSessions.size > 0 && !merge) {
      this.blockers.unshift(new DshImportError('DSH_IMPORT_HOME_HAS_CHATS', `the Delo home already holds ${String(deloSessions.size)} ${deloSessions.size === 1 ? 'chat' : 'chats'}; to add these beside them, run the import again with --merge`))
    }
    const bytes = this.checkSizes(limits)
    return {
      id: this.id,
      source: this.reader.root,
      sourceDevice: this.reader.rootDevice,
      target: this.target,
      merge,
      limits,
      deloBundles: this.options.deloBundles,
      chats: this.chats,
      attachments: this.attachments,
      attachmentsPresent: this.attachmentsPresent,
      registry: this.registry,
      profiles: this.profiles,
      layers: this.layers,
      instructions: this.instructions,
      skills: this.skills,
      credentials: this.credentials,
      skipped: [...this.skipped].sort((left, right) => compareNames(left.path, right.path)),
      skippedTotals: this.totals,
      deloChats: deloSessions.size,
      bytes,
      blockers: this.blockers,
    }
  }

  /**
   * Leave behind every attachment and skill holding a file with a hard link from outside the stock home; a skill goes
   * whole. A chat whose generation has any second link, and a document the import parses with one, are refused before
   * they are read.
   */
  private dropEscaping(): void {
    const escapes = (files: readonly DshImportFile[]): boolean => files.some(file => this.reader.escapes(file))
    const keep = <T>(items: T[], files: (item: T) => readonly DshImportFile[], path: (item: T) => string): void => {
      const kept = items.filter((item) => {
        if (!escapes(files(item))) return true
        this.skip(path(item), 'hard-link')
        return false
      })
      items.splice(0, items.length, ...kept)
    }
    keep(this.attachments, file => [file], file => file.path)
    keep(this.skills, skill => skill.files, skill => skill.path)
  }

  /**
   * Refuse a plan past the size limits.
   * @param limits - the limits.
   * @returns the bytes the import copies with every category taken.
   * @throws DshImportError `DSH_IMPORT_ENTRY_TOO_LARGE` for one file over the per-file limit and `DSH_IMPORT_TOTAL_TOO_LARGE` for a total over the total limit.
   */
  private checkSizes(limits: DshImportLimits): number {
    const files = [
      ...this.chats.filter(chat => chat.state === 'new').flatMap(chat => chat.files),
      ...this.attachments,
      ...this.registry === undefined || this.registry.mode === 'present' ? [] : [this.registry.source.file],
      ...this.instructions?.state === 'new' ? [this.instructions.source.file] : [],
      ...this.skills.flatMap(skill => skill.files),
    ]
    const layers = [...this.layers, ...this.profiles.flatMap(profile => profile.patch === undefined ? [] : [profile.patch])]
    const generated = [...this.profiles.map(profile => profile.manifest), ...layers.flatMap(layer => [layer.carried ?? '', layer.heldText ?? ''])]
    let total = generated.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    for (const file of files) {
      if (file.size > limits.maxFileBytes) {
        throw new DshImportError('DSH_IMPORT_ENTRY_TOO_LARGE', `the file ${JSON.stringify(file.path)} holds ${String(file.size)} bytes, more than the ${String(limits.maxFileBytes)} one imported file may hold`, file.path)
      }
      total += file.size
    }
    if (total > limits.maxTotalBytes) {
      throw new DshImportError('DSH_IMPORT_TOTAL_TOO_LARGE', `the import would copy ${String(total)} bytes, more than the limit of ${String(limits.maxTotalBytes)}; to import it anyway, give a larger limit in bytes with --max-size`)
    }
    return total
  }

  /**
   * Plan one root entry.
   * @param name - its name.
   * @param deloSessions - the Delo home's chats, by Session directory name, with their project directory.
   */
  private async root(name: string, deloSessions: ReadonlyMap<string, string>): Promise<void> {
    const kind = rootEntryKind(name)
    if (kind.kind === 'skip') return this.skip(name, kind.reason)
    const entry = await this.reader.inspect(name)
    if (entry.kind === 'refused') return this.skip(name, entry.reason)
    switch (kind.kind) {
      case 'sessions':
        return entry.kind === 'directory' ? this.sessions(deloSessions) : this.skip(name, 'unknown')
      case 'attachments':
        return entry.kind === 'directory' ? this.attachmentRoot() : this.skip(name, 'unknown')
      case 'storages':
        return entry.kind === 'directory' ? this.storages() : this.skip(name, 'unknown')
      case 'profiles':
        return entry.kind === 'directory' ? this.profileRoot() : this.skip(name, 'unknown')
      case 'skills':
        return entry.kind === 'directory' ? this.skillRoot() : this.skip(name, 'unknown')
      case 'credentials':
        return entry.kind === 'file' ? this.credentialDocument(entry.file) : this.skip(name, 'unknown')
      case 'layer':
        return entry.kind === 'file' ? this.rootLayer(entry.file, kind.layer) : this.skip(name, 'unknown')
      case 'instructions':
        return entry.kind === 'file' ? this.instructionDocument(entry.file) : this.skip(name, 'unknown')
    }
  }

  /**
   * Record one entry left behind. Every one is counted; the first {@link SKIPPED_LIST_LIMIT} of each reason are listed.
   * @param path - its path relative to the stock home.
   * @param reason - why.
   * @param detail - more, when the reason does not say it.
   */
  private skip(path: string, reason: DshImportSkipReason, detail?: string): void {
    const count = (this.totals[reason] ?? 0) + 1
    this.totals[reason] = count
    if (count <= SKIPPED_LIST_LIMIT) this.skipped.push(detail === undefined ? { path, reason } : { path, reason, detail })
  }

  /**
   * Record the reason a name is not carried: unsafe when it breaks the name rules, otherwise unknown.
   * @param path - the entry's path.
   * @param name - its last segment.
   */
  private skipName(path: string, name: string): void {
    this.skip(path, isSafeSegment(name) ? 'unknown' : 'unsafe-name')
  }

  /**
   * The Delo home's chats.
   * @returns each Session directory name with its project directory.
   * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when the Delo home's sessions root is not a directory or cannot be read.
   */
  private async deloSessions(): Promise<Map<string, string>> {
    const sessions = new Map<string, string>()
    const root = join(this.target, 'sessions')
    const stats = await this.targetStats('sessions')
    if (stats === undefined) return sessions
    if (!stats.isDirectory()) throw refusedTarget('sessions')
    try {
      for (const project of await readdir(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
          if (session.isDirectory()) sessions.set(session.name, project.name)
        }
      }
    } catch {
      // EACCES or EIO: the chats the Delo home holds cannot be known, so nothing can be checked against them.
      throw refusedTarget('sessions')
    }
    return sessions
  }

  /**
   * Plan every chat of the stock home.
   * @param deloSessions - the Delo home's chats.
   */
  private async sessions(deloSessions: ReadonlyMap<string, string>): Promise<void> {
    for (const project of await this.reader.list('sessions')) {
      const path = `sessions/${project}`
      const entry = await this.reader.inspect(path)
      if (entry.kind === 'refused') this.skip(path, entry.reason)
      else if (entry.kind === 'file' || !isProjectName(project)) this.skipName(path, project)
      else await this.project(path, deloSessions)
    }
  }

  /**
   * Plan the chats of one project directory. A flat chat file beside the Session directories is upstream's
   * retired layout, which upstream refuses for the whole directory, so the directory is left behind.
   * @param path - `sessions/<project>`.
   * @param deloSessions - the Delo home's chats.
   */
  private async project(path: string, deloSessions: ReadonlyMap<string, string>): Promise<void> {
    const entries: [string, InspectedEntry][] = []
    for (const name of await this.reader.list(path)) entries.push([name, await this.reader.inspect(`${path}/${name}`)])
    if (entries.some(([name, entry]) => entry.kind === 'file' && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')))) {
      this.marked = true
      return this.skip(path, 'legacy-layout', 'it holds chats in the flat-file layout')
    }
    for (const [name, entry] of entries) {
      const session = `${path}/${name}`
      if (entry.kind === 'refused') this.skip(session, entry.reason)
      else if (entry.kind === 'file' || !isSessionName(name)) this.skipName(session, name)
      else await this.session(session, name, deloSessions)
    }
  }

  /**
   * Plan one chat, which is carried whole or not at all.
   * @param path - `sessions/<project>/<session>`.
   * @param name - the Session directory's name.
   * @param deloSessions - the Delo home's chats.
   */
  private async session(path: string, name: string, deloSessions: ReadonlyMap<string, string>): Promise<void> {
    const files: DshImportFile[] = []
    const versions = new Map<DshImportFile, number>()
    for (const child of await this.reader.list(path)) {
      const childPath = `${path}/${child}`
      const kind = sessionFileKind(child)
      const entry = await this.reader.inspect(childPath)
      if (kind.kind === 'generation' || kind.kind === 'uncompressed') {
        this.marked = true
        // A generation that cannot be carried takes the chat with it: without it upstream would read an older one.
        if (entry.kind === 'refused') return this.skip(path, entry.reason, `its generation ${child} is not a plain file`)
        if (entry.kind === 'directory') return this.skip(path, 'unknown', `its generation ${child} is a directory`)
        if (kind.kind === 'uncompressed') return this.skip(path, 'uncompressed-sessions')
        if (kind.version > SESSION_FORMAT_VERSION) return this.skip(path, 'newer-session', `its generation ${child} has format version ${String(kind.version)}; this build reads up to ${String(SESSION_FORMAT_VERSION)}`)
        files.push(entry.file)
        versions.set(entry.file, kind.version)
      } else if (entry.kind === 'refused') {
        this.skip(childPath, entry.reason)
      } else {
        this.skip(childPath, kind.kind === 'runtime-state' && entry.kind === 'file' ? 'runtime-state' : 'unknown')
      }
    }
    if (files.length === 0) return this.skip(path, 'unknown', 'it holds no chat generation')
    // Upstream replaces a generation by a rename and never links one, so a second link can only come from elsewhere.
    const linked = files.find(file => file.nlink > 1)
    if (linked !== undefined) return this.skip(path, 'hard-link', `its generation ${linked.path.slice(path.length + 1)} has another hard link`)
    const [newest] = [...files].sort((left, right) => (versions.get(right) as number) - (versions.get(left) as number)) as [DshImportFile]
    const scan = new ChatLogScan(newest.size)
    const hashed: DshHashedFile[] = []
    for (const file of files) hashed.push({ ...file, sha256: await this.reader.hash(file, file === newest ? chunk => scan.feed(chunk) : undefined) })
    const log = await scan.finish()
    if (typeof log === 'string') return this.skip(path, 'unreadable', `its log cannot be read: ${log}`)
    if (log.id !== decodeSessionName(name)) return this.skip(path, 'unreadable', 'its header names another chat than its folder')
    if (log.openTurn) return this.skip(path, 'unfinished-turn')
    const refusal = this.cwdRefusal(log.id, log.cwd)
    if (refusal !== undefined) return this.skip(path, refusal.reason, refusal.detail)
    const chat = { path, id: log.id, cwd: log.cwd, files: hashed }
    const held = deloSessions.get(name)
    if (held === undefined) {
      this.chats.push({ ...chat, state: 'new' })
      return
    }
    if (`sessions/${held}/${name}` === path && await this.sameChat(path, hashed)) {
      this.chats.push({ ...chat, state: 'present' })
      return
    }
    this.blockers.push(new DshImportError('DSH_IMPORT_ID_COLLISION', `the Delo home already holds the chat ${JSON.stringify(name)} with other content, and an import never overwrites a chat`, path))
  }

  /**
   * Why a chat's working folder keeps it from being carried: a chat filed under a workspace must work inside that
   * workspace's folder, a workspace in a sensitive folder takes its chats with it, and a chat filed under none must
   * not work in a sensitive folder.
   * @param id - the chat's Session identifier.
   * @param cwd - its working folder.
   * @returns the reason and its detail, or `undefined` when the chat is carried.
   */
  private cwdRefusal(id: string, cwd: string | undefined): { readonly reason: DshImportSkipReason, readonly detail: string } | undefined {
    const stock = this.stock
    const workspace = stock?.filed.get(id)
    if (stock === undefined || workspace === undefined) {
      const sensitive = cwd === undefined ? undefined : sensitiveFolder(cwd, this.folders())
      return sensitive === undefined ? undefined : { reason: 'sensitive-folder', detail: `its folder ${JSON.stringify(cwd)} is ${sensitive}` }
    }
    const record = stock.registry.records.get(workspace) as WorkspaceRecord
    const held = stock.held.get(workspace)
    if (held !== undefined) return { reason: 'sensitive-folder', detail: `its workspace ${JSON.stringify(record.title)} at ${JSON.stringify(record.path)} is ${held}` }
    if (cwd === undefined || !inside(record.path, cwd)) {
      return { reason: 'outside-workspace', detail: `it works in ${cwd === undefined ? 'no folder' : JSON.stringify(cwd)}, outside its workspace ${JSON.stringify(record.title)} at ${JSON.stringify(record.path)}` }
    }
    return undefined
  }

  /**
   * The folders no workspace or chat may stand in.
   * @returns the person's home and the two Harness homes.
   */
  private folders(): SensitiveFolders {
    return { personHome: this.options.personHome, stockHome: this.reader.root, deloHome: this.target }
  }

  /**
   * Whether the Delo home holds one chat with exactly these generations.
   * @param path - the chat's path.
   * @param files - the stock generations.
   * @returns true when the Delo directory's generations are the same names with the same bytes.
   */
  private async sameChat(path: string, files: readonly DshHashedFile[]): Promise<boolean> {
    const held = (await readdir(join(this.target, path))).filter(name => sessionFileKind(name).kind === 'generation').sort(compareNames)
    if (held.join('/') !== files.map(file => file.path.slice(path.length + 1)).join('/')) return false
    for (const file of files) {
      if (await this.compare(file, file.sha256) !== 'present') return false
    }
    return true
  }

  /** Plan `attachments/`: the version 1 stores, without the request-image cache. */
  private async attachmentRoot(): Promise<void> {
    for (const name of await this.reader.list('attachments')) {
      const path = `attachments/${name}`
      if (name !== 'v1') {
        this.skipName(path, name)
        continue
      }
      const entry = await this.reader.inspect(path)
      if (entry.kind === 'refused') this.skip(path, entry.reason)
      else if (entry.kind === 'file') this.skip(path, 'unknown')
      else await this.attachmentStores()
    }
  }

  /** Plan the attachment stores of `attachments/v1/`. */
  private async attachmentStores(): Promise<void> {
    for (const name of await this.reader.list('attachments/v1')) {
      const path = `attachments/v1/${name}`
      if (name === 'request-images') this.skip(path, 'cache')
      else if (!['objects', 'file-objects', 'files'].includes(name)) this.skipName(path, name)
      else await this.tree(path, file => this.attachment(file))
    }
  }

  /**
   * Plan one attachment file, which is carried only when its bytes have the digest its path names.
   * @param file - the file.
   */
  private async attachment(file: DshImportFile): Promise<void> {
    const address = attachmentAddress(file.path)
    if (address === undefined) return this.skip(file.path, 'not-addressed', 'its path names no content address')
    const digest = await this.reader.hash(file)
    if (digest !== address) return this.skip(file.path, 'not-addressed')
    const state = await this.compare(file, digest)
    if (state === 'new') this.attachments.push({ ...file, sha256: digest })
    else if (state === 'present') this.attachmentsPresent += 1
    else this.blockers.push(new DshImportError('DSH_IMPORT_ID_COLLISION', `the Delo home holds the attachment ${JSON.stringify(file.path)} with other bytes, and an import never overwrites an attachment`, file.path))
  }

  /**
   * Walk one tree of plain files and directories.
   * @param path - the tree's path, which the caller inspected as a directory.
   * @param onFile - receives each regular file the tree holds.
   */
  private async tree(path: string, onFile: (file: DshImportFile) => Promise<void> | void): Promise<void> {
    const entry = await this.reader.inspect(path)
    if (entry.kind === 'refused') return this.skip(path, entry.reason)
    if (entry.kind === 'file') return onFile(entry.file)
    for (const name of await this.reader.list(path)) {
      const child = `${path}/${name}`
      if (!isSafeSegment(name)) this.skip(child, 'unsafe-name')
      else if (isRuntimeState(name)) this.skip(child, 'runtime-state')
      else await this.tree(child, onFile)
    }
  }

  /** Plan `storages/`: the workspace list is carried, every other unit is named with its reason. */
  private async storages(): Promise<void> {
    for (const name of await this.reader.list('storages')) {
      const path = `storages/${name}`
      const kind = storageUnitKind(name)
      if (kind !== 'workspaces') {
        this.skip(path, kind)
        continue
      }
      const entry = await this.reader.inspect(path)
      if (entry.kind === 'refused') this.skip(path, entry.reason)
      else if (entry.kind === 'directory') this.skip(path, 'unknown')
      else await this.workspaceList(entry.file)
    }
  }

  /**
   * Read the workspace list, and hold back each workspace whose folder is a sensitive one. Which chats it lists is
   * decided once the chats are planned ({@link finishRegistry}).
   * @param file - the stock registry document.
   */
  private async workspaceList(file: DshImportFile): Promise<void> {
    this.marked = true
    const read = await this.text(file, PARSED_DOCUMENT_BYTES)
    if (read === undefined) return
    let registry: Registry
    try {
      registry = parseRegistry(read.text)
    } catch (error: unknown) {
      return this.skip(file.path, 'unreadable', (error as Error).message)
    }
    if (registry.state.pendingMutation !== undefined) {
      this.blockers.push(new DshImportError('DSH_IMPORT_REGISTRY_REFUSED', 'the stock workspace list was interrupted while it changed; start DeepSeek Harness once so it finishes the change, stop it, and import again', REGISTRY_PATH))
      return
    }
    const filed = new Map<string, string>()
    const held = new Map<string, string>()
    for (const [id, record] of registry.records) {
      for (const session of record.sessionIds) filed.set(session, id)
      const sensitive = sensitiveFolder(record.path, this.folders())
      if (sensitive !== undefined) held.set(id, sensitive)
    }
    this.stock = { registry, source: { file: { ...file, sha256: read.sha256 }, sha256: read.sha256 }, filed, held }
  }

  /** Plan how the workspace list lands: only the workspaces and chats the import carries, copied or merged. */
  private async finishRegistry(): Promise<void> {
    const stock = this.stock
    if (stock === undefined) return
    const carried = new Set(this.chats.map(chat => chat.id))
    const registry = restrictRegistry(stock.registry, id => !stock.held.has(id), id => carried.has(id))
    const listed = [...stock.registry.records].map(([id, record]) => ({
      id,
      title: record.title,
      path: record.path,
      chats: registry.records.get(id)?.sessionIds.length ?? 0,
      held: stock.held.get(id),
    }))
    const planned = { source: stock.source, registry, listed, workspaces: registry.records.size }
    const held = await this.targetStats(REGISTRY_PATH)
    if (held === undefined) {
      this.registry = { ...planned, mode: 'copy' }
      return
    }
    let delo: Registry
    try {
      if (!held.isFile()) throw new Error('it is not a file')
      delo = parseRegistry(await readFile(join(this.target, REGISTRY_PATH), 'utf8'))
    } catch (error: unknown) {
      this.blockers.push(new DshImportError('DSH_IMPORT_REGISTRY_REFUSED', `the Delo home's workspace list cannot be read (${(error as Error).message}), so the stock workspaces cannot join it`, REGISTRY_PATH))
      return
    }
    try {
      this.registry = { ...planned, mode: mergeRegistries(delo, registry) === undefined ? 'present' : 'merge' }
    } catch (error: unknown) {
      this.blockers.push(error as DshImportError)
    }
  }

  /** Plan `profiles/`: each profile lands under its own name, apart from the desktop app's and a name the Delo home holds. */
  private async profileRoot(): Promise<void> {
    const reserved = (this.options.reservedProfiles ?? []).map(name => name.toLowerCase())
    for (const name of await this.reader.list('profiles')) {
      const path = `profiles/${name}`
      const entry = await this.reader.inspect(path)
      if (entry.kind === 'refused') this.skip(path, entry.reason)
      else if (entry.kind === 'file') this.skipName(path, name)
      else if (!isProfileName(name)) this.skip(path, 'unsafe-name')
      else if (name.toLowerCase() === DESKTOP_PROFILE_NAME) this.skip(path, 'desktop-profile')
      else if (reserved.includes(name.toLowerCase()) || await this.targetStats(path) !== undefined) this.skip(path, 'taken')
      else await this.profile(name, path)
    }
  }

  /**
   * Plan one profile, which lands whole or not at all.
   * @param name - the profile's name.
   * @param path - `profiles/<name>`.
   */
  private async profile(name: string, path: string): Promise<void> {
    const read: Partial<Record<(typeof PROFILE_CARRIED_FILES)[number], DshImportFile>> = {}
    for (const child of await this.reader.list(path)) {
      const childPath = `${path}/${child}`
      if (!(PROFILE_CARRIED_FILES as readonly string[]).includes(child)) {
        this.skip(childPath, Object.hasOwn(PROFILE_SKIPS, child) ? PROFILE_SKIPS[child] as DshImportSkipReason : isRuntimeState(child) ? 'runtime-state' : 'unknown')
        continue
      }
      const entry = await this.reader.inspect(childPath)
      if (entry.kind === 'refused') return this.skip(path, entry.reason, `its ${child} is not a plain file`)
      if (entry.kind === 'directory') return this.skip(path, 'unknown', `its ${child} is a directory`)
      read[child as (typeof PROFILE_CARRIED_FILES)[number]] = entry.file
    }
    const manifestFile = read['package.json']
    if (manifestFile === undefined) return this.skip(path, 'unreadable', 'it holds no package.json')
    this.marked = true
    const manifestText = await this.text(manifestFile, PARSED_DOCUMENT_BYTES, path)
    const patchText = read['cordis.patch.yml'] === undefined ? undefined : await this.text(read['cordis.patch.yml'], PARSED_DOCUMENT_BYTES, path)
    if (manifestText === undefined || (patchText === undefined && read['cordis.patch.yml'] !== undefined)) return
    let manifest: unknown
    try {
      manifest = JSON.parse(manifestText.text)
    } catch {
      // A manifest that is not JSON: upstream refuses the profile too.
      return this.skip(path, 'unreadable', 'its package.json is not JSON')
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return this.skip(path, 'unreadable', 'its package.json is not a JSON object')
    let landed
    try {
      landed = landManifest(manifest, name, `${path}/package.json`, this.options.deloBundles)
    } catch (error: unknown) {
      if (!isProfileSafetyError(error)) throw error
      return this.skip(path, 'unreadable', 'its bundle list is not a list of package names')
    }
    const patch = patchText === undefined ? undefined : this.layer(patchText, 'profile-patch', `${path}/cordis.patch.yml`, 'new', splitPatchLayer(patchText.text))
    this.profiles.push({
      name,
      source: manifestText,
      manifest: landed.text,
      patch,
      bundles: landed.bundles,
      plugins: landed.plugins,
      carry: carryNotes({
        stockManifest: manifestText.text,
        stockPatch: patchText?.text,
        stockHomePatch: this.homePatches.stock,
        landedManifest: landed.text,
        landedPatch: patch?.carried,
        landedHomePatch: this.homePatches.landed,
        ownHomePatch: this.homePatches.own,
        bundles: landed.bundles,
      }),
    })
  }

  /**
   * One split layer as the plan holds it.
   * @param source - the stock layer.
   * @param kind - which layer it is.
   * @param target - where its carried rows land.
   * @param state - whether they land.
   * @param split - the split.
   * @returns the layer.
   */
  private layer(source: DshImportText & { readonly text: string }, kind: DshImportLayer['kind'], target: string, state: DshImportLayer['state'], split: SplitLayer): DshImportLayer {
    const { file, sha256 } = source
    const held = split.heldText === undefined ? undefined : `${STOCK_IMPORT_DIRECTORY}/import-${this.id}/held/${target}`
    return { source: { file, sha256 }, kind, target, state, carried: split.carried, carriedLabels: split.carriedLabels, held: split.held, heldPath: held, heldText: split.heldText, expressions: split.expressions }
  }

  /**
   * Plan the home patch or the earlier settings: the carried rows land in the Delo home's file of that name when it
   * holds none, and everything held back lands inert.
   * @param file - the stock document.
   * @param kind - which layer it is.
   */
  private async rootLayer(file: DshImportFile, kind: 'home-patch' | 'settings'): Promise<void> {
    const read = await this.text(file, PARSED_DOCUMENT_BYTES)
    if (read === undefined) {
      if (kind === 'home-patch') this.homePatches = this.ownHomePatch(await this.targetText(file.path))
      return
    }
    const split = kind === 'home-patch' ? splitPatchLayer(read.text) : splitSettingsLayer(read.text)
    const held = await this.targetText(file.path)
    const state = held === undefined ? 'new' : held === split.carried ? 'present' : 'taken'
    this.layers.push(this.layer(read, kind, file.path, state, state === 'taken' ? { ...wholeHeld(read.text, 'taken'), expressions: split.expressions } : split))
    if (kind === 'home-patch') this.homePatches = held === undefined ? { stock: read.text, landed: split.carried, own: false } : { stock: read.text, landed: held, own: true }
  }

  /**
   * The home patches when the plan reads no stock home patch: a profile runs under the Delo home's own, if it has one.
   * @param held - the Delo home's home patch, as {@link targetText} read it.
   * @returns the home patches.
   */
  private ownHomePatch(held: string | null | undefined): Planner['homePatches'] {
    return { stock: undefined, landed: held, own: held !== undefined }
  }

  /**
   * Plan the instructions for every chat.
   * @param file - the stock `AGENTS.md`.
   */
  private async instructionDocument(file: DshImportFile): Promise<void> {
    const read = await this.text(file, PARSED_DOCUMENT_BYTES)
    if (read === undefined) return
    const state = await this.compare(file, read.sha256)
    if (state === 'different') return this.skip(file.path, 'taken')
    const lines = read.text.split(/\r?\n/u)
    if (lines.at(-1) === '') lines.pop()
    this.instructions = { source: { file: { ...file, sha256: read.sha256 }, sha256: read.sha256 }, state, text: read.text, lines: lines.length }
  }

  /** Plan `skills/`: each skill lands unless the Delo home holds one of that name. */
  private async skillRoot(): Promise<void> {
    for (const name of await this.reader.list('skills')) {
      const path = `skills/${name}`
      if (!isSafeSegment(name)) {
        this.skip(path, 'unsafe-name')
        continue
      }
      if (await this.targetStats(path) !== undefined) {
        this.skip(path, 'taken')
        continue
      }
      const files: DshImportFile[] = []
      await this.tree(path, (file) => { files.push(file) })
      if (files.length === 0) continue
      const document = files.find(file => file.path === `${path}/SKILL.md`)
      if (document !== undefined && document.size > SKILL_DOCUMENT_BYTES) {
        this.skip(path, 'too-large', `its SKILL.md holds ${String(document.size)} bytes, more than the import shows`)
        continue
      }
      const hashed: DshHashedFile[] = []
      let instructions: string | undefined
      for (const file of files) {
        if (file !== document || file.nlink > 1) {
          hashed.push({ ...file, sha256: await this.reader.hash(file) })
          continue
        }
        const bytes = await this.reader.read(file)
        instructions = bytes.toString('utf8')
        hashed.push({ ...file, sha256: digestOf(bytes) })
      }
      this.skills.push({ path, files: hashed, description: instructions === undefined ? undefined : skillDescription(instructions), instructions, bytes: files.reduce((sum, file) => sum + file.size, 0) })
    }
  }

  /**
   * Plan the credentials document: the names are read, the values stay in the file.
   * @param file - the stock document.
   */
  private async credentialDocument(file: DshImportFile): Promise<void> {
    const read = await this.text(file, CREDENTIALS_DOCUMENT_BYTES)
    if (read === undefined) return
    let stock
    try {
      stock = readCredentials(read.text, `the stock home's ${CREDENTIALS_PATH}`)
    } catch (error: unknown) {
      return this.skip(file.path, 'unreadable', (error as Error).message)
    }
    const held = await this.targetStats(CREDENTIALS_PATH)
    let delo
    try {
      if (held !== undefined && !held.isFile()) throw new Error('it is not a file')
      delo = held === undefined ? undefined : readCredentials(await readFile(join(this.target, CREDENTIALS_PATH), 'utf8'), `the Delo home's ${CREDENTIALS_PATH}`)
    } catch (error: unknown) {
      return this.skip(file.path, 'unreadable', `the Delo home's credentials document cannot be read: ${(error as Error).message}`)
    }
    this.credentials = { file, entries: compareCredentials(stock, delo) }
  }

  /**
   * Read one stock document whole through the guarded reader, or record why it is left behind.
   * @param file - the document.
   * @param maxBytes - the most bytes the import reads into memory.
   * @param owner - the entry the document belongs to, which is left behind with it; the document itself by default.
   * @returns its text and digest, or `undefined` when it is left behind.
   */
  private async text(file: DshImportFile, maxBytes: number, owner = file.path): Promise<(DshImportText & { readonly text: string }) | undefined> {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    const detail = (why: string): string => owner === file.path ? `it ${why}` : `its ${name} ${why}`
    // A document is never hard-linked by the harness that writes it, and one whose other link is outside would be read whole.
    if (file.nlink > 1) {
      this.skip(owner, 'hard-link', owner === file.path ? undefined : `its ${name} has another hard link`)
      return undefined
    }
    if (file.size > maxBytes) {
      this.skip(owner, 'too-large', detail(`holds ${String(file.size)} bytes`))
      return undefined
    }
    const bytes = await this.reader.read(file)
    const sha256 = digestOf(bytes)
    return { file: { ...file, sha256 }, sha256, text: bytes.toString('utf8') }
  }

  /**
   * Compare one stock file with what the Delo home holds at its path.
   * @param file - the stock file.
   * @param digest - its digest, which the plan read.
   * @returns `new` when nothing is there, `present` for the same bytes, `different` for anything else.
   */
  private async compare(file: DshImportFile, digest: string): Promise<'new' | 'present' | 'different'> {
    const held = await this.targetStats(file.path)
    if (held === undefined) return 'new'
    if (!held.isFile() || held.size !== file.size) return 'different'
    return await targetDigest(join(this.target, file.path)) === digest ? 'present' : 'different'
  }

  /**
   * The text of one Delo home document within the size the import parses.
   * @param path - the home-relative path.
   * @returns its text, `undefined` when nothing is there, and `null` when it is not a plain file the import reads.
   */
  private async targetText(path: string): Promise<string | null | undefined> {
    const held = await this.targetStats(path)
    if (held === undefined) return undefined
    if (!held.isFile() || held.size > PARSED_DOCUMENT_BYTES) return null
    return readFile(join(this.target, path), 'utf8')
  }

  /**
   * The status of one Delo home path, without following a link.
   * @param path - the home-relative path.
   * @returns the status, or `undefined` when nothing is there.
   * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when a directory on the way is a file or a link.
   */
  private async targetStats(path: string): Promise<Stats | undefined> {
    try {
      return await lstat(join(this.target, path))
    } catch (error: unknown) {
      if (systemCode(error) === 'ENOENT') return undefined
      throw refusedTarget(path)
    }
  }
}

/**
 * The description a skill's `SKILL.md` declares in its front matter.
 * @param text - the `SKILL.md` text.
 * @returns the description's first line, or `undefined` when it declares none the plan reads.
 */
function skillDescription(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1]
  if (front === undefined) return undefined
  const description: unknown = parseDocument(front, { logLevel: 'error' }).get('description')
  return typeof description === 'string' && description.trim() !== '' ? description.trim().split(/\r?\n/u)[0] : undefined
}

/**
 * The refusal of a directory that is not a DeepSeek Harness home.
 * @returns the refusal.
 */
function notStockHome(): DshImportError {
  return new DshImportError('DSH_IMPORT_SOURCE_UNUSABLE', 'the directory is not a DeepSeek Harness home: it holds no chat, no profile with a package.json and no workspace list')
}

/**
 * The refusal of a Delo home path the import cannot write through.
 * @param path - the home-relative path.
 * @returns the refusal.
 */
export function refusedTarget(path: string): DshImportError {
  return new DshImportError('DSH_IMPORT_TARGET_REFUSED', `the Delo home's ${JSON.stringify(path)} is not a directory the import writes into`, path)
}

/**
 * The SHA-256 of one Delo home file.
 * @param path - the absolute path.
 * @returns the lowercase hexadecimal digest.
 */
async function targetDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
