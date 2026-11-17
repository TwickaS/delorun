/**
 * The person's changes to the harness itself (contract C21, "Harness edits"): the writable copy of a runtime's `app/`
 * directory under `changes/harness/<runtime>/copy/`, the pending `harness-edit` change of each file of the copy that
 * differs from what the runtime runs, and applying, discarding and undoing them. The signed installation under
 * `runtimes/<runtime>/` is read, never written: every byte read from it is checked against the verified signed file
 * list the caller passes ({@link SignedRuntime}), and an approved file is a one-file content version in the store named
 * by the runtime's harness record. A start runs the approved files through the composed tree ([harness tree](./harness-tree.ts)).
 *
 * Pending harness changes are computed from the copy on every read and logged only when decided, as a plugin folder's
 * are. Every decision takes an {@link AtComputer} proof, refuses one the attest functions did not issue before it reads
 * or writes anything, runs under {@link withHarnessLock} and is logged in the harness's change log with `decidedFrom`.
 * While protection is off, a start applies every pending change without review ({@link applyUnreviewedHarnessChanges}).
 *
 * @module @delorun/changes/harness
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PRIVATE_DIR_MODE } from '@delorun/contract-home-layout'
import { boundedDiff, compareVersions, reviewInputOf } from './diff.ts'
import { ChangesError, isChangesError } from './errors.ts'
import { changeId } from './ids.ts'
import { harnessCopyDirectory, harnessRuntimeDirectory, harnessScanCachePath, versionsDirectory } from './paths.ts'
import { findEntry, isHarnessPath, readHarnessLog, readHarnessRecord, readProtection, requirePresence, withEntry, withHarnessLock, writeHarnessLog, writeHarnessRecord, type AtComputer } from './records.ts'
import { reviewChange } from './review.ts'
import { readObject, readVersion, storeEmptyVersion, storeFileVersion } from './store.ts'
import { byteLimitWords, compareCodeUnits, CONTENT_LIMITS, openRegularFile, readChunks, scanFolder, versionOf, type FileEntry, type ScanLimits, type ScannedFolder } from './tree.ts'
import type { ApprovedHarnessFile, BoundedDiff, ChangeEntry, ChangeId, ChangeLog, ContentVersion, FileChange, HarnessRecord, ObjectDigest, RiskSummary } from './types.ts'

/** One file of the signed release, as its verified signed file list names it. */
export interface SignedFile {
  /** Relative to the installation, `/`-separated. */
  readonly path: string
  /** Its length in bytes. */
  readonly length: number
  /** The SHA-256 of its bytes, lowercase hexadecimal. */
  readonly sha256: string
  /** Whether the list gives it mode 0755. */
  readonly executable: boolean
}

/** A runtime's signed installation, whose file list the runtime store's start check verified. */
export interface SignedRuntime {
  /** The installation, `runtimes/<runtime>/`. */
  readonly directory: string
  /** Every file of its verified signed file list. */
  readonly files: readonly SignedFile[]
}

/** The runtime whose harness an action works on. */
export interface HarnessContext {
  /** The Delorun home. */
  readonly home: string
  /** The runtime version that runs. */
  readonly runtime: string
  /**
   * The runtime's signed installation, verified with the root the launcher anchors; called only when an action needs
   * the signed files.
   * @returns the installation and its verified file list.
   */
  readonly signed: () => Promise<SignedRuntime>
  /** The clock for the records' times; `() => new Date()` by default. */
  readonly now?: () => Date
  /** The limits of the copy's scan, and of the copy `edit-harness` makes; {@link CONTENT_LIMITS} by default. A test hook. */
  readonly limits?: ScanLimits
}

/** A file of the runtime's writable copy that differs from what the runtime runs, waiting for review. */
export interface HarnessChange {
  readonly id: ChangeId
  readonly kind: 'harness-edit'
  /** The runtime version. */
  readonly runtime: string
  /** The file's path relative to the runtime, under `app/`. */
  readonly file: string
  /** `added` when the runtime runs no such file, `removed` when the copy no longer holds it. */
  readonly status: FileChange['status']
  /** What the runtime runs for the file: its approved or signed content, or the empty version when it runs none. */
  readonly from: ContentVersion
  /** What the copy holds: a one-file version, or the empty version when the person deleted the file. */
  readonly to: ContentVersion
}

/** A harness change with what the person reviews. */
export interface HarnessReview extends HarnessChange {
  readonly files: readonly FileChange[]
  readonly diff: BoundedDiff
  readonly risk: RiskSummary
}

/** What the runtime's writable copy holds against what the runtime runs. */
export interface HarnessPending {
  /** The copy's directory; undefined when the runtime has none. */
  readonly copy?: string
  /** The changes waiting for review, by path. */
  readonly changes: readonly HarnessChange[]
  /** Entries of the copy that are no harness file: links, FIFOs, sockets and devices, and paths outside `app/`. */
  readonly skipped: readonly string[]
  /** Files named `*.mine`, which an update keeps beside a file it could not merge; never a change. */
  readonly keptBeside: readonly string[]
}

/** What the harness's change log and the running runtime's copy hold, as `list` shows them. */
export interface HarnessListing extends HarnessPending {
  /** The running runtime version; absent when Delorun does not run from the runtime store. */
  readonly runtime?: string
  /** The running runtime's changes a failed start left out that stay out, newest first. */
  readonly leftOut: readonly ChangeEntry[]
  /** Every other logged harness change, of every runtime, newest first. */
  readonly entries: readonly ChangeEntry[]
}

/** What discarding every harness change of the running runtime did. */
export interface HarnessReset {
  /** The pending changes, now discarded. */
  readonly discarded: readonly ChangeEntry[]
  /** The applied changes, now undone. */
  readonly undone: readonly ChangeEntry[]
  /**
   * Why the copy could not be read, when it could not: the changes waiting in it were then removed with it without
   * being logged.
   */
  readonly unread?: string
}

/** What the writable copy's creation did. */
export interface HarnessCopy {
  /** The copy's `app/` directory. */
  readonly directory: string
  /** Whether this call created it; false when it existed already. */
  readonly created: boolean
}

/** The suffix of a file an update keeps beside one it could not merge. */
export const KEPT_BESIDE_SUFFIX = '.mine'

/** The mode of a file the person writes in the copy. */
const COPY_FILE_MODE = 0o600

/** The mode of an executable file the person writes in the copy. */
const COPY_EXECUTABLE_MODE = 0o700

/** The content a path has: a file's digest, size and execute bit, or nothing. */
type Content = { readonly digest: ObjectDigest, readonly size: number, readonly executable: boolean } | undefined

/** What the runtime runs for one path, and where its bytes come from. */
interface Expected {
  readonly content: Content
  /** The approved version the record names, when it names the path. */
  readonly approved?: ContentVersion
  /** The signed file, when the list has the path. */
  readonly signed?: SignedFile
}

/** A pending change with where both sides' bytes come from. */
interface Located extends HarnessChange {
  readonly expected: Expected
  /** The copy's file, when the copy holds one. */
  readonly copied?: { readonly source: string, readonly entry: FileEntry }
}

/**
 * @param ctx - the runtime.
 * @returns the time an action records, ISO 8601.
 */
function timeOf(ctx: HarnessContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString()
}

/**
 * The id of a one-file version, without storing it.
 * @param path - the file's path.
 * @param content - its content; undefined for the empty version.
 * @returns the version id.
 */
function versionIdOf(path: string, content: Content): ContentVersion {
  return versionOf(content === undefined ? [] : [{ type: 'file', path, digest: content.digest, size: content.size, executable: content.executable }])
}

/**
 * @param a - one content.
 * @param b - the other.
 * @returns whether both are absent, or both are files with the same bytes and execute bit.
 */
function sameContent(a: Content, b: Content): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.digest === b.digest && a.executable === b.executable
}

/**
 * @param file - a signed file.
 * @returns its content.
 */
function signedContent(file: SignedFile): Content {
  return { digest: brandString<ObjectDigest>(file.sha256), size: file.length, executable: file.executable }
}

/**
 * Read a one-file version's content.
 * @param home - the Delorun home.
 * @param version - a one-file or empty version.
 * @returns its file's content, or undefined for the empty version.
 * @throws {ChangesError} `STORE_CORRUPT` when the store does not hold the version, or it holds anything but one file.
 */
async function fileContentOf(home: string, version: ContentVersion): Promise<Content> {
  const { entries } = await readVersion(home, version)
  if (entries.length === 0) return undefined
  const [entry] = entries
  if (entries.length !== 1 || entry?.type !== 'file') throw new ChangesError('STORE_CORRUPT', version, `version ${version} is not the content of one harness file`)
  return { digest: entry.digest, size: entry.size, executable: entry.executable }
}

/**
 * Read one signed file's bytes from the installation, checked against the signed file list.
 * @param signed - the installation.
 * @param file - the signed file.
 * @returns its bytes.
 * @throws {ChangesError} `RUNTIME_CHANGED` when the installation's file is not a regular file with the listed length
 *   and SHA-256.
 */
export async function readSignedFile(signed: SignedRuntime, file: SignedFile): Promise<Buffer> {
  const path = join(signed.directory, ...file.path.split('/'))
  const chunks: Buffer[] = []
  try {
    const { handle } = await openRegularFile(path)
    try {
      await readChunks(handle, { size: file.length, path }, (chunk) => { chunks.push(Buffer.from(chunk)) })
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new ChangesError('RUNTIME_CHANGED', path, `${path} cannot be read as the signed release's file: ${(error as Error).message}`, { cause: error })
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.length !== file.length || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new ChangesError('RUNTIME_CHANGED', path, `${path} differs from the signed release's file`)
  }
  return bytes
}

/**
 * Read a file of the copy, checked against what its scan found.
 * @param source - the file.
 * @param entry - its scanned entry.
 * @returns its bytes.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the file changed since it was scanned.
 */
async function readCopied(source: string, entry: FileEntry): Promise<Buffer> {
  const chunks: Buffer[] = []
  const { handle } = await openRegularFile(source)
  try {
    await readChunks(handle, { size: entry.size, path: source }, (chunk) => { chunks.push(Buffer.from(chunk)) })
  } finally {
    await handle.close()
  }
  const bytes = Buffer.concat(chunks)
  if (createHash('sha256').update(bytes).digest('hex') !== entry.digest) throw new ChangesError('CHANGED_WHILE_READING', source, `${source} changed while it was read`)
  return bytes
}

/**
 * The signed files under `app/`, by path.
 * @param signed - the installation.
 * @returns them.
 */
function appFiles(signed: SignedRuntime): Map<string, SignedFile> {
  return new Map(signed.files.filter(file => isHarnessPath(file.path)).map(file => [file.path, file]))
}

/**
 * What the runtime runs for a path.
 * @param home - the Delorun home.
 * @param record - the runtime's harness record.
 * @param signed - the signed files under `app/`.
 * @param path - the path.
 * @returns the expected content and where it comes from.
 */
async function expectedOf(home: string, record: HarnessRecord, signed: ReadonlyMap<string, SignedFile>, path: string): Promise<Expected> {
  const file = signed.get(path)
  const approved = Object.hasOwn(record.files, path) ? record.files[path] : undefined
  if (approved !== undefined) return { content: await fileContentOf(home, approved.version), approved: approved.version, ...file === undefined ? {} : { signed: file } }
  return file === undefined ? { content: undefined } : { content: signedContent(file), signed: file }
}

/**
 * Write a file's bytes at a path below a directory the person writes, replacing what is there.
 * @param path - the file.
 * @param bytes - its bytes.
 * @param executable - whether it is executable.
 */
async function writeCopyFile(path: string, bytes: Buffer, executable: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.delorun-tmp`)
  const handle = await open(temporary, 'wx', executable ? COPY_EXECUTABLE_MODE : COPY_FILE_MODE)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
  await chmod(temporary, executable ? COPY_EXECUTABLE_MODE : COPY_FILE_MODE)
  await rename(temporary, path)
}

/**
 * The bytes of a one-file version from the store.
 * @param home - the Delorun home.
 * @param version - the version.
 * @returns its file's bytes and execute bit, or undefined for the empty version.
 */
async function versionBytes(home: string, version: ContentVersion): Promise<{ readonly bytes: Buffer, readonly executable: boolean } | undefined> {
  const content = await fileContentOf(home, version)
  return content === undefined ? undefined : { bytes: await readObject(home, content.digest), executable: content.executable }
}

/**
 * Make the copy hold a path's content: a file's bytes from the store, or nothing.
 * @param home - the Delorun home.
 * @param copy - the copy's directory.
 * @param path - the path.
 * @param version - a one-file or empty version.
 */
async function putInCopy(home: string, copy: string, path: string, version: ContentVersion): Promise<void> {
  const target = join(copy, ...path.split('/'))
  const content = await versionBytes(home, version)
  if (content === undefined) await rm(target, { force: true, recursive: true })
  else await writeCopyFile(target, content.bytes, content.executable)
}

/**
 * Whether a path exists, without following a link.
 * @param path - the path.
 * @returns whether it does.
 * @throws the filesystem error other than `ENOENT`, such as `EACCES`.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Create the person's writable copy of the running runtime's `app/` directory, unless it exists: a copy of the signed
 * installation's `app/` with the record's approved files in place and its removed ones absent, never a link to the
 * installation. Files are 0600, executable ones 0700, directories 0700. Every signed byte is checked against the
 * verified list as it is read.
 * @param ctx - the runtime.
 * @param presence - proof that the person is at their computer.
 * @returns the copy's `app/` directory and whether this call created it.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `CONTENT_TOO_LARGE`, before
 *   anything is copied, when the copy would pass the limits of its scan ({@link checkHarnessCopySize}); `RUNTIME_CHANGED`
 *   when a signed file differs from the list; `STORE_CORRUPT` when the store does not hold an approved version.
 */
export async function createHarnessCopy(ctx: HarnessContext, presence: AtComputer): Promise<HarnessCopy> {
  requirePresence(presence, ctx.runtime)
  const copy = harnessCopyDirectory(ctx.home, ctx.runtime)
  return withHarnessLock(ctx.home, async () => {
    if (await pathExists(copy)) return { directory: join(copy, 'app'), created: false }
    const signed = await ctx.signed()
    const record = await readHarnessRecord(ctx.home, ctx.runtime)
    await checkHarnessCopySize(ctx.home, ctx.runtime, signed, record, ctx.limits ?? CONTENT_LIMITS)
    await writeHarnessCopy(ctx.home, ctx.runtime, signed, record)
    return { directory: join(copy, 'app'), created: true }
  })
}

/**
 * Refuse a writable copy its scan could not read: count, from the signed file list and the record, the files and
 * directories `changes/harness/<runtime>/copy/` would hold (itself included) and their bytes, as the copy's scan
 * counts them. Nothing is read from the installation.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the runtime's signed installation.
 * @param record - the runtime's harness record.
 * @param limits - the limits of the copy's scan.
 * @throws {ChangesError} `CONTENT_TOO_LARGE`, subject the installation's `app/` directory, naming the limit the copy
 *   would pass; `STORE_CORRUPT` when the store does not hold an approved version.
 */
export async function checkHarnessCopySize(home: string, runtime: string, signed: SignedRuntime, record: HarnessRecord, limits: ScanLimits): Promise<void> {
  const sizes = new Map<string, number>()
  for (const file of appFiles(signed).values()) if (!Object.hasOwn(record.files, file.path)) sizes.set(file.path, file.length)
  for (const [path, approved] of Object.entries(record.files)) {
    const content = await fileContentOf(home, approved.version)
    if (content !== undefined) sizes.set(path, content.size)
  }
  const directories = new Set(['', 'app'])
  for (const path of sizes.keys()) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) directories.add(parent)
  const app = join(signed.directory, 'app')
  const cannot = `so changes to Delorun ${runtime} itself cannot be made for this release.`
  if (directories.size + sizes.size > limits.entries) {
    throw new ChangesError('CONTENT_TOO_LARGE', app, `${app} holds more than ${String(limits.entries)} files and directories, the most Delorun reads in your copy of it, ${cannot}`)
  }
  if ([...sizes.values()].reduce((total, size) => total + size, 0) > limits.bytes) {
    throw new ChangesError('CONTENT_TOO_LARGE', app, `${app} holds more than ${byteLimitWords(limits.bytes)}, the most Delorun reads in your copy of it, ${cannot}`)
  }
}

/**
 * Write a runtime's writable copy where none exists: the signed installation's `app/` files with the record's approved
 * files in place and its removed ones absent, staged and renamed into `changes/harness/<runtime>/copy/`. The copy
 * changes nothing a start runs; its files become changes only when the person applies them. The caller holds
 * {@link withHarnessLock}; {@link createHarnessCopy} and an update's carry ([harness merge](./harness-merge.ts)) call it.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param signed - the runtime's signed installation, every byte read from it checked against the list.
 * @param record - the runtime's harness record.
 * @returns the copy's `app/` directory.
 * @throws {ChangesError} `RUNTIME_CHANGED` when a signed file differs from the list; `STORE_CORRUPT` when the store
 *   does not hold an approved version. Nothing is left behind then.
 */
export async function writeHarnessCopy(home: string, runtime: string, signed: SignedRuntime, record: HarnessRecord): Promise<string> {
  const copy = harnessCopyDirectory(home, runtime)
  const parent = harnessRuntimeDirectory(home, runtime)
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE })
  const staging = join(parent, `.copy.delorun-tmp-${randomBytes(8).toString('hex')}`)
  await mkdir(staging, { mode: PRIVATE_DIR_MODE })
  try {
    for (const file of appFiles(signed).values()) {
      if (Object.hasOwn(record.files, file.path)) continue
      await writeCopyFile(join(staging, ...file.path.split('/')), await readSignedFile(signed, file), file.executable)
    }
    for (const [path, approved] of Object.entries(record.files)) await putInCopy(home, staging, path, approved.version)
    await mkdir(join(staging, 'app'), { recursive: true, mode: PRIVATE_DIR_MODE })
    await rename(staging, copy)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return join(copy, 'app')
}

/**
 * Keep the person's content of a file an update could not merge beside the file in a runtime's writable copy, as
 * `<file>.mine`, 0600 and never executable; a `*.mine` file is never a change ({@link KEPT_BESIDE_SUFFIX}).
 * @param home - the Delorun home.
 * @param runtime - the runtime whose copy holds it.
 * @param file - the file's path relative to the runtime, under `app/`.
 * @param bytes - the person's content.
 * @returns the kept file's path relative to the runtime.
 */
export async function keepBeside(home: string, runtime: string, file: string, bytes: Buffer): Promise<string> {
  const kept = `${file}${KEPT_BESIDE_SUFFIX}`
  await writeCopyFile(join(harnessCopyDirectory(home, runtime), ...kept.split('/')), bytes, false)
  return kept
}

/** How the copy is read. */
export interface HarnessReadOptions {
  /** Whether the scan reads and rewrites the runtime's scan cache; true by default, false for a report that writes nothing. */
  readonly cache?: boolean
}

/**
 * Compute the pending changes of the running runtime's copy. Nothing is stored or logged.
 * @param ctx - the runtime.
 * @param options - whether the scan cache is used.
 * @returns the changes with where their bytes come from, the skipped entries and the files kept beside.
 */
async function locatePending(ctx: HarnessContext, options: HarnessReadOptions = {}): Promise<HarnessPending & { readonly located: readonly Located[] }> {
  const copy = harnessCopyDirectory(ctx.home, ctx.runtime)
  const scanned = await scanCopy(ctx, options)
  if (scanned === undefined) return { changes: [], located: [], skipped: [], keptBeside: [] }
  const skipped = [...scanned.skipped]
  const keptBeside: string[] = []
  const present = new Map<string, { readonly source: string, readonly entry: FileEntry }>()
  const sources = new Map(scanned.files.map(file => [file.entry.path, file.source]))
  for (const entry of scanned.entries) {
    if (entry.type === 'link' || !isHarnessPath(entry.path)) skipped.push(entry.path)
    else if (entry.path.endsWith(KEPT_BESIDE_SUFFIX)) keptBeside.push(entry.path)
    else present.set(entry.path, { source: sources.get(entry.path)!, entry })
  }
  const record = await readHarnessRecord(ctx.home, ctx.runtime)
  const signed = appFiles(await ctx.signed())
  const expectedPaths = [...signed.keys()].filter(path => !Object.hasOwn(record.files, path))
  for (const path of Object.keys(record.files)) expectedPaths.push(path)
  const skippedPaths = new Set(skipped)
  const paths = [...new Set([...present.keys(), ...expectedPaths])].filter(path => !skippedPaths.has(path)).sort(compareCodeUnits)
  const located: Located[] = []
  for (const path of paths) {
    const copied = present.get(path)
    const expected = await expectedOf(ctx.home, record, signed, path)
    const current: Content = copied === undefined ? undefined : { digest: copied.entry.digest, size: copied.entry.size, executable: copied.entry.executable }
    if (sameContent(current, expected.content)) continue
    const from = versionIdOf(path, expected.content)
    const to = versionIdOf(path, current)
    located.push({
      id: changeId('harness-edit', { file: path, runtime: ctx.runtime }, from, to),
      kind: 'harness-edit',
      runtime: ctx.runtime,
      file: path,
      status: expected.content === undefined ? 'added' : current === undefined ? 'removed' : 'modified',
      from,
      to,
      expected,
      ...copied === undefined ? {} : { copied },
    })
  }
  return { copy: join(copy, 'app'), changes: located.map(publicChange), located, skipped: skipped.sort(compareCodeUnits), keptBeside }
}

/**
 * Scan the running runtime's copy, following no link.
 * @param ctx - the runtime.
 * @param options - whether the scan cache is used.
 * @returns the scan, or undefined when the runtime has no copy.
 * @throws {ChangesError} `HARNESS_COPY_UNREADABLE` when the copy is not a directory, passes the scan's limits or holds
 *   an entry that cannot be read; `CHANGED_WHILE_READING` when a file changed while it was read.
 */
async function scanCopy(ctx: HarnessContext, options: HarnessReadOptions): Promise<ScannedFolder | undefined> {
  const copy = harnessCopyDirectory(ctx.home, ctx.runtime)
  const unreadable = (cause: Error): ChangesError => {
    const app = join(copy, 'app')
    return new ChangesError('HARNESS_COPY_UNREADABLE', app, `Your copy of Delorun ${ctx.runtime} in ${app} cannot be read, so Delorun cannot tell which changes wait there: ${unreadReason(cause)}. Remove what does not belong in it, or take back every change to Delorun ${ctx.runtime} itself: delorun changes edit-harness --discard`, { cause })
  }
  try {
    if (!await pathExists(copy)) return undefined
    if ((await lstat(copy)).isDirectory()) return await scanFolder(copy, { active: true, ...options.cache === false ? {} : { cache: harnessScanCachePath(ctx.home, ctx.runtime) }, ...ctx.limits === undefined ? {} : { limits: ctx.limits } })
  } catch (error) {
    if (isChangesError(error) && error.code === 'CHANGED_WHILE_READING') throw error
    throw unreadable(error as Error)
  }
  throw unreadable(new Error(`${copy} is not a directory`))
}

/**
 * @param error - why the copy could not be read: the scan's failure, or the `HARNESS_COPY_UNREADABLE` refusal or
 *   `CHANGED_WHILE_READING` failure of its scan.
 * @returns the reason in the person's words, without a remedy.
 */
function unreadReason(error: Error): string {
  if (isChangesError(error) && error.code === 'HARNESS_COPY_UNREADABLE') return unreadReason(error.cause as Error)
  return isChangesError(error) ? error.detail : error.message
}

/**
 * @param located - a located change.
 * @returns it without where its bytes come from.
 */
function publicChange(located: Located): HarnessChange {
  const { expected: _expected, copied: _copied, ...change } = located
  return change
}

/**
 * The changes waiting for review in the running runtime's writable copy: one per file that differs from what the
 * runtime runs, an added or deleted file included. Nothing is stored or logged; with the scan cache off, nothing is
 * written.
 * @param ctx - the runtime.
 * @param options - whether the scan cache is used.
 * @returns the changes, the entries the scan skipped and the files kept beside.
 * @throws {ChangesError} `HARNESS_COPY_UNREADABLE` when the copy is not a directory, passes the scan's limits or holds an
 *   entry that cannot be read; `CHANGED_WHILE_READING`.
 */
export async function harnessChanges(ctx: HarnessContext, options: HarnessReadOptions = {}): Promise<HarnessPending> {
  const { located: _located, ...pending } = await locatePending(ctx, options)
  return pending
}

/**
 * Store both sides of a change, so its review and an apply read them from the store.
 * @param ctx - the runtime.
 * @param change - the located change.
 * @throws {ChangesError} `CHANGED_WHILE_READING` when the copy's file changed since the scan; `RUNTIME_CHANGED` when a
 *   signed file differs from the list.
 */
async function storeSides(ctx: HarnessContext, change: Located): Promise<void> {
  const { expected, copied } = change
  if (expected.content === undefined || copied === undefined) await storeEmptyVersion(ctx.home)
  if (expected.approved === undefined && expected.signed !== undefined) {
    const signed = await ctx.signed()
    await storeFileVersion(ctx.home, change.file, await readSignedFile(signed, expected.signed), expected.signed.executable)
  }
  if (copied !== undefined) await storeFileVersion(ctx.home, change.file, await readCopied(copied.source, copied.entry), copied.entry.executable)
}

/**
 * The review of a harness change whose two versions the store holds: its file, the bounded diff and the risk summary.
 * The file counts as the harness's own, not a dependency's, though it lies below `node_modules`.
 * @param home - the Delorun home.
 * @param change - the change.
 * @returns the review.
 * @throws {ChangesError} `STORE_CORRUPT` when the store does not hold a version or an object.
 */
export async function reviewHarnessChange(home: string, change: HarnessChange): Promise<HarnessReview> {
  const before = await readVersion(home, change.from)
  const after = await readVersion(home, change.to)
  const files = (await compareVersions(home, before, after)).map(file => ({ ...file, dependency: false }))
  const diff = await boundedDiff(home, before, after, files)
  const risk = reviewChange(await reviewInputOf(home, before, after, files, {}, diff.omitted))
  return { ...change, files, diff, risk }
}

/**
 * Whether an id names a change of a file whose copy no longer holds the content it named: some content version in the
 * store, against what the runtime runs for a path the record or the copy names now.
 * @param ctx - the runtime.
 * @param pending - the changes computed now.
 * @param id - the id.
 * @returns whether it does.
 */
async function isStale(ctx: HarnessContext, pending: readonly Located[], id: ChangeId): Promise<boolean> {
  const record = await readHarnessRecord(ctx.home, ctx.runtime)
  const froms = new Map<string, ContentVersion>(pending.map(change => [change.file, change.from]))
  for (const [path, file] of Object.entries(record.files)) if (!froms.has(path)) froms.set(path, file.version)
  if (froms.size === 0) return false
  // Storing the empty version creates the versions directory when no change was stored yet.
  await storeEmptyVersion(ctx.home)
  const versions = (await readdir(versionsDirectory(ctx.home))).map(name => brandString<ContentVersion>(name.replace(/\.json$/u, '')))
  return [...froms].some(([file, from]) => versions.some(to => changeId('harness-edit', { file, runtime: ctx.runtime }, from, to) === id))
}

/** Where a harness change id was found. */
type Found =
  | { readonly kind: 'pending', readonly change: Located }
  | { readonly kind: 'logged', readonly entry: ChangeEntry }

/**
 * Find a harness change by its id: one the copy holds now, or a logged one.
 * @param ctx - the runtime.
 * @param log - the harness's change log.
 * @param id - the id.
 * @returns where it was found, or undefined when no harness change has the id.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the id names content the copy no longer holds.
 */
async function find(ctx: HarnessContext, log: ChangeLog, id: ChangeId): Promise<Found | undefined> {
  const entry = findEntry(log, id)
  if (entry !== undefined && entry.state !== 'discarded') return { kind: 'logged', entry }
  const pending = await locatePending(ctx)
  const change = pending.located.find(candidate => candidate.id === id)
  if (change !== undefined) return { kind: 'pending', change }
  if (entry !== undefined) return { kind: 'logged', entry }
  if (await isStale(ctx, pending.located, id)) {
    throw new ChangesError('CHANGED_SINCE_REVIEW', id, `The file of change ${id} changed in your copy of Delorun after it was shown, so ${id} no longer names what it holds. See the change it holds now: delorun changes list`)
  }
  return undefined
}

/**
 * Whether a harness change id names a change of the running runtime: one its copy holds now, or one the harness's
 * change log records for any runtime. Nothing is stored.
 * @param ctx - the runtime.
 * @param id - the id.
 * @returns the change waiting for review, the logged entry, or undefined when no harness change has the id.
 * @throws {ChangesError} `CHANGED_SINCE_REVIEW` when the id names content the copy no longer holds.
 */
export async function findHarnessChange(ctx: HarnessContext, id: ChangeId): Promise<{ readonly kind: 'pending', readonly change: HarnessChange } | { readonly kind: 'logged', readonly entry: ChangeEntry } | undefined> {
  const found = await find(ctx, await readHarnessLog(ctx.home), id)
  return found?.kind === 'pending' ? { kind: 'pending', change: publicChange(found.change) } : found
}

/**
 * One harness change waiting for review, with its diff and risk summary: both sides are stored first, so what is shown
 * is what an apply approves.
 * @param ctx - the runtime.
 * @param id - the id.
 * @returns the review, or undefined when the copy holds no change with the id.
 * @throws {ChangesError} `CHANGED_WHILE_READING`, `RUNTIME_CHANGED` or `STORE_CORRUPT` as reading both sides does.
 */
export async function showHarnessChange(ctx: HarnessContext, id: ChangeId): Promise<HarnessReview | undefined> {
  const change = (await locatePending(ctx)).located.find(candidate => candidate.id === id)
  if (change === undefined) return undefined
  await storeSides(ctx, change)
  return reviewHarnessChange(ctx.home, publicChange(change))
}

/**
 * @param change - a harness change.
 * @returns its one line in the person's words.
 */
export function harnessChangeSummary(change: Pick<HarnessChange, 'file' | 'runtime'>): string {
  return `Delorun ${change.runtime} itself: ${change.file}`
}

/**
 * @param change - a harness change.
 * @param at - when it was first recorded.
 * @returns its log entry, pending.
 */
function pendingEntry(change: HarnessChange, at: string): ChangeEntry {
  return { id: change.id, kind: 'harness-edit', state: 'pending', subject: { file: change.file, runtime: change.runtime }, from: change.from, to: change.to, summary: harnessChangeSummary(change), createdAt: at }
}

/**
 * The record with one file's approved content set, or removed when it is what the signed release has.
 * @param record - the record.
 * @param path - the file.
 * @param approval - the new approval; undefined to remove the entry.
 * @returns the new record.
 */
function withApprovedFile(record: HarnessRecord, path: string, approval: ApprovedHarnessFile | undefined): HarnessRecord {
  const { [path]: _previous, ...others } = record.files
  return { ...record, files: approval === undefined ? others : { ...others, [path]: approval } }
}

/**
 * The signed release's one-file version of a path, stored, or undefined when the list has no such file.
 * @param ctx - the runtime.
 * @param path - the path.
 * @returns the version.
 * @throws {ChangesError} `RUNTIME_CHANGED` when the signed file differs from the list.
 */
async function signedVersionOf(ctx: HarnessContext, path: string): Promise<ContentVersion | undefined> {
  const signed = await ctx.signed()
  const file = signed.files.find(candidate => candidate.path === path)
  return file === undefined ? undefined : storeFileVersion(ctx.home, path, await readSignedFile(signed, file), file.executable)
}

/**
 * The record after a file's approved content becomes a version: the entry is removed when that is the signed file, or
 * no file where the signed release has none.
 * @param ctx - the runtime.
 * @param record - the record.
 * @param path - the file.
 * @param version - the content.
 * @param change - the change that approved it.
 * @param at - when.
 * @returns the new record.
 */
async function approving(ctx: HarnessContext, record: HarnessRecord, path: string, version: ContentVersion, change: ChangeId, at: string): Promise<HarnessRecord> {
  const signed = await signedVersionOf(ctx, path)
  const empty = await storeEmptyVersion(ctx.home)
  if (version === (signed ?? empty)) return withApprovedFile(record, path, undefined)
  return withApprovedFile(record, path, { version, ...signed === undefined ? {} : { signed }, change, approvedAt: at })
}

/**
 * The approved version of a file the running runtime runs now: the record's, or the signed file's, or the empty
 * version.
 * @param ctx - the runtime.
 * @param record - the record.
 * @param path - the file.
 * @returns the version.
 */
async function currentVersion(ctx: HarnessContext, record: HarnessRecord, path: string): Promise<ContentVersion> {
  if (Object.hasOwn(record.files, path)) return record.files[path]!.version
  return await signedVersionOf(ctx, path) ?? await storeEmptyVersion(ctx.home)
}

/**
 * Apply a harness change: the copy's content of the file becomes its approved content in the runtime's record, stored
 * in the store, and the change is logged applied. The signed installation is never written; the next start runs it.
 * A change a failed start left out is applied again while the record still holds its content.
 * @param ctx - the runtime.
 * @param id - the change id the person reviewed.
 * @param presence - proof that the person is at their computer.
 * @param options - `reviewedTo`, the full content version the review showed as the change's new content; the studio
 *   sends it, because the id binds that content through a truncated digest only.
 * @returns the change's log entry.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `CHANGED_SINCE_REVIEW` when
 *   the copy no longer holds what the id names, or the change's new content is not `reviewedTo`; `UNKNOWN_CHANGE`;
 *   `NOT_ALLOWED` for a change decided already.
 */
export async function applyHarnessChange(ctx: HarnessContext, id: ChangeId, presence: AtComputer, options: { readonly reviewedTo?: ContentVersion } = {}): Promise<ChangeEntry> {
  requirePresence(presence, id)
  return withHarnessLock(ctx.home, async () => {
    const log = await readHarnessLog(ctx.home)
    const found = await requireFound(ctx, log, id)
    const to = found.kind === 'pending' ? found.change.to : found.entry.to
    if (options.reviewedTo !== undefined && to !== options.reviewedTo) {
      throw new ChangesError('CHANGED_SINCE_REVIEW', id, `Change ${id} does not hold the content you were shown; look at it again.`)
    }
    const at = timeOf(ctx)
    if (found.kind === 'logged') {
      const { entry } = found
      if (entry.state !== 'left-out-at-start') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so it cannot be applied.`)
      const record = await readHarnessRecord(ctx.home, ctx.runtime)
      if (entry.subject.runtime !== ctx.runtime || entry.to === undefined || await currentVersion(ctx, record, entry.subject.file!) !== entry.to) {
        throw new ChangesError('NOT_ALLOWED', id, `Delorun no longer has what change ${id} applied, so there is nothing to apply again. See the changes: delorun changes list`)
      }
      const { leftOut: _leftOut, lastFailure: _lastFailure, ...applied } = entry
      const done: ChangeEntry = { ...applied, state: 'applied', decidedAt: at, decidedFrom: presence.kind }
      await writeHarnessLog(ctx.home, withEntry(log, done))
      return done
    }
    const { change } = found
    await storeSides(ctx, change)
    const record = await readHarnessRecord(ctx.home, ctx.runtime)
    await writeHarnessRecord(ctx.home, await approving(ctx, record, change.file, change.to, id, at))
    const done: ChangeEntry = { ...pendingEntry(change, findEntry(log, id)?.createdAt ?? at), state: 'applied', decidedAt: at, decidedFrom: presence.kind }
    await writeHarnessLog(ctx.home, withEntry(log, done))
    return done
  })
}

/** What a start applied without review from the harness's writable copy while protection is off. */
export interface UnreviewedHarness {
  /** The changes applied, each logged as decided `unreviewed`. */
  readonly applied: readonly ChangeEntry[]
  /** Why the copy could not be read, when it could not: nothing was applied, and the runtime runs what it ran. */
  readonly unread?: string
}

/**
 * Apply every change waiting in the running runtime's writable copy without review, as a start does while protection
 * is off: each file's copy content becomes its approved content in the runtime's record, stored in the store, and the
 * change is logged applied and decided `unreviewed`, so `list`, `show` and `undo` reach it as any other. The protection
 * setting is read again under the harness lock, and nothing is applied when it is on. Needs no proof of presence: the
 * signed code's start calls it before it composes the tree ([harness tree](./harness-tree.ts)). The signed installation
 * is never written.
 * @param ctx - the runtime.
 * @returns what was applied, or why the copy could not be read.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the protection setting or a harness record is not one Delorun wrote;
 *   `RUNTIME_CHANGED` when a signed file differs from the list.
 */
export async function applyUnreviewedHarnessChanges(ctx: HarnessContext): Promise<UnreviewedHarness> {
  return withHarnessLock(ctx.home, async () => {
    if (await readProtection(ctx.home) === 'on' || !await pathExists(harnessCopyDirectory(ctx.home, ctx.runtime))) return { applied: [] }
    let pending: readonly Located[]
    try {
      pending = (await locatePending(ctx)).located
    } catch (error) {
      if (!isChangesError(error) || (error.code !== 'HARNESS_COPY_UNREADABLE' && error.code !== 'CHANGED_WHILE_READING')) throw error
      return { applied: [], unread: unreadReason(error) }
    }
    const at = timeOf(ctx)
    let log = await readHarnessLog(ctx.home)
    let record = await readHarnessRecord(ctx.home, ctx.runtime)
    const applied: ChangeEntry[] = []
    for (const change of pending) {
      await storeSides(ctx, change)
      record = await approving(ctx, record, change.file, change.to, change.id, at)
      const done: ChangeEntry = { ...pendingEntry(change, findEntry(log, change.id)?.createdAt ?? at), summary: `Loaded without review: ${harnessChangeSummary(change)}`, state: 'applied', decidedAt: at, decidedFrom: 'unreviewed' }
      log = withEntry(log, done)
      applied.push(done)
    }
    if (applied.length === 0) return { applied }
    await writeHarnessRecord(ctx.home, record)
    await writeHarnessLog(ctx.home, log)
    return { applied }
  })
}

/**
 * @param ctx - the runtime.
 * @param log - the harness's change log.
 * @param id - the id.
 * @returns where the change was found.
 * @throws {ChangesError} `UNKNOWN_CHANGE` when no harness change has the id; `CHANGED_SINCE_REVIEW`.
 */
async function requireFound(ctx: HarnessContext, log: ChangeLog, id: ChangeId): Promise<Found> {
  const found = await find(ctx, log, id)
  if (found === undefined) throw new ChangesError('UNKNOWN_CHANGE', id, `No change has the id ${id}. See the changes: delorun changes list`)
  return found
}

/**
 * Discard a harness change waiting for review: the copy holds what the runtime runs for the file again, an added file
 * removed, and the change is logged discarded. Nothing the runtime runs changes.
 * @param ctx - the runtime.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @returns the discarded entry.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `CHANGED_SINCE_REVIEW`;
 *   `UNKNOWN_CHANGE`; `NOT_ALLOWED` for a change that is not waiting for review.
 */
export async function discardHarnessChange(ctx: HarnessContext, id: ChangeId, presence: AtComputer): Promise<ChangeEntry> {
  requirePresence(presence, id)
  return withHarnessLock(ctx.home, async () => {
    const log = await readHarnessLog(ctx.home)
    const found = await requireFound(ctx, log, id)
    if (found.kind === 'logged') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${found.entry.state}, so it cannot be discarded.`)
    const at = timeOf(ctx)
    const entry = await discardLocated(ctx, found.change, at, presence, log)
    await writeHarnessLog(ctx.home, withEntry(log, entry))
    return entry
  })
}

/**
 * Put what the runtime runs for a pending change's file back into the copy.
 * @param ctx - the runtime.
 * @param change - the change.
 * @param at - when.
 * @param presence - the proof.
 * @param log - the log, for the change's first record.
 * @returns the discarded entry, not yet written.
 */
async function discardLocated(ctx: HarnessContext, change: Located, at: string, presence: AtComputer, log: ChangeLog): Promise<ChangeEntry> {
  const copy = harnessCopyDirectory(ctx.home, ctx.runtime)
  const { expected } = change
  if (expected.approved !== undefined) await putInCopy(ctx.home, copy, change.file, expected.approved)
  else if (expected.signed === undefined) await rm(join(copy, ...change.file.split('/')), { force: true, recursive: true })
  else await writeCopyFile(join(copy, ...change.file.split('/')), await readSignedFile(await ctx.signed(), expected.signed), expected.signed.executable)
  return { ...pendingEntry(change, findEntry(log, change.id)?.createdAt ?? at), state: 'discarded', decidedAt: at, decidedFrom: presence.kind }
}

/**
 * Undo an applied harness change, or one a failed start left out: the file's approved content goes back to the
 * change's `from`, the record's entry removed when that is the signed file, the copy holds it, and the change is logged
 * undone.
 * @param ctx - the runtime.
 * @param id - the change id.
 * @param presence - proof that the person is at their computer.
 * @returns the undone entry.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `UNKNOWN_CHANGE`;
 *   `NOT_ALLOWED` for a change neither applied nor left out, one of another runtime, or one whose file a later change
 *   approved, named.
 */
export async function undoHarnessChange(ctx: HarnessContext, id: ChangeId, presence: AtComputer): Promise<ChangeEntry> {
  requirePresence(presence, id)
  return withHarnessLock(ctx.home, async () => {
    const log = await readHarnessLog(ctx.home)
    const entry = findEntry(log, id)
    if (entry?.kind !== 'harness-edit') throw new ChangesError('UNKNOWN_CHANGE', id, `No applied change has the id ${id}. See the changes: delorun changes list`)
    if (entry.state !== 'applied' && entry.state !== 'left-out-at-start') throw new ChangesError('NOT_ALLOWED', id, `Change ${id} is ${entry.state}, so there is nothing to undo.`)
    if (entry.subject.runtime !== ctx.runtime) throw new ChangesError('NOT_ALLOWED', id, `Change ${id} changed Delorun ${String(entry.subject.runtime)}, not Delorun ${ctx.runtime}, which runs.`)
    const at = timeOf(ctx)
    const record = await readHarnessRecord(ctx.home, ctx.runtime)
    const undone = await undoEntry(ctx, record, entry, at, presence, log)
    await writeHarnessRecord(ctx.home, undone.record)
    await writeHarnessLog(ctx.home, withEntry(log, undone.entry))
    return undone.entry
  })
}

/**
 * Undo one applied entry against a record, writing the copy.
 * @param ctx - the runtime.
 * @param record - the record.
 * @param entry - the applied or left-out entry.
 * @param at - when.
 * @param presence - the proof.
 * @param log - the log, for the change that approved the content undoing goes back to.
 * @returns the record and the entry after undoing, not yet written.
 * @throws {ChangesError} `NOT_ALLOWED` naming the later change when the record's content of the file is not the
 *   entry's `to`.
 */
async function undoEntry(ctx: HarnessContext, record: HarnessRecord, entry: ChangeEntry, at: string, presence: AtComputer, log: ChangeLog): Promise<{ readonly record: HarnessRecord, readonly entry: ChangeEntry }> {
  const file = entry.subject.file!
  if (await currentVersion(ctx, record, file) !== entry.to) {
    const later = Object.hasOwn(record.files, file) ? record.files[file]!.change : undefined
    throw new ChangesError('NOT_ALLOWED', entry.id, `${file} no longer has what change ${entry.id} applied${later === undefined ? '' : `; change ${later} changed it later, undo that first`}.`)
  }
  const from = entry.from!
  const approvedBy = log.entries.findLast(candidate => candidate.kind === 'harness-edit' && candidate.state === 'applied' && candidate.subject.runtime === ctx.runtime && candidate.subject.file === file && candidate.to === from)?.id ?? entry.id
  const next = await approving(ctx, record, file, from, approvedBy, at)
  const copy = harnessCopyDirectory(ctx.home, ctx.runtime)
  if (await pathExists(copy)) await putInCopy(ctx.home, copy, file, from)
  const { lastFailure: _lastFailure, ...rest } = entry
  return { record: next, entry: { ...rest, state: 'undone', decidedAt: at, decidedFrom: presence.kind } }
}

/**
 * Discard every harness change of the running runtime: every pending one is logged discarded, every applied one and
 * every one left out at start undone, the runtime's record emptied and the copy removed, its directories made writable
 * first. A copy that cannot be read does not stop it: the changes waiting in it are removed with it, unlogged, and
 * `unread` says why. Afterwards the runtime runs its signed release unchanged.
 * @param ctx - the runtime.
 * @param presence - proof that the person is at their computer.
 * @returns the changes discarded and undone, and why the copy could not be read.
 * @throws {ChangesError} `NOT_AT_COMPUTER` for a proof the attest functions did not issue; `RECORD_UNREADABLE` when the
 *   record or the harness's log is not one Delorun wrote.
 */
export async function discardAllHarnessChanges(ctx: HarnessContext, presence: AtComputer): Promise<HarnessReset> {
  requirePresence(presence, ctx.runtime)
  return withHarnessLock(ctx.home, async () => {
    let log = await readHarnessLog(ctx.home)
    const at = timeOf(ctx)
    const discarded: ChangeEntry[] = []
    let located: readonly Located[] = []
    let unread: string | undefined
    try {
      located = (await locatePending(ctx)).located
    } catch (error) {
      // Which changes wait in a copy that cannot be read is unknown; removing the copy below discards them all.
      if (!isChangesError(error) || (error.code !== 'HARNESS_COPY_UNREADABLE' && error.code !== 'CHANGED_WHILE_READING')) throw error
      unread = unreadReason(error)
    }
    for (const change of located) {
      const entry: ChangeEntry = { ...pendingEntry(change, findEntry(log, change.id)?.createdAt ?? at), state: 'discarded', decidedAt: at, decidedFrom: presence.kind }
      discarded.push(entry)
      log = withEntry(log, entry)
    }
    const record = await readHarnessRecord(ctx.home, ctx.runtime)
    const undone: ChangeEntry[] = []
    for (const entry of log.entries) {
      if (entry.kind !== 'harness-edit' || entry.subject.runtime !== ctx.runtime || (entry.state !== 'applied' && entry.state !== 'left-out-at-start')) continue
      const file = entry.subject.file!
      const approved = Object.hasOwn(record.files, file) ? record.files[file] : undefined
      if (approved?.version !== entry.to) continue
      const { lastFailure: _lastFailure, ...rest } = entry
      undone.push({ ...rest, state: 'undone', decidedAt: at, decidedFrom: presence.kind })
    }
    for (const entry of undone) log = withEntry(log, entry)
    await writeHarnessRecord(ctx.home, { ...record, files: {} })
    await writeHarnessLog(ctx.home, log)
    await removeTree(harnessCopyDirectory(ctx.home, ctx.runtime))
    return { discarded, undone, ...unread === undefined ? {} : { unread } }
  })
}

/**
 * Remove a directory tree, first giving every directory in it its owner's write permission back, as a composed tree's
 * read-only directories need.
 * @param path - the tree.
 */
export async function removeTree(path: string): Promise<void> {
  const writable = async (directory: string): Promise<void> => {
    await chmod(directory, PRIVATE_DIR_MODE)
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(directory, entry.name))
  }
  try {
    const stats = await lstat(path)
    if (stats.isDirectory()) await writable(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await rm(path, { recursive: true, force: true })
}

/**
 * Everything `list` shows of the harness: the running runtime's changes waiting for review in its copy, its changes a
 * failed start left out that stay out, and every other logged harness change of any runtime. Nothing is stored or
 * logged.
 * @param ctx - the running runtime, or undefined when Delorun does not run from the runtime store, which leaves only the
 *   log.
 * @param home - the Delorun home.
 * @returns the listing.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's log or record is not one Delorun wrote; as
 *   {@link harnessChanges}.
 */
export async function listHarness(ctx: HarnessContext | undefined, home: string): Promise<HarnessListing> {
  const log = await readHarnessLog(home)
  const pending = ctx === undefined ? { changes: [], skipped: [], keptBeside: [] } : await harnessChanges(ctx)
  const record = ctx === undefined ? undefined : await readHarnessRecord(home, ctx.runtime)
  const leftOut = ctx === undefined || record === undefined ? [] : harnessLeftOut(log, record).reverse()
  const entries = log.entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.decidedAt ?? entry.createdAt) }))
    .filter(({ entry }) => entry.state !== 'pending' && !leftOut.includes(entry))
    .sort((left, right) => right.at - left.at || right.index - left.index)
    .map(({ entry }) => entry)
  return { ...ctx === undefined ? {} : { runtime: ctx.runtime }, ...pending, leftOut, entries }
}

/**
 * The runtime's changes a failed start left out that stay out: for each file, its newest `left-out-at-start` entry of
 * the record's runtime whose `to` is still the file's approved content.
 * @param log - the harness's change log.
 * @param record - the runtime's harness record.
 * @returns the entries, in log order.
 */
export function harnessLeftOut(log: ChangeLog, record: HarnessRecord): ChangeEntry[] {
  const newest = new Map<string, ChangeEntry>()
  for (const entry of log.entries) {
    if (entry.kind !== 'harness-edit' || entry.state !== 'left-out-at-start' || entry.subject.runtime !== record.runtime) continue
    const file = entry.subject.file!
    if (Object.hasOwn(record.files, file) && record.files[file]!.version === entry.to) newest.set(file, entry)
  }
  return log.entries.filter(entry => [...newest.values()].includes(entry))
}

/**
 * The files a start of the runtime runs other than the signed ones, by path: the record's approved versions, with each
 * change a failed start left out that stays out replaced by its `from`, and an entry dropped when that is the signed
 * file (`signed` in the record) or no file where the signed release has none.
 * @param log - the harness's change log.
 * @param record - the runtime's harness record.
 * @returns the versions by path; empty when the runtime runs its signed release.
 */
export function composedFiles(log: ChangeLog, record: HarnessRecord): Record<string, ContentVersion> {
  const left = new Map(harnessLeftOut(log, record).map(entry => [entry.subject.file!, entry]))
  const files: Record<string, ContentVersion> = {}
  for (const [path, approved] of Object.entries(record.files)) {
    const out = left.get(path)
    if (out === undefined) {
      files[path] = approved.version
    } else if (out.from !== undefined && out.from !== approved.signed && !(approved.signed === undefined && out.from === versionOf([]))) {
      files[path] = out.from
    }
  }
  return files
}

/**
 * The digest that names a set of composed files: the SHA-256 of their canonical list of path and version pairs.
 * @param files - the versions by path.
 * @returns the lowercase hexadecimal digest.
 */
export function composedDigest(files: Readonly<Record<string, ContentVersion>>): string {
  const pairs = Object.entries(files).sort(([a], [b]) => compareCodeUnits(a, b))
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
}

/**
 * A logged harness change as a change to review: its runtime, file and both versions, which the store holds while the
 * entry is pending, applied or left out at start ([collect](./collect.ts)).
 * @param entry - a log entry.
 * @returns the change, or undefined when the entry is not a harness change with both versions.
 */
export function loggedHarnessChange(entry: ChangeEntry): HarnessChange | undefined {
  const { file, runtime } = entry.subject
  if (entry.kind !== 'harness-edit' || file === undefined || runtime === undefined || entry.from === undefined || entry.to === undefined) return undefined
  const empty = versionOf([])
  return { id: entry.id, kind: 'harness-edit', runtime, file, status: entry.from === empty ? 'added' : entry.to === empty ? 'removed' : 'modified', from: entry.from, to: entry.to }
}

/**
 * The running runtime's harness as the home process gives it to the Host (the `changesHarness` service), so the studio's
 * Changes routes decide changes to Delorun itself against the signed file list the home process verified.
 */
export interface ChangesHarnessHost {
  /**
   * The running runtime's harness.
   * @returns it, or undefined when Delorun does not run an installed release from the runtime store.
   */
  context(): HarnessContext | undefined
}
