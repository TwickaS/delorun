/**
 * `delorun import <file>` (contract C8): check an archive, show who signed it
 * and what it holds, ask, and import it. The archive is hostile input until it
 * has passed every check: the file's size is checked before it is read, the
 * archive's declared sizes before any entry is read, and the manifest,
 * checksums, paths, entries, limits, customisation and signature in that
 * order, all before anything is written. A signature that does not verify is
 * refused. A key this home does not trust is shown by its fingerprint, and the
 * import goes on only after the person types that fingerprint; an unsigned
 * archive goes on only after the person accepts it unverified. Without a
 * terminal nothing is asked, so nothing is imported.
 *
 * The home trusts its own key. An import publishes each workspace into
 * `archive/imported/` under the home by one rename from `archive/staging/`, on
 * the same file system; a failure partway removes every workspace the import
 * already published. Imported chats are kept there, out of every model
 * request, and the customisation rows are listed and never applied.
 *
 * @module @delo/cli/import
 */
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { ARCHIVE_LIMITS } from '@delo/contract-archive-and-trash'
import { ArchiveError, ArchiveImporter, DirectoryWorkspaceStore, loadHomeKey, type ArchiveImporterConfig, type ArchivePreview } from '@delo/archive'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { isYes } from '../trash/terminal.ts'

/** The usage line. */
export const IMPORT_USAGE = 'Usage: delorun import <file> [--profile <name>]'

/** What `delorun import` runs with. */
export interface ImportIo {
  /** The Delo home. */
  readonly home: string
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
}

/** The directory under the home that holds the import's staging root and the imported workspaces. */
export const ARCHIVE_HOME_DIRECTORY = 'archive'

/**
 * The lines that show a person who signed an archive and what it holds.
 * @param preview - the checked archive.
 * @returns the lines.
 */
export function previewLines(preview: ArchivePreview): string {
  const signer = preview.signed
    ? `Signed by key ${preview.signer.fingerprint}${preview.state === 'verified' ? ', which this home trusts.' : ', which this home does not know.'}`
    : 'Not signed: nothing shows who made it or that it is unchanged.'
  const workspaces = preview.workspaces.map(workspace =>
    `  ${JSON.stringify(workspace.name)}: ${String(workspace.chats)} chat${workspace.chats === 1 ? '' : 's'}, ${String(workspace.attachments)} attachment${workspace.attachments === 1 ? '' : 's'}`)
  const rows = preview.customisation.map(row => `  ${row.kind} ${JSON.stringify(row.target)}`)
  return [
    `Archive ${preview.source}, written by Delo ${preview.createdBy} at ${preview.exportedAt}.`,
    signer,
    `It holds ${String(preview.workspaces.length)} workspace${preview.workspaces.length === 1 ? '' : 's'} (${String(preview.totalBytes)} bytes):`,
    ...workspaces,
    ...rows.length === 0 ? [] : ['Customisation it carries, listed and not applied:', ...rows],
    '',
  ].join('\n')
}

/**
 * Run `delorun import`.
 * @param args - the arguments after `import`, without `--profile`.
 * @param io - the home, the output and the question.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, a file that is not a readable archive, a refusal of the archive, or an import the person did not confirm.
 */
export async function runImport(args: readonly string[], io: ImportIo): Promise<ExitCode> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw new CliError(EXIT.usage, `delorun import: ${(error as Error).message}\n${IMPORT_USAGE}`)
  }
  const [file, ...extra] = parsed.positionals
  if (file === undefined || extra.length > 0) throw new CliError(EXIT.usage, IMPORT_USAGE)
  const bytes = await readArchiveFile(file)
  const root = join(io.home, ARCHIVE_HOME_DIRECTORY)
  const ownKey = await loadHomeKey(io.home)
  const base: ArchiveImporterConfig = {
    stagingParent: join(root, 'staging'),
    store: new DirectoryWorkspaceStore(join(root, 'imported')),
    trustedPublicKeys: ownKey === undefined ? [] : [ownKey.publicKey],
  }
  const source = basename(file)
  try {
    const preview = await new ArchiveImporter(base).inspect(bytes, { source })
    io.stdout(previewLines(preview))
    let confirmation: Partial<ArchiveImporterConfig> = {}
    if (preview.reason === 'key-not-trusted') {
      const typed = await io.ask(`To import it anyway, type the key fingerprint shown above: `)
      if (typed !== preview.signer.fingerprint) throw new CliError(EXIT.failed, 'delorun import: the fingerprint was not confirmed, so nothing was imported')
      confirmation = { confirmedPublicKey: preview.signer.publicKey }
    }
    const answer = await io.ask(`Import ${String(preview.workspaces.length)} workspace${preview.workspaces.length === 1 ? '' : 's'} into this home? [y/N] `)
    if (!isYes(answer)) throw new CliError(EXIT.failed, 'delorun import: nothing was imported')
    if (preview.reason === 'absent') confirmation = { acceptUnsigned: true }
    await mkdir(root, { recursive: true, mode: 0o700 })
    const report = await new ArchiveImporter({ ...base, ...confirmation }).import(bytes, { source })
    io.stdout(`${report.label}\n${report.workspaces.map(workspace =>
      `Imported ${JSON.stringify(workspace.name)} as ${workspace.id}${workspace.id === workspace.archiveId ? '' : ` (the archive's ${workspace.archiveId} was taken)`}.`).join('\n')}\nImported chats are kept under ${join(ARCHIVE_HOME_DIRECTORY, 'imported')} in the home and stay out of every model request.\n`)
    return EXIT.ok
  } catch (error: unknown) {
    if (error instanceof ArchiveError) throw new CliError(EXIT.failed, `delorun import: the archive is refused (${error.code}): ${error.message}; nothing was imported`)
    throw error
  }
}

/**
 * Read an archive file whose size is within the total an archive may hold. The file is opened once and its size is
 * read from the open descriptor before any byte is, so a file swapped after the check is not the one read.
 * @param file - the archive's path.
 * @returns its bytes.
 * @throws {CliError} when the path is not a regular file, is larger than an archive may be, or cannot be read.
 */
async function readArchiveFile(file: string): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error: unknown) {
    throw new CliError(EXIT.failed, `delorun import: the archive cannot be read: ${(error as Error).message}`)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new CliError(EXIT.failed, `delorun import: ${file} is not a regular file`)
    if (stats.size > ARCHIVE_LIMITS.maxTotalBytes) {
      throw new CliError(EXIT.failed, `delorun import: ${file} holds ${String(stats.size)} bytes, more than an archive may hold (${String(ARCHIVE_LIMITS.maxTotalBytes)}); nothing was read`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
