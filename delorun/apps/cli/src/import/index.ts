/**
 * `delorun import <file>` (contract C8): check an archive, show who signed it
 * and what it holds, ask, and import it. The archive is hostile input until it
 * has passed every check: the file's size is checked before it is read, the
 * archive's declared sizes before any entry is read, and the manifest,
 * checksums, paths, entries, limits, customisation and signature in that
 * order, all before anything is written. A signature that does not verify is
 * refused. A key this home does not trust is shown by its fingerprint, and the
 * import goes on only after the person types that fingerprint; an unsigned
 * archive goes on only after the person types `unverified`. Without a
 * terminal nothing is asked, so nothing is imported.
 *
 * The terminal holds the whole file and one entry at a time in memory, so the
 * file and each entry have lower ceilings than the format's:
 * {@link IMPORT_MAX_FILE_BYTES} and {@link IMPORT_LIMITS}. What Delorun itself
 * checked, the signer's state, is printed first; every field the archive
 * states about itself follows, quoted with every control character escaped.
 *
 * The home trusts its own key. The import runs while this process holds the
 * home lock of every profile, and first finishes an import a crash
 * interrupted. It publishes each workspace into `archive/imported/` under the
 * home by one rename from `archive/staging/`, on the same file system; a
 * failure partway removes every workspace the import already published.
 * Imported chats are kept there, out of every model request, and the studio
 * does not open them yet; the customisation rows are listed and never
 * applied.
 *
 * @module @delorun/cli/import
 */
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { ARCHIVE_LIMITS } from '@delorun/contract-archive-and-trash'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { ArchiveError, ArchiveImporter, DirectoryWorkspaceStore, loadHomeKey, type ArchiveImporterConfig, type ArchivePreview, type ArchiveSizeLimits } from '@delorun/archive'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseFailure } from '../command.ts'
import { groupsOfFour } from '../output.ts'
import { printable, quoted } from '../terminal-text.ts'
import { isYes } from '../trash/terminal.ts'

/** The usage line. */
export const IMPORT_USAGE = 'Usage: delorun import <file> [--profile <name>]'

/** The largest archive file the terminal reads into memory, in bytes: 1 GiB. */
export const IMPORT_MAX_FILE_BYTES = 1024 * 1024 * 1024

/** The limits the terminal applies: the format's, with one entry at most 512 MiB, which it inflates into memory. */
export const IMPORT_LIMITS: ArchiveSizeLimits = { ...ARCHIVE_LIMITS, maxEntryBytes: 512 * 1024 * 1024 }

/** The word a person types to import an archive that carries no signature. */
export const UNVERIFIED_CONFIRMATION = 'unverified'

/** What `delorun import` runs with. */
export interface ImportIo {
  /** The Delorun home. */
  readonly home: string
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
  /** Run the import while this process holds every profile's home lock; refuses while a home process runs. */
  readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>
}

/** The directory under the home that holds the import's staging root and the imported workspaces. */
export const ARCHIVE_HOME_DIRECTORY = DELORUN_HOME_ENTRIES.archive

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @returns `1 chat`, `2 chats`.
 */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The lines that show a person who signed an archive and what it holds: the
 * state Delorun checked first, then what the archive states about itself.
 * @param preview - the checked archive.
 * @returns the lines.
 */
export function previewLines(preview: ArchivePreview): string {
  const signer = !preview.signed
    ? 'Not signed: nothing shows who made this archive or that it is unchanged.'
    : preview.state === 'verified'
      ? `Signed by this home's key ${groupsOfFour(preview.signer.fingerprint)}, which this home trusts.`
      : `! Unverified signer · ${groupsOfFour(preview.signer.fingerprint)}\n  Compare it with the fingerprint the other computer printed before you trust it.`
  const workspaces = preview.workspaces.map(workspace =>
    `    ${quoted(workspace.name)}: ${plural(workspace.chats, 'chat')}, ${plural(workspace.attachments, 'attachment')}`)
  const rows = preview.customisation.map(row => `    ${row.kind} ${quoted(row.target)}`)
  return [
    signer,
    'What the archive states about itself:',
    `  File ${quoted(preview.source)}, written by ${quoted(preview.createdBy)} at ${quoted(preview.exportedAt)}.`,
    `  ${plural(preview.workspaces.length, 'workspace')} (${String(preview.totalBytes)} bytes):`,
    ...workspaces,
    ...rows.length === 0 ? [] : ['  Customisation it carries, listed and not applied:', ...rows],
    '',
  ].join('\n')
}

/**
 * Run `delorun import`.
 * @param args - the arguments after `import`, without `--profile`.
 * @param io - the home, the output, the question and the exclusion.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a file that is not a readable archive, a refusal of the archive, or an import the person did not confirm.
 */
export async function runImport(args: readonly string[], io: ImportIo): Promise<ExitCode> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw parseFailure('import', error)
  }
  const [file, ...extra] = parsed.positionals
  if (file === undefined || extra.length > 0) throw new CliError(EXIT.usage, IMPORT_USAGE)
  const bytes = await readArchiveFile(file)
  return io.exclusive(async () => {
    try {
      return await importArchive(bytes, basename(file), io)
    } catch (error: unknown) {
      if (error instanceof ArchiveError) throw new CliError(EXIT.failed, `delorun import: the archive is refused (${error.code}): ${printable(error.message)}; nothing was imported`)
      throw error
    }
  })
}

/**
 * Finish an interrupted import, show one archive, ask, and import it.
 * @param bytes - the archive.
 * @param source - its file name.
 * @param io - the home, the output and the question.
 * @returns the exit code.
 * @throws {CliError} when the person does not confirm.
 * @throws {ArchiveError} for a refused archive or a failed publication.
 */
async function importArchive(bytes: Uint8Array, source: string, io: ImportIo): Promise<ExitCode> {
  const root = join(io.home, ARCHIVE_HOME_DIRECTORY)
  const ownKey = await loadHomeKey(io.home)
  const base: ArchiveImporterConfig = {
    stagingParent: join(root, 'staging'),
    store: new DirectoryWorkspaceStore(join(root, 'imported')),
    trustedPublicKeys: ownKey === undefined ? [] : [ownKey.publicKey],
    limits: IMPORT_LIMITS,
  }
  const recovered = await new ArchiveImporter(base).recover()
  if (recovered.withdrawn.length > 0 || recovered.removed > 0) {
    io.stdout(`Finished an import that was interrupted: withdrew the ${plural(recovered.withdrawn.length, 'workspace')} it had published and removed what it had staged.\n`)
  }
  const preview = await new ArchiveImporter(base).inspect(bytes, { source })
  io.stdout(previewLines(preview))
  const workspaces = plural(preview.workspaces.length, 'workspace')
  let confirmation: Partial<ArchiveImporterConfig> = {}
  if (preview.reason === 'absent') {
    const typed = await io.ask(`To import ${workspaces} from this unsigned archive anyway, type ${UNVERIFIED_CONFIRMATION}: `)
    if (typed !== UNVERIFIED_CONFIRMATION) throw new CliError(EXIT.failed, 'delorun import: the unsigned archive was not accepted, so nothing was imported')
    confirmation = { acceptUnsigned: true }
  } else {
    if (preview.reason === 'key-not-trusted') {
      const typed = await io.ask('To import it anyway, type the key fingerprint shown above: ')
      if (typed.replace(/\s+/gu, '') !== preview.signer.fingerprint) throw new CliError(EXIT.failed, 'delorun import: the fingerprint was not confirmed, so nothing was imported')
      confirmation = { confirmedPublicKey: preview.signer.publicKey }
    }
    const answer = await io.ask(`Import ${workspaces} into this home? [y/N] `)
    if (!isYes(answer)) throw new CliError(EXIT.failed, 'delorun import: nothing was imported')
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const report = await new ArchiveImporter({ ...base, ...confirmation }).import(bytes, { source })
  const imported = join(ARCHIVE_HOME_DIRECTORY, 'imported')
  io.stdout(`${report.workspaces.map(workspace =>
    `Imported ${quoted(workspace.name)} to ${join(imported, workspace.id)}${workspace.id === workspace.archiveId ? '' : `; the archive's identifier ${quoted(workspace.archiveId)} was taken`}.`).join('\n')}\nImported chats stay out of every model request; opening imported chats in the studio is not available yet.\n`)
  return EXIT.ok
}

/**
 * Read an archive file whose size is within the terminal's ceiling. The file is opened once and its size is read
 * from the open descriptor before any byte is, so a file swapped after the check is not the one read.
 * @param file - the archive's path.
 * @param command - the command whose name starts a refusal.
 * @returns its bytes.
 * @throws {CliError} when the path is not a regular file, is larger than {@link IMPORT_MAX_FILE_BYTES}, or cannot be read.
 */
export async function readArchiveFile(file: string, command = 'delorun import'): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error: unknown) {
    throw new CliError(EXIT.failed, `${command}: the archive cannot be read: ${printable((error as Error).message)}`)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new CliError(EXIT.failed, `${command}: ${quoted(file)} is not a regular file`)
    if (stats.size > IMPORT_MAX_FILE_BYTES) {
      throw new CliError(EXIT.failed, `${command}: ${quoted(file)} holds ${String(stats.size)} bytes, more than the ${String(IMPORT_MAX_FILE_BYTES)} the terminal imports; nothing was read`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
