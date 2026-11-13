/**
 * The session-data copy of contract C3 ("Data formats", "Rollback"): a real copy of the home's `sessions/` and
 * `storages/` taken before a runtime switch whose data differs, and the restore that puts it back and sets the newer
 * data aside. Nothing here deletes chat data: a restore moves the live directories to `data-set-aside/`, and copies
 * are removed only by {@link keepOnlyCopy} when an update commits, {@link discardCopy} when an update ends before its
 * switch, and the person's {@link discardKeptData}.
 *
 * - The copy is written under `data-copies/.tmp-<16 hex>/`, its files and `copy.json` synced, then renamed to
 *   `data-copies/<to>/` and the directory synced. Other copies stay until the update commits.
 * - The restore writes the journal `data-copies/restore.json` before its first rename; each step is one directory
 *   rename, after which the journal's `done` count is rewritten durably, so {@link recoverDataCopies} completes a
 *   killed restore from the journal before any Host starts, whichever step the kill interrupted.
 * - `sessions/` and `storages/` must be real directories. Files are copied with `COPYFILE_FICLONE`, which falls back
 *   to a full copy, never a hard link. Symbolic links inside them are copied as links and never followed.
 *
 * @module @delo/update/data-copy
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SESSION_DATA_DIRECTORIES, type DataCopySize, type DataFormats, type SessionDataDirectory } from '@delo/contract-update-report'
import { z } from 'zod'
import { parseDataFormats } from './data-formats.ts'
import { DataSafetyError } from './errors.ts'

/** The home's directory of session-data copies. */
export const DATA_COPIES_DIRECTORY = 'data-copies'

/** The home's directory of data a rollback set aside. */
export const DATA_SET_ASIDE_DIRECTORY = 'data-set-aside'

/** The record beside a copy. */
export const COPY_RECORD_FILE = 'copy.json'

/** The restore's journal under {@link DATA_COPIES_DIRECTORY}. */
export const RESTORE_JOURNAL_FILE = 'restore.json'

/** The `schema` of {@link COPY_RECORD_FILE}. */
export const COPY_RECORD_SCHEMA = 'delo.session-data-copy/1'

/** The `schema` of {@link RESTORE_JOURNAL_FILE}. */
export const RESTORE_JOURNAL_SCHEMA = 'delo.data-restore/1'

/** A copy's own name: a runtime version. */
const VERSION_NAME = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u

/** A set-aside directory's name: the version and a compact UTC time. */
const SET_ASIDE_NAME = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-[0-9]{8}T[0-9]{6}Z(?:-[0-9]+)?$/u

/** A temporary copy's name. */
const TEMPORARY_NAME = /^\.tmp-[0-9a-f]{16}$/u

/** The record beside a copy: both releases' data formats, the file count and the byte total. */
export interface CopyRecord {
  /** Always {@link COPY_RECORD_SCHEMA}. */
  readonly schema: typeof COPY_RECORD_SCHEMA
  /** The version the update started from. */
  readonly from: string
  /** The version it moved to, which names the copy. */
  readonly to: string
  /** Both releases' `data-formats.json`, `null` where unreadable. */
  readonly formats: { readonly from: DataFormats | null, readonly to: DataFormats | null }
  /** Regular files copied. */
  readonly files: number
  /** Bytes copied. */
  readonly bytes: number
  /** RFC 3339 UTC time the copy was taken. */
  readonly created: string
}

const formatsSchema = z.unknown().transform((value, context) => {
  if (value === null) return null
  try {
    return parseDataFormats(JSON.stringify(value))
  } catch (error) {
    context.addIssue({ code: 'custom', message: (error as Error).message })
    return z.NEVER
  }
})
const copyRecordSchema = z.strictObject({
  schema: z.literal(COPY_RECORD_SCHEMA),
  from: z.string().regex(VERSION_NAME),
  to: z.string().regex(VERSION_NAME),
  formats: z.strictObject({ from: formatsSchema, to: formatsSchema }),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  created: z.string().datetime(),
})

const directorySchema = z.enum(['sessions', 'storages'] as const satisfies readonly SessionDataDirectory[])

/** One step of a restore: one directory rename. */
type RestoreStep =
  /** Move the live directory into the set-aside directory. */
  | { readonly kind: 'set-aside', readonly directory: SessionDataDirectory }
  /** Move the copy's directory into the home. */
  | { readonly kind: 'restore', readonly directory: SessionDataDirectory }
  /** Move the copy's record into the set-aside directory, beside the data it replaced. */
  | { readonly kind: 'record' }

const journalSchema = z.strictObject({
  schema: z.literal(RESTORE_JOURNAL_SCHEMA),
  to: z.string().regex(VERSION_NAME),
  setAside: z.string().regex(SET_ASIDE_NAME),
  steps: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('set-aside'), directory: directorySchema }),
    z.strictObject({ kind: z.literal('restore'), directory: directorySchema }),
    z.strictObject({ kind: z.literal('record') }),
  ])),
  /** The steps finished and synced, from the first; the step at this index may have renamed without being counted. */
  done: z.number().int().nonnegative(),
}).refine(journal => journal.done <= journal.steps.length, { message: 'done counts more steps than the journal holds' })

/** A restore in progress, as its journal records it. */
type RestoreJournal = z.output<typeof journalSchema>

/**
 * Whether a path exists, without following a final symbolic link.
 * @param path - the path.
 * @returns true when it exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Flush a file or directory to disk.
 * @param path - the path.
 */
async function sync(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Write a small file whole: a temporary sibling, synced, renamed over the name, and the directory synced.
 * @param directory - the directory.
 * @param name - the file's name.
 * @param text - its text.
 */
async function writeDurable(directory: string, name: string, text: string): Promise<void> {
  const temporary = join(directory, `.${name}.tmp-${randomBytes(8).toString('hex')}`)
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
  await sync(temporary)
  await rename(temporary, join(directory, name))
  await sync(directory)
}

/**
 * Count and sum the regular files under a directory, and sync each when asked. Symbolic links are neither counted nor
 * followed, so a link to a directory outside the home is never walked or opened.
 * @param directory - the directory, which may be absent.
 * @param flush - whether to flush every file and directory to disk.
 * @returns the file count and byte total.
 */
async function walk(directory: string, flush: boolean): Promise<{ files: number, bytes: number }> {
  if (!await exists(directory)) return { files: 0, bytes: 0 }
  const total = await walkEntries(directory, flush)
  if (flush) await sync(directory)
  return total
}

/**
 * Count, sum and optionally sync the regular files under a directory, descending only into real subdirectories.
 * `readdir`'s `recursive` option is not used because it descends into symbolic links to directories.
 * @param directory - an existing directory.
 * @param flush - whether to flush every file to disk.
 * @returns the file count and byte total.
 */
async function walkEntries(directory: string, flush: boolean): Promise<{ files: number, bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkEntries(path, flush)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += (await lstat(path)).size
      if (flush) await sync(path)
    }
  }
  return { files, bytes }
}

/**
 * The size of a copy of the home's chat data now, and the free space on the home's filesystem.
 * @param home - the resolved Delo home.
 * @returns the file count, the byte total and the free bytes.
 */
export async function planDataCopy(home: string): Promise<DataCopySize> {
  let files = 0
  let bytes = 0
  for (const directory of SESSION_DATA_DIRECTORIES) {
    const size = await walk(join(home, directory), false)
    files += size.files
    bytes += size.bytes
  }
  const fs = await statfs(home)
  return { files, bytes, free: Number(fs.bavail) * Number(fs.bsize) }
}

/** What {@link saveDataCopy} needs. */
export interface SaveRequest {
  /** The resolved Delo home, whose lock the caller holds with the Host stopped. */
  readonly home: string
  /** The running version. */
  readonly from: string
  /** The target version, which names the copy. */
  readonly to: string
  /** Both releases' `data-formats.json`, `undefined` where unreadable. */
  readonly formats: { readonly from: DataFormats | undefined, readonly to: DataFormats | undefined }
  /** The current time. */
  readonly now: Date
}

/**
 * Refuse a name that cannot name a copy, so no path built from it leaves `data-copies/`.
 * @param to - the version that names the copy.
 * @throws {Error} when it is not a version.
 */
function assertVersionName(to: string): void {
  if (!VERSION_NAME.test(to)) throw new Error(`${JSON.stringify(to)} is not a version a copy can be named by`)
}

/**
 * Refuse a home whose `sessions/` or `storages/` is a symbolic link or anything but a directory; an absent one is
 * accepted.
 * @param home - the resolved Delo home.
 * @throws {DataSafetyError} `DATA_NOT_A_DIRECTORY` naming the first such entry.
 */
async function assertDataDirectories(home: string): Promise<void> {
  for (const directory of SESSION_DATA_DIRECTORIES) {
    const path = join(home, directory)
    let entry
    try {
      entry = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isDirectory()) {
      throw new DataSafetyError('DATA_NOT_A_DIRECTORY', `${path} is ${entry.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; Delorun copies only a real directory there, so move the data into ${path} itself`)
    }
  }
}

/**
 * Refuse while a restore's journal exists: the restore still needs the copy it names.
 * @param home - the resolved Delo home.
 * @throws {DataSafetyError} `DATA_IN_USE` when `data-copies/restore.json` exists.
 */
async function assertNoRestore(home: string): Promise<void> {
  const journal = join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE)
  if (await exists(journal)) throw new DataSafetyError('DATA_IN_USE', `a restore of the chat data is in progress (${journal}); run delorun recover to complete it first`)
}

/**
 * Take the session-data copy for an update: copy `sessions/` and `storages/` under a temporary name, sync it and
 * rename it to `data-copies/<to>/`, replacing an earlier copy for the same version. Copies for other versions stay.
 * @param request - the home, both versions, both releases' formats and the time.
 * @returns the copy's record.
 * @throws {Error} when `to` is not a version.
 * @throws {DataSafetyError} `DATA_NOT_A_DIRECTORY` when `sessions/` or `storages/` is a symbolic link or not a
 *   directory, and `DATA_COPY_NO_SPACE` when the copy would not fit; both before anything is written.
 */
export async function saveDataCopy(request: SaveRequest): Promise<CopyRecord> {
  assertVersionName(request.to)
  await assertDataDirectories(request.home)
  assertCopyFits(await planDataCopy(request.home))
  const copies = join(request.home, DATA_COPIES_DIRECTORY)
  await mkdir(copies, { recursive: true, mode: 0o700 })
  const temporary = join(copies, `.tmp-${randomBytes(8).toString('hex')}`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    let files = 0
    let bytes = 0
    for (const directory of SESSION_DATA_DIRECTORIES) {
      const source = join(request.home, directory)
      if (!await exists(source)) continue
      await cp(source, join(temporary, directory), { recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      const copied = await walk(join(temporary, directory), true)
      files += copied.files
      bytes += copied.bytes
    }
    const record: CopyRecord = {
      schema: COPY_RECORD_SCHEMA, from: request.from, to: request.to,
      formats: { from: request.formats.from ?? null, to: request.formats.to ?? null },
      files, bytes, created: request.now.toISOString(),
    }
    await writeDurable(temporary, COPY_RECORD_FILE, `${JSON.stringify(record, undefined, 2)}\n`)
    const named = join(copies, request.to)
    await rm(named, { recursive: true, force: true })
    await rename(temporary, named)
    await sync(copies)
    return record
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/**
 * When an update commits: remove every entry under `data-copies/` except the committed update's copy, so one copy is
 * kept. It refuses while a restore's journal exists, so the journal and the copy it names stay.
 * @param home - the resolved Delo home, whose lock the caller holds.
 * @param to - the committed update's target version, which names the copy kept.
 * @throws {Error} when `to` is not a version.
 * @throws {DataSafetyError} `DATA_IN_USE` when a restore's journal exists; nothing is removed then.
 */
export async function keepOnlyCopy(home: string, to: string): Promise<void> {
  assertVersionName(to)
  await assertNoRestore(home)
  const copies = join(home, DATA_COPIES_DIRECTORY)
  if (!await exists(copies)) return
  for (const entry of await readdir(copies)) {
    if (entry !== to) await rm(join(copies, entry), { recursive: true, force: true })
  }
  await sync(copies)
}

/**
 * When an update ends before its runtime switch: remove the copy it took, `data-copies/<to>/`, and nothing else.
 * @param home - the resolved Delo home, whose lock the caller holds.
 * @param to - the ended update's target version, which names the copy.
 * @throws {Error} when `to` is not a version.
 * @throws {DataSafetyError} `DATA_IN_USE` when a restore's journal exists; nothing is removed then.
 */
export async function discardCopy(home: string, to: string): Promise<void> {
  assertVersionName(to)
  await assertNoRestore(home)
  await rm(join(home, DATA_COPIES_DIRECTORY, to), { recursive: true, force: true })
}

/**
 * Refuse a copy that does not fit.
 * @param size - the copy's size and the free space.
 * @throws {DataSafetyError} `DATA_COPY_NO_SPACE` when the copy is larger than the free space.
 */
export function assertCopyFits(size: DataCopySize): void {
  if (size.bytes > size.free) {
    throw new DataSafetyError('DATA_COPY_NO_SPACE', `the copy of the chat data needs ${String(size.bytes)} bytes and the home's filesystem has ${String(size.free)} free; free space, or continue without the copy`)
  }
}

/**
 * Read the record of the copy an update took.
 * @param home - the resolved Delo home.
 * @param to - the update's target version.
 * @returns the record, or `undefined` when no whole copy for that version exists.
 */
export async function readCopyRecord(home: string, to: string): Promise<CopyRecord | undefined> {
  if (!VERSION_NAME.test(to)) return undefined
  let text: string
  try {
    text = await readFile(join(home, DATA_COPIES_DIRECTORY, to, COPY_RECORD_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = copyRecordSchema.safeParse(JSON.parse(text))
  if (!parsed.success || parsed.data.to !== to) {
    throw new DataSafetyError('DATA_RESTORE_INCONSISTENT', `${join(home, DATA_COPIES_DIRECTORY, to, COPY_RECORD_FILE)} is not the record of a copy for ${to}`)
  }
  return parsed.data
}

/**
 * The name a set-aside directory gets: the version and the time, with a counter when the name is taken.
 * @param home - the resolved Delo home.
 * @param to - the version whose data is set aside.
 * @param now - the time.
 * @returns a name no entry under `data-set-aside/` has.
 */
async function setAsideName(home: string, to: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.[0-9]+Z$/u, 'Z')
  const base = `${to}-${stamp}`
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${String(attempt)}`
    if (!await exists(join(home, DATA_SET_ASIDE_DIRECTORY, name))) return name
  }
}

/**
 * The paths one restore step renames.
 * @param home - the resolved Delo home.
 * @param journal - the restore's journal.
 * @param step - the step.
 * @returns the source and destination.
 */
function stepPaths(home: string, journal: RestoreJournal, step: RestoreStep): { readonly source: string, readonly destination: string } {
  const copy = join(home, DATA_COPIES_DIRECTORY, journal.to)
  const setAside = join(home, DATA_SET_ASIDE_DIRECTORY, journal.setAside)
  switch (step.kind) {
    case 'set-aside':
      return { source: join(home, step.directory), destination: join(setAside, step.directory) }
    case 'restore':
      return { source: join(copy, step.directory), destination: join(home, step.directory) }
    case 'record':
      return { source: join(copy, COPY_RECORD_FILE), destination: join(setAside, COPY_RECORD_FILE) }
  }
}

/**
 * Write a restore's journal durably.
 * @param home - the resolved Delo home.
 * @param journal - the journal.
 */
async function writeJournal(home: string, journal: RestoreJournal): Promise<void> {
  await writeDurable(join(home, DATA_COPIES_DIRECTORY), RESTORE_JOURNAL_FILE, `${JSON.stringify(journal)}\n`)
}

/**
 * Run a restore's steps from its journal, starting at its `done` count. A step whose source exists and whose
 * destination does not is renamed; a step whose source is gone and whose destination exists renamed before a kill
 * and is counted. Each step's two directories are synced and the journal's `done` count rewritten durably before the
 * next step. The emptied copy directory and the journal go last.
 * @param home - the resolved Delo home.
 * @param journal - the restore's journal.
 * @throws {DataSafetyError} `DATA_RESTORE_INCONSISTENT` when the next step's source and destination both exist, or
 *   neither does.
 */
async function runRestore(home: string, journal: RestoreJournal): Promise<void> {
  await mkdir(join(home, DATA_SET_ASIDE_DIRECTORY, journal.setAside), { recursive: true, mode: 0o700 })
  await sync(join(home, DATA_SET_ASIDE_DIRECTORY))
  let { done } = journal
  for (const step of journal.steps.slice(done)) {
    const { source, destination } = stepPaths(home, journal, step)
    const [from, to] = [await exists(source), await exists(destination)]
    if (from === to) {
      throw new DataSafetyError('DATA_RESTORE_INCONSISTENT', from
        ? `both ${source} and ${destination} exist; move one away by hand, then run delorun recover`
        : `neither ${source} nor ${destination} exists, so the restore cannot continue; the journal is ${join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE)}`)
    }
    if (from) await rename(source, destination)
    await sync(dirname(source))
    await sync(dirname(destination))
    done += 1
    await writeJournal(home, { ...journal, done })
  }
  await rmdir(join(home, DATA_COPIES_DIRECTORY, journal.to)).catch((error: unknown) => {
    // ENOENT: an earlier run of the same journal removed it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  await rm(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE), { force: true })
  await sync(join(home, DATA_COPIES_DIRECTORY))
}

/** What a restore did. */
export interface RestoreResult {
  /** The set-aside directory, relative to the home. */
  readonly setAside: string
  /** The chats created or changed since the copy, now set aside. */
  readonly changedChats: number
}

/**
 * The chats in the live `sessions/` that the copy does not hold as they are: an entry the copy lacks, or one with a
 * file changed after the copy was taken.
 * @param home - the resolved Delo home.
 * @param record - the copy's record.
 * @returns their number.
 */
export async function changedChats(home: string, record: CopyRecord): Promise<number> {
  const live = join(home, 'sessions')
  if (!await exists(live)) return 0
  const copied = join(home, DATA_COPIES_DIRECTORY, record.to, 'sessions')
  const taken = Date.parse(record.created)
  let changed = 0
  for (const entry of await readdir(live, { withFileTypes: true })) {
    const path = join(live, entry.name)
    if (!await exists(join(copied, entry.name))) {
      changed += 1
      continue
    }
    const paths = entry.isDirectory() ? (await readdir(path, { recursive: true, withFileTypes: true })).filter(file => file.isFile()).map(file => join(file.parentPath, file.name)) : [path]
    for (const file of paths) {
      if ((await lstat(file)).mtimeMs > taken) {
        changed += 1
        break
      }
    }
  }
  return changed
}

/**
 * Put the copy an update took back in place: the live `sessions/` and `storages/` move to
 * `data-set-aside/<to>-<time>/`, the copy's move into the home, and the copy's record goes beside the set-aside data.
 * The journal is written before the first rename and counts each finished rename.
 * @param home - the resolved Delo home, whose lock the caller holds with no Host running.
 * @param record - the copy's record.
 * @param now - the time, which names the set-aside directory.
 * @returns the set-aside directory and the number of chats it holds that the copy did not.
 * @throws {DataSafetyError} `DATA_IN_USE` when another restore's journal exists, before anything changes;
 *   `DATA_RESTORE_INCONSISTENT` when a step finds its directories in a state no restore leaves.
 */
export async function restoreDataCopy(home: string, record: CopyRecord, now: Date): Promise<RestoreResult> {
  await assertNoRestore(home)
  const changed = await changedChats(home, record)
  const steps: RestoreStep[] = []
  for (const directory of SESSION_DATA_DIRECTORIES) {
    if (await exists(join(home, directory))) steps.push({ kind: 'set-aside', directory })
  }
  for (const directory of SESSION_DATA_DIRECTORIES) {
    if (await exists(join(home, DATA_COPIES_DIRECTORY, record.to, directory))) steps.push({ kind: 'restore', directory })
  }
  steps.push({ kind: 'record' })
  const journal: RestoreJournal = { schema: RESTORE_JOURNAL_SCHEMA, to: record.to, setAside: await setAsideName(home, record.to, now), steps, done: 0 }
  await writeJournal(home, journal)
  await runRestore(home, journal)
  return { setAside: join(DATA_SET_ASIDE_DIRECTORY, journal.setAside), changedChats: changed }
}

/**
 * Before any Host starts: complete a restore a killed process left, and remove copies a killed update left
 * unfinished. The caller holds the home lock.
 * @param home - the resolved Delo home.
 * @returns whether a restore was completed.
 * @throws {DataSafetyError} `DATA_RESTORE_INCONSISTENT` when the journal is not one a restore writes, or names
 *   directories in a state no restore leaves.
 */
export async function recoverDataCopies(home: string): Promise<boolean> {
  const copies = join(home, DATA_COPIES_DIRECTORY)
  if (!await exists(copies)) return false
  for (const entry of await readdir(copies)) if (TEMPORARY_NAME.test(entry)) await rm(join(copies, entry), { recursive: true, force: true })
  let text: string
  try {
    text = await readFile(join(copies, RESTORE_JOURNAL_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DataSafetyError('DATA_RESTORE_INCONSISTENT', `${join(copies, RESTORE_JOURNAL_FILE)} is not a restore journal`, { cause: error })
  }
  const parsed = journalSchema.safeParse(value)
  if (!parsed.success) throw new DataSafetyError('DATA_RESTORE_INCONSISTENT', `${join(copies, RESTORE_JOURNAL_FILE)} is not a restore journal`)
  await runRestore(home, parsed.data)
  return true
}

/** A copy or set-aside directory as `delorun recover status` lists it. */
export interface KeptData {
  /** `data-copies` or `data-set-aside`. */
  readonly kind: 'copy' | 'set-aside'
  /** The path relative to the home. */
  readonly path: string
  /** Its regular files' byte total. */
  readonly bytes: number
}

/**
 * Every copy and set-aside directory the home keeps, with its size.
 * @param home - the resolved Delo home.
 * @returns the entries, copies first, each kind in name order.
 */
export async function listKeptData(home: string): Promise<readonly KeptData[]> {
  const kept: KeptData[] = []
  for (const [kind, directory, name] of [['copy', DATA_COPIES_DIRECTORY, VERSION_NAME], ['set-aside', DATA_SET_ASIDE_DIRECTORY, SET_ASIDE_NAME]] as const) {
    const parent = join(home, directory)
    if (!await exists(parent)) continue
    for (const entry of (await readdir(parent)).sort()) {
      if (!name.test(entry)) continue
      kept.push({ kind, path: join(directory, entry), bytes: (await walk(join(parent, entry), false)).bytes })
    }
  }
  return kept
}

/** What the caller knows about the copies an update or a rollback still needs, for {@link discardKeptData}. */
export interface DiscardGuard {
  /** The versions whose copies an update record still refers to. */
  readonly referenced: readonly string[]
  /** Whether a rollback has begun and not finished. */
  readonly rollingBack: boolean
}

/**
 * Remove one copy or set-aside directory the person named.
 * @param home - the resolved Delo home, whose lock the caller holds.
 * @param path - the entry's path relative to the home, as {@link listKeptData} gives it.
 * @param guard - the copies an update record refers to and whether a rollback is in progress.
 * @throws {DataSafetyError} `DATA_IN_USE` when a restore's journal exists, a rollback is in progress, or the path is a
 *   copy named in `guard.referenced`; `NOT_KEPT_DATA` when the path is not a kept copy or set-aside directory.
 */
export async function discardKeptData(home: string, path: string, guard: DiscardGuard): Promise<void> {
  await assertNoRestore(home)
  if (guard.rollingBack) throw new DataSafetyError('DATA_IN_USE', `a rollback is in progress and may still need ${path}; run delorun recover to finish it first`)
  const entry = (await listKeptData(home)).find(kept => kept.path === path)
  if (entry === undefined) throw new DataSafetyError('NOT_KEPT_DATA', `${path} is not a copy or set-aside directory of this home; delorun recover status lists them`)
  if (entry.kind === 'copy' && guard.referenced.includes(basename(entry.path))) {
    throw new DataSafetyError('DATA_IN_USE', `${path} is the copy an update record refers to; a rollback of that update needs it`)
  }
  await rm(join(home, path), { recursive: true, force: true })
}
