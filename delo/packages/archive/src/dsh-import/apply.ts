/**
 * Carrying out a plan: staging, the journal, publication and the way back.
 *
 * Every file the import writes is first staged under
 * `archive/stock-import/staging-<id>/files/` in the Delo home, a directory the
 * import creates without `recursive`, at mode 0700 with files that keep only
 * their owner's permission bits. A copied file is hashed while it is copied,
 * and an attachment whose bytes do not have the digest its path names, or a
 * document whose digest is not the one the plan showed, stops the import.
 * Every staged file is synced, in concurrent batches, and then a journal,
 * itself synced before the rename that places it, names every directory the import will create and
 * every file it will place; only then does publication begin. A new file is
 * placed by one hard link from its staged copy, which fails on a path that
 * exists, so an import never replaces a file. The one kind of file an import
 * changes, a document the Delo home already holds and the import adds to (the
 * workspace list in a merge, the credentials document, the import record), is
 * first linked aside into the staging root and then replaced by one rename.
 *
 * The journal's removal is the moment the import is complete. A failure
 * before it withdraws every file the journal names whose inode is the staged
 * file's, puts each replaced document back, removes the directories it
 * created when they are empty, and removes the staging root. A crash before
 * it leaves the journal, and {@link recoverDshImport}, which `delorun
 * import-home` runs before every import, does the same withdrawal; once the
 * start path calls {@link recoverStockImport}, every profile start does it
 * too, and a journal it cannot read keeps Delo from starting. A withdrawal
 * removes only a file whose bytes are still the ones the journal recorded, so
 * a chat that a profile wrote to since stays, and is reported. So the Delo
 * home holds either none of an import or all of it. The staged copies hold
 * chat content, so a staging root left by a crash after completion is removed
 * by the next recovery too.
 *
 * @module @delo/archive/dsh-import/apply
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { compareCredentials, CREDENTIALS_PATH, mergeCredentials, readCredentials } from './credentials.ts'
import { DshImportError, isDshImportError, systemCode } from './errors.ts'
import { isSafeSegment, STOCK_IMPORT_DIRECTORY } from './layout.ts'
import { digestOf, refusedTarget, type DshHomeImportPlan, type DshImportCategory, type DshImportText } from './plan.ts'
import { SourceReader, type DshHashedFile, type DshImportFile } from './source.ts'
import { mergeRegistries, parseRegistry, REGISTRY_PATH, serializeRegistry } from './workspaces.ts'

export { STOCK_IMPORT_DIRECTORY }

/** The journal's name inside {@link STOCK_IMPORT_DIRECTORY}. */
export const STOCK_IMPORT_JOURNAL = 'journal.json'

/** The record's name inside {@link STOCK_IMPORT_DIRECTORY}: what every completed import carried. */
export const STOCK_IMPORT_RECORD = 'imports.json'

/** The prefix of a staging root's name. */
const STAGING_PREFIX = 'staging-'

/** A digest the journal records. */
const DIGEST = /^[0-9a-f]{64}$/u

/** A staging root's name. */
const STAGING_NAME = /^staging-[A-Za-z0-9-]{1,64}$/u

/** The permission bits of every directory the import creates. */
const DIRECTORY_MODE = 0o700

/** The permission bits of every document the import writes itself. */
const DOCUMENT_MODE = 0o600

/** How one import is carried out. */
export interface DshImportApplyOptions {
  /** The categories the person said yes to, each after seeing it; a category not named here lands nothing. */
  readonly include: Readonly<Partial<Record<DshImportCategory, boolean>>>
  /** The clock of the record; the system clock by default. */
  readonly now?: () => Date
  /** The staging root's identifier; a UUID by default. */
  readonly stagingId?: () => string
  /** Called after each file is placed; the specs stop an import here to prove the journal's withdrawal. */
  readonly onPublished?: (path: string) => Promise<void> | void
}

/** What an import did. */
export interface DshHomeImportReport {
  /** The chats copied. */
  readonly chats: number
  /** The chats the Delo home already held. */
  readonly chatsPresent: number
  /** The attachment files copied. */
  readonly attachments: number
  /** The workspaces carried, and how. */
  readonly workspaces: { readonly count: number, readonly mode: 'copy' | 'merge' | 'present' | 'none' }
  /** The profiles carried, by name. */
  readonly profiles: readonly string[]
  /** The patch layers, settings and instructions that landed, a profile's patch layer included, by home-relative path. */
  readonly documents: readonly string[]
  /** The inert files of held-back rows that landed, by home-relative path. */
  readonly held: readonly string[]
  /** The skills copied. */
  readonly skills: number
  /** The credentials copied, by name. */
  readonly credentials: readonly string[]
  /** The entries left behind. */
  readonly skipped: number
  /** The bytes copied. */
  readonly bytes: number
}

/** One file the import places. */
interface Item {
  /** Its home-relative path. */
  readonly path: string
  /** Whether it replaces a document the Delo home holds. */
  readonly replace: boolean
  /** The lowercase hexadecimal SHA-256 of the bytes it places, which a withdrawal checks before it removes the file. */
  readonly sha256: string
}

/** What the journal holds. */
interface Journal {
  readonly v: 1
  readonly staging: string
  readonly directories: readonly string[]
  readonly entries: readonly Item[]
}

/** One completed import, as the record keeps it. */
export interface DshImportRecordEntry {
  /** When the import completed, in RFC 3339 UTC. */
  readonly at: string
  /** The stock home's real path. */
  readonly source: string
  /** The chats copied. */
  readonly chats: number
  /** The Session identifiers of the chats copied: each is a chat from another installation. */
  readonly sessions: readonly string[]
  /** The workspaces carried. */
  readonly workspaces: number
  /** The profiles carried. */
  readonly profiles: readonly string[]
  /** The categories the person said yes to. */
  readonly categories: readonly DshImportCategory[]
  /** The credentials copied, by name. */
  readonly credentials: readonly string[]
  /** The entries left behind. */
  readonly skipped: number
}

/**
 * Carry out one plan.
 * @param plan - a plan {@link planDshHomeImport} made under the same exclusion, after {@link recoverDshImport}.
 * @param options - the credentials answer, the clock and the seams.
 * @returns what the import did.
 * @throws DshImportError the plan's first blocker; `DSH_IMPORT_SOURCE_CHANGED` when a stock file changed after the plan; `DSH_IMPORT_TARGET_REFUSED` when a Delo home directory is a link or not a directory, or the Delo home gained a planned path; `DSH_IMPORT_CREDENTIALS_REFUSED` for an unreadable credentials document; `DSH_IMPORT_STAGING_FAILED` when staging, the journal or a publication fails. After any of them the Delo home holds nothing of this import.
 */
export async function applyDshHomeImport(plan: DshHomeImportPlan, options: DshImportApplyOptions): Promise<DshHomeImportReport> {
  const [blocker] = plan.blockers
  if (blocker !== undefined) throw blocker
  const { parent, created } = await prepareParent(plan.target)
  if (await present(join(parent, STOCK_IMPORT_JOURNAL))) {
    throw new DshImportError('DSH_IMPORT_STAGING_FAILED', 'an interrupted stock-home import has not been withdrawn yet; run the import again, which withdraws it first')
  }
  const name = `${STAGING_PREFIX}${(options.stagingId ?? randomUUID)()}`
  const root = join(parent, name)
  try {
    await mkdir(root, { mode: DIRECTORY_MODE })
  } catch (error: unknown) {
    await tidy(plan.target, created)
    throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `the staging root could not be created (${systemCode(error)})`)
  }
  let staged: Staged
  let directories: string[]
  try {
    staged = await stage(plan, options, new Stager(plan.source, plan.sourceDevice, root))
    await syncStaged(root, staged.items)
    directories = await missingDirectories(plan.target, staged.items)
    await writeJournal(parent, { v: 1, staging: name, directories, entries: staged.items })
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true })
    await tidy(plan.target, created)
    throw asImportError(error)
  }
  try {
    for (const directory of directories) await mkdir(join(plan.target, directory), { mode: DIRECTORY_MODE })
    for (const item of staged.items) {
      await publish(plan.target, root, name, item)
      await options.onPublished?.(item.path)
    }
  } catch (error: unknown) {
    const refusal = asImportError(error)
    try {
      await rollback(plan.target, parent)
      await tidy(plan.target, created)
    } catch (withdrawal: unknown) {
      throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `${refusal.message}; withdrawing what it had placed failed too (${(withdrawal as Error).message}), so the journal ${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL} was kept for the next import to withdraw`, refusal.subject)
    }
    throw refusal
  }
  // The links are durable before the journal's removal, which completes the import.
  await syncDirectories(plan.target, staged.items)
  await unlink(join(parent, STOCK_IMPORT_JOURNAL))
  await syncDirectory(parent)
  await rm(root, { recursive: true, force: true })
  return staged.report
}

/**
 * Withdraw what an interrupted import left before a profile starts, so a profile never runs over half an import.
 * @param home - the Delo home.
 * @returns what was withdrawn and what was kept because a profile wrote to it since.
 * @throws DshImportError `DSH_IMPORT_STAGING_FAILED` when the journal cannot be read or its staging directory is gone, which keeps the profile from starting, and `DSH_IMPORT_TARGET_REFUSED` when the import's directory is a link.
 */
export async function recoverStockImport(home: string): Promise<DshImportRecovery> {
  try {
    return await recoverDshImport(home)
  } catch (error: unknown) {
    if (!isDshImportError(error) || error.code !== 'DSH_IMPORT_STAGING_FAILED') throw error
    throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `${error.message}. Delo does not start while an interrupted import may be half in place: check the files ${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL} names, remove what you do not want, then move the journal aside`)
  }
}

/** What a recovery did. */
export interface DshImportRecovery {
  /** The paths withdrawn. */
  readonly withdrawn: readonly string[]
  /** The paths left in place because their bytes changed since the import placed them: a profile wrote to them. */
  readonly kept: readonly string[]
  /** The staging roots removed. */
  readonly removed: number
}

/**
 * Withdraw what an interrupted import left, and remove every staging root.
 * @param home - the Delo home.
 * @returns what was withdrawn, what was kept, and how many staging roots were removed.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when the import's directory or `archive/` is a link, and `DSH_IMPORT_STAGING_FAILED` for a journal that cannot be read or trusted or whose staging directory is gone, which is kept.
 */
export async function recoverDshImport(home: string): Promise<DshImportRecovery> {
  const parent = join(home, STOCK_IMPORT_DIRECTORY)
  await refuseLinks(home)
  if (!await present(parent)) return { withdrawn: [], kept: [], removed: 0 }
  const outcome = await present(join(parent, STOCK_IMPORT_JOURNAL)) ? await rollback(home, parent) : { withdrawn: [], kept: [] }
  let removed = 0
  for (const entry of await readdir(parent)) {
    if (!entry.startsWith(STAGING_PREFIX)) continue
    await rm(join(parent, entry), { recursive: true, force: true })
    removed += 1
  }
  return { ...outcome, removed }
}

/**
 * Read the record of every completed import.
 * @param home - the Delo home.
 * @returns the record's entries, oldest first; none when there is no readable record.
 */
export async function readDshImportRecord(home: string): Promise<readonly DshImportRecordEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_RECORD), 'utf8')) as { readonly imports?: unknown }
    return Array.isArray(parsed.imports) ? parsed.imports as DshImportRecordEntry[] : []
  } catch (error: unknown) {
    // ENOENT: no import completed yet. A record that is not JSON reads as none; the next import writes a new one.
    if (systemCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    return []
  }
}

/**
 * The chats every completed import copied: each is a chat from another installation, which a surface can mark as such.
 * @param home - the Delo home.
 * @returns their Session identifiers; none when no import completed or the record holds none.
 */
export async function readImportedChats(home: string): Promise<ReadonlySet<string>> {
  const imported = new Set<string>()
  for (const entry of await readDshImportRecord(home)) {
    const sessions: unknown = (entry as { readonly sessions?: unknown }).sessions
    const ids: readonly unknown[] = Array.isArray(sessions) ? sessions : []
    for (const id of ids.filter(value => typeof value === 'string')) imported.add(id)
  }
  return imported
}

/** The files staged for one import, and the report it returns once they are published. */
interface Staged {
  readonly items: readonly Item[]
  readonly report: DshHomeImportReport
}

/** Copies stock files and writes documents into one staging root, linking two links of one stock file as one. */
class Stager {
  private readonly reader: SourceReader
  private readonly inodes = new Map<string, string>()
  readonly items: Item[] = []

  private readonly root: string

  /**
   * @param source - the stock home's real path.
   * @param device - the device of the stock home's root.
   * @param root - the staging root.
   */
  constructor(source: string, device: number, root: string) {
    this.root = root
    this.reader = new SourceReader(source, Number.POSITIVE_INFINITY, device)
  }

  /**
   * Stage one stock file as it is, with the bytes the plan read.
   * @param file - the file as the plan recorded it, with the digest the plan read.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when the bytes copied do not have that digest.
   */
  async copy(file: DshHashedFile): Promise<void> {
    const destination = await this.destination(file.path)
    const key = `${String(file.dev)}:${String(file.ino)}`
    const first = this.inodes.get(key)
    if (first === undefined) {
      if (await this.reader.copy(file, destination) !== file.sha256) throw changedSince(file.path)
      this.inodes.set(key, destination)
    } else {
      await link(first, destination)
    }
    this.items.push({ path: file.path, replace: false, sha256: file.sha256 })
  }

  /**
   * Read one stock file whole, proving it is the file the plan recorded.
   * @param file - the file.
   * @returns its text.
   */
  async read(file: DshImportFile): Promise<string> {
    return (await this.reader.read(file)).toString('utf8')
  }

  /**
   * Prove a stock document still holds the bytes the plan read, so what the plan derived from it is what lands.
   * @param text - the document with the digest the plan recorded.
   * @throws DshImportError `DSH_IMPORT_SOURCE_CHANGED` when its bytes changed.
   */
  async verify(text: DshImportText): Promise<void> {
    if (await this.reader.hash(text.file) !== text.sha256) throw changedSince(text.file.path)
  }

  /**
   * Stage one document the import writes itself.
   * @param path - its home-relative path.
   * @param text - its content.
   * @param replace - whether it replaces a document the Delo home holds.
   */
  async write(path: string, text: string, replace: boolean): Promise<void> {
    await writeFile(await this.destination(path), text, { flag: 'wx', mode: DOCUMENT_MODE })
    this.items.push({ path, replace, sha256: digestOf(text) })
  }

  /**
   * Stage the files upstream writes into a new profile that the import has not written: the empty patch layer and
   * the pnpm settings, without build approvals.
   * @param path - the profile's home-relative path, whose manifest is staged.
   * @param bundles - the bundle list it lands with.
   */
  async initialize(path: string, bundles: readonly string[]): Promise<void> {
    const written = new Set(this.items.map(item => item.path))
    initProfile(join(this.root, 'files', path), bundles)
    for (const name of ['cordis.patch.yml', 'pnpm-workspace.yaml']) {
      const item = `${path}/${name}`
      if (!written.has(item)) this.items.push({ path: item, replace: false, sha256: digestOf(await readFile(join(this.root, 'files', item))) })
    }
  }

  /**
   * The staged path of one home-relative path, with its directories created.
   * @param path - the home-relative path.
   * @returns the absolute staged path.
   */
  private async destination(path: string): Promise<string> {
    const destination = join(this.root, 'files', path)
    await mkdir(dirname(destination), { recursive: true, mode: DIRECTORY_MODE })
    return destination
  }
}

/**
 * The refusal of a stock file whose bytes are not the ones the plan read.
 * @param path - its home-relative path.
 * @returns the refusal.
 */
function changedSince(path: string): DshImportError {
  return new DshImportError('DSH_IMPORT_SOURCE_CHANGED', `the stock home's file ${JSON.stringify(path)} no longer holds the bytes the preview showed. Stop DeepSeek Harness and run the import again.`, path)
}

/** The staged files synced at once: a journaling file system commits concurrent syncs together. */
const SYNC_BATCH = 32

/**
 * Sync every staged file before the journal names it, so a completed import never publishes a file whose bytes a
 * crash could still lose. The files are synced in concurrent batches rather than one by one.
 * @param root - the staging root.
 * @param items - the staged files.
 */
async function syncStaged(root: string, items: readonly Item[]): Promise<void> {
  for (let start = 0; start < items.length; start += SYNC_BATCH) {
    await Promise.all(items.slice(start, start + SYNC_BATCH).map(async (item) => {
      const handle = await open(join(root, 'files', item.path), 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }))
  }
}

/**
 * Write a new file and sync it before it is closed.
 * @param path - the absolute path, which must not exist.
 * @param text - the content.
 */
async function writeDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', DOCUMENT_MODE)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Stage everything a plan carries: the data, and each category the person said yes to.
 * @param plan - the plan.
 * @param options - the categories and the clock.
 * @param stager - the staging root's writer.
 * @returns the staged files in publication order and the report.
 */
async function stage(plan: DshHomeImportPlan, options: DshImportApplyOptions, stager: Stager): Promise<Staged> {
  const include = options.include
  const chats = plan.chats.filter(chat => chat.state === 'new')
  for (const file of chats.flatMap(chat => chat.files)) await stager.copy(file)
  for (const file of plan.attachments) await stager.copy(file)
  const registry = plan.registry
  if (registry !== undefined && registry.mode !== 'present') {
    await stager.verify(registry.source)
    if (registry.mode === 'copy') {
      await stager.write(REGISTRY_PATH, serializeRegistry(registry.registry), false)
    } else {
      const merged = mergeRegistries(parseRegistry(await readFile(join(plan.target, REGISTRY_PATH), 'utf8')), registry.registry)
      if (merged === undefined) throw new DshImportError('DSH_IMPORT_TARGET_REFUSED', 'the Delo home\'s workspace list changed while the import ran; run the import again', REGISTRY_PATH)
      await stager.write(REGISTRY_PATH, merged, true)
    }
  }
  const documents: string[] = []
  const held: string[] = []
  const layer = async (item: DshHomeImportPlan['layers'][number]): Promise<void> => {
    await stager.verify(item.source)
    if (item.state === 'new' && item.carried !== undefined) {
      await stager.write(item.target, item.carried, false)
      documents.push(item.target)
    }
    if (item.heldPath !== undefined && item.heldText !== undefined) {
      await stager.write(item.heldPath, item.heldText, false)
      held.push(item.heldPath)
    }
  }
  const profiles = include.profiles === true ? plan.profiles : []
  for (const profile of profiles) {
    const path = `profiles/${profile.name}`
    await stager.verify(profile.source)
    await stager.write(`${path}/package.json`, profile.manifest, false)
    if (profile.patch !== undefined) await layer(profile.patch)
    await stager.initialize(path, profile.bundles)
  }
  if (include.settings === true) {
    for (const item of plan.layers) await layer(item)
  }
  const instructions = include.instructions === true ? plan.instructions : undefined
  if (instructions?.state === 'new') {
    await stager.copy({ ...instructions.source.file, sha256: instructions.source.sha256 })
    documents.push(instructions.source.file.path)
  }
  const skills = include.skills === true ? plan.skills : []
  for (const file of skills.flatMap(skill => skill.files)) await stager.copy(file)
  const credentials = include.credentials === true ? await stageCredentials(plan, stager) : []
  const categories = (['profiles', 'settings', 'instructions', 'skills', 'credentials'] as const).filter(category => include[category] === true)
  const entry: DshImportRecordEntry = {
    at: (options.now ?? (() => new Date()))().toISOString(),
    source: plan.source,
    chats: chats.length,
    sessions: chats.map(chat => chat.id),
    workspaces: registry === undefined ? 0 : registry.workspaces,
    profiles: profiles.map(profile => profile.name),
    categories,
    credentials,
    skipped: Object.values(plan.skippedTotals).reduce((sum, count) => sum + count, 0),
  }
  const previous = await readDshImportRecord(plan.target)
  const recordPath = `${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_RECORD}`
  await stager.write(recordPath, `${JSON.stringify({ v: 1, imports: [...previous, entry] }, null, 2)}\n`, await present(join(plan.target, recordPath)))
  return {
    items: stager.items,
    report: {
      chats: chats.length,
      chatsPresent: plan.chats.length - chats.length,
      attachments: plan.attachments.length,
      workspaces: { count: registry?.workspaces ?? 0, mode: registry?.mode ?? 'none' },
      profiles: entry.profiles,
      documents,
      held,
      skills: skills.length,
      credentials,
      skipped: Object.values(plan.skippedTotals).reduce((sum, count) => sum + count, 0),
      bytes: plan.bytes,
    },
  }
}

/**
 * Stage the Delo home's credentials document with the offered stock credentials added.
 * @param plan - the plan.
 * @param stager - the staging root's writer.
 * @returns the names copied.
 * @throws DshImportError `DSH_IMPORT_CREDENTIALS_REFUSED` when either document cannot be read now.
 */
async function stageCredentials(plan: DshHomeImportPlan, stager: Stager): Promise<readonly string[]> {
  if (plan.credentials === undefined) return []
  const path = join(plan.target, CREDENTIALS_PATH)
  const held = await present(path)
  let names: string[]
  let text: string
  try {
    const stock = readCredentials(await stager.read(plan.credentials.file), `the stock home's ${CREDENTIALS_PATH}`)
    const deloText = held ? await readFile(path, 'utf8') : undefined
    const delo = deloText === undefined ? undefined : readCredentials(deloText, `the Delo home's ${CREDENTIALS_PATH}`)
    names = compareCredentials(stock, delo).filter(entry => entry.state === 'offered').map(entry => entry.name)
    text = mergeCredentials(stock, deloText, names)
  } catch (error: unknown) {
    if (isDshImportError(error)) throw error
    throw new DshImportError('DSH_IMPORT_CREDENTIALS_REFUSED', `the credentials could not be read: ${(error as Error).message}`, CREDENTIALS_PATH)
  }
  if (names.length === 0) return []
  await stager.write(CREDENTIALS_PATH, text, held)
  return names
}

/**
 * The directories the import creates in the Delo home, parents first, after proving every existing one is a directory.
 * @param home - the Delo home.
 * @param items - the files the import places.
 * @returns the home-relative directories to create.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when an existing directory on a path is a link or not a directory.
 */
async function missingDirectories(home: string, items: readonly Item[]): Promise<string[]> {
  const directories = new Set<string>()
  for (const item of items) {
    const segments = item.path.split('/').slice(0, -1)
    for (let index = 1; index <= segments.length; index += 1) directories.add(segments.slice(0, index).join('/'))
  }
  const missing: string[] = []
  for (const directory of [...directories].sort((left, right) => left.split('/').length - right.split('/').length || (left < right ? -1 : 1))) {
    const slash = directory.lastIndexOf('/')
    if (slash !== -1 && missing.includes(directory.slice(0, slash))) {
      missing.push(directory)
      continue
    }
    const held = await targetEntry(home, directory)
    if (held === undefined) missing.push(directory)
    else if (!held.isDirectory()) throw refusedTarget(directory)
  }
  return missing
}

/**
 * Place one staged file.
 * @param home - the Delo home.
 * @param root - the staging root.
 * @param name - the staging root's name, which names the temporary path of a replacement.
 * @param item - the file.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when a new file's path exists or the Delo home cannot hold a link from the staging root.
 */
async function publish(home: string, root: string, name: string, item: Item): Promise<void> {
  const target = join(home, item.path)
  const staged = join(root, 'files', item.path)
  try {
    if (!item.replace) {
      await link(staged, target)
      return
    }
    const backup = join(root, 'backup', item.path)
    await mkdir(dirname(backup), { recursive: true, mode: DIRECTORY_MODE })
    await link(target, backup)
    const temporary = `${target}.dsh-import-${name}`
    await link(staged, temporary)
    await rename(temporary, target)
  } catch (error: unknown) {
    throw publicationFailure(item.path, error)
  }
}

/**
 * The refusal of one placement that failed.
 * @param path - the home-relative path being placed.
 * @param error - the failure of the link or the rename.
 * @returns `DSH_IMPORT_TARGET_REFUSED` for a path that exists or a home that cannot hold a link from the staging root, and the failure itself otherwise.
 */
export function publicationFailure(path: string, error: unknown): unknown {
  const code = systemCode(error)
  if (code === 'EEXIST') return new DshImportError('DSH_IMPORT_TARGET_REFUSED', `the Delo home gained ${JSON.stringify(path)} while the import ran, and an import never replaces a file`, path)
  if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) {
    return new DshImportError('DSH_IMPORT_TARGET_REFUSED', `the Delo home cannot hold ${JSON.stringify(path)} as a link from the import's staging directory (${code}); the import needs the Delo home on one file system that supports hard links`, path)
  }
  return error
}

/**
 * Withdraw what the journal names, then remove the journal and its staging root.
 * @param home - the Delo home.
 * @param parent - the import's directory.
 * @returns the paths withdrawn, and the paths kept because their bytes are no longer the ones the import placed.
 * @throws DshImportError `DSH_IMPORT_STAGING_FAILED` for a journal that cannot be read or trusted, or whose staging directory is gone; the journal is kept.
 */
async function rollback(home: string, parent: string): Promise<{ readonly withdrawn: readonly string[], readonly kept: readonly string[] }> {
  const journal = await readJournal(parent)
  const root = join(parent, journal.staging)
  if (await identity(root) === undefined) {
    throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `the interrupted import's staging directory ${STOCK_IMPORT_DIRECTORY}/${journal.staging} is gone, so the files it placed cannot be told from your own; nothing was withdrawn, and the journal was kept`)
  }
  const withdrawn: string[] = []
  const kept: string[] = []
  for (const item of [...journal.entries].reverse()) {
    const target = join(home, item.path)
    const staged = await identity(join(root, 'files', item.path))
    if (staged === undefined) continue
    const temporary = `${target}.dsh-import-${journal.staging}`
    if (await identity(temporary) === staged) await unlink(temporary)
    if (await identity(target) !== staged) continue
    // A profile that started after the crash may have written to the file; its bytes are the person's now.
    if (await fileDigest(target) !== item.sha256) {
      kept.push(item.path)
      continue
    }
    const backup = join(root, 'backup', item.path)
    if (item.replace && await identity(backup) !== undefined) await rename(backup, target)
    else await unlink(target)
    withdrawn.push(item.path)
  }
  for (const directory of [...journal.directories].reverse()) await removeIfEmpty(join(home, directory))
  await unlink(join(parent, STOCK_IMPORT_JOURNAL))
  await rm(root, { recursive: true, force: true })
  return { withdrawn, kept }
}

/**
 * Remove the directories a failed import created for itself when they are still empty, so a refusal leaves the Delo
 * home as it was.
 * @param home - the Delo home.
 * @param created - the home-relative directories this import created, parents first.
 */
async function tidy(home: string, created: readonly string[]): Promise<void> {
  for (const path of [...created].reverse()) await removeIfEmpty(join(home, path))
}

/**
 * Remove a directory the import created, when nothing else lives in it.
 * @param path - the absolute path.
 */
async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error: unknown) {
    // ENOENT: never created; ENOTEMPTY or EEXIST: something else now lives in it, which stays.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(systemCode(error))) throw error
  }
}

/**
 * Write the journal whole and durably: to a temporary file that is synced, then by one rename, then the directory is
 * synced so the rename survives a crash.
 * @param parent - the import's directory.
 * @param journal - the journal.
 */
async function writeJournal(parent: string, journal: Journal): Promise<void> {
  const temporary = join(parent, `${STOCK_IMPORT_JOURNAL}.${journal.staging}`)
  await writeDurably(temporary, `${JSON.stringify(journal)}\n`)
  await rename(temporary, join(parent, STOCK_IMPORT_JOURNAL))
  await syncDirectory(parent)
}

/**
 * Sync one directory, so a rename or a link in it is durable.
 * @param path - the directory.
 */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } catch (error: unknown) {
    // EINVAL or EPERM: a platform or file system that does not sync directories, where the rename is as durable as it gets.
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(systemCode(error))) throw error
  } finally {
    await handle.close()
  }
}

/**
 * Sync every directory that received a published file, so the links are durable before the journal goes.
 * @param home - the Delo home.
 * @param items - the published files.
 */
async function syncDirectories(home: string, items: readonly Item[]): Promise<void> {
  const directories = [...new Set(items.map(item => dirname(join(home, item.path))))]
  for (let start = 0; start < directories.length; start += SYNC_BATCH) {
    await Promise.all(directories.slice(start, start + SYNC_BATCH).map(syncDirectory))
  }
}

/**
 * The SHA-256 of one Delo home file.
 * @param path - the absolute path.
 * @returns the lowercase hexadecimal digest.
 */
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Read the journal an import left. The journal is in the Delo home, where another process may have written it, so
 * every path it names must be a home-relative path of safe segments, each directory it names must lie on the way to a
 * file it names, and no file may be named twice.
 * @param parent - the import's directory.
 * @returns the journal.
 * @throws DshImportError `DSH_IMPORT_STAGING_FAILED` when it is not a plain file holding a journal this import writes.
 */
async function readJournal(parent: string): Promise<Journal> {
  const refused = (): DshImportError => new DshImportError('DSH_IMPORT_STAGING_FAILED', `the interrupted import's journal ${STOCK_IMPORT_DIRECTORY}/${STOCK_IMPORT_JOURNAL} cannot be read, so nothing was withdrawn; it was kept`)
  const path = join(parent, STOCK_IMPORT_JOURNAL)
  let value: unknown
  try {
    if (!(await lstat(path)).isFile()) throw refused()
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // A journal is a plain file written whole by one rename, so one that is not, or does not parse, was written by something else.
    throw refused()
  }
  const journal = value as Partial<Journal>
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string')
  if (journal.v !== 1 || typeof journal.staging !== 'string' || !STAGING_NAME.test(journal.staging) || !strings(journal.directories)
    || !Array.isArray(journal.entries) || !journal.entries.every(item => typeof item?.path === 'string' && typeof item.replace === 'boolean' && typeof item.sha256 === 'string' && DIGEST.test(item.sha256))) {
    throw refused()
  }
  const files: string[] = (journal.entries as readonly Item[]).map(item => item.path)
  const ancestors = new Set(files.flatMap(file => file.split('/').slice(0, -1).map((_segment: string, index: number, segments: string[]) => segments.slice(0, index + 1).join('/'))))
  if (![...files, ...journal.directories].every(isHomeRelative) || new Set(files).size !== files.length || !journal.directories.every(directory => ancestors.has(directory))) {
    throw refused()
  }
  return journal as Journal
}

/**
 * Whether a path from the journal is a home-relative path the import writes.
 * @param path - the path.
 * @returns true for `/`-separated segments that each pass the import's name rules.
 */
function isHomeRelative(path: string): boolean {
  return path.split('/').every(isSafeSegment)
}

/**
 * Create the import's directory, refusing a link on the way.
 * @param home - the Delo home.
 * @returns the import's directory, and the home-relative directories this call created, parents first.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` for a link on the way, and `DSH_IMPORT_STAGING_FAILED` when a directory cannot be created.
 */
async function prepareParent(home: string): Promise<{ readonly parent: string, readonly created: readonly string[] }> {
  await refuseLinks(home)
  const created: string[] = []
  for (const path of ['archive', STOCK_IMPORT_DIRECTORY]) {
    try {
      await mkdir(join(home, path), { mode: DIRECTORY_MODE })
      created.push(path)
    } catch (error: unknown) {
      if (systemCode(error) === 'EEXIST') continue
      await tidy(home, created)
      throw new DshImportError('DSH_IMPORT_STAGING_FAILED', `the import's directory ${STOCK_IMPORT_DIRECTORY} could not be created (${systemCode(error)})`)
    }
  }
  return { parent: join(home, STOCK_IMPORT_DIRECTORY), created }
}

/**
 * Refuse `archive/` or the import's directory when either is a link or not a directory.
 * @param home - the Delo home.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` naming the one that is.
 */
async function refuseLinks(home: string): Promise<void> {
  for (const path of ['archive', STOCK_IMPORT_DIRECTORY]) {
    const held = await targetEntry(home, path)
    if (held === undefined) return
    if (!held.isDirectory()) throw refusedTarget(path)
  }
}

/**
 * The status of one Delo home path, without following a link.
 * @param home - the Delo home.
 * @param path - the home-relative path.
 * @returns the status, or `undefined` when nothing is there.
 * @throws DshImportError `DSH_IMPORT_TARGET_REFUSED` when the path cannot be read.
 */
async function targetEntry(home: string, path: string): Promise<Stats | undefined> {
  try {
    return await lstat(join(home, path))
  } catch (error: unknown) {
    if (systemCode(error) === 'ENOENT') return undefined
    throw refusedTarget(path)
  }
}

/**
 * The device and inode of a path, without following a link.
 * @param path - the absolute path.
 * @returns them as one key, or `undefined` when nothing is there.
 */
async function identity(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path)
    return `${String(stats.dev)}:${String(stats.ino)}`
  } catch (error: unknown) {
    if (systemCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether anything stands at a path.
 * @param path - the absolute path.
 * @returns true when `lstat` finds an entry.
 */
async function present(path: string): Promise<boolean> {
  return await identity(path) !== undefined
}

/**
 * A failure as an import refusal.
 * @param error - the failure.
 * @returns the refusal itself, or one that names the system code.
 */
function asImportError(error: unknown): DshImportError {
  if (isDshImportError(error)) return error
  return new DshImportError('DSH_IMPORT_STAGING_FAILED', `the import could not write its files (${systemCode(error)}); nothing was imported`)
}
