/**
 * `delorun export <chat-or-workspace> --out <file>` (contract C8): write one
 * chat, or one workspace with its chats, as a signed archive. A chat is read
 * from its newest session generation under the home's `sessions/`; a workspace
 * from the workspace registry's record under `storages/workspace.json`, with
 * each of its chats that has a session directory. An attachment a chat names
 * by its content digest is carried when the home's attachment store holds it.
 * The archive is signed with the home key, which the home gets on first use.
 * The export reads the stores while this process holds the home lock of every
 * profile, so no home process writes a chat while it is read, and it is
 * refused while a home process runs.
 *
 * Before anything is written, the export scans the chat history for secrets.
 * When it finds one it names each finding by kind and chat, never by value,
 * and writes the file only after the person confirms; without a terminal the
 * answer is no. The file is created new at mode 0600 and never replaces an
 * existing file.
 *
 * @module @delorun/cli/export
 */
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION } from '@delorun/contract-archive-and-trash'
import { exportArchive, loadHomeKey, signManifest, type ArchiveExportInput, type ExportWorkspace, type SecretFinding } from '@delorun/archive'
import { attachmentDigests, attachmentPaths, encodeSegment, generationFiles, readGeneration } from '@delorun/trash'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseFailure } from '../command.ts'
import { quoted } from '../terminal-text.ts'
import { isYes } from '../trash/terminal.ts'

/** The usage line. */
export const EXPORT_USAGE = 'Usage: delorun export <chat-or-workspace-id> --out <file> [--profile <name>]'

/** What `delorun export` runs with. */
export interface ExportIo {
  /** The Delorun home. */
  readonly home: string
  /** The Delorun version that writes the archive. */
  readonly version: string
  /** Write to standard output. */
  readonly stdout: (text: string) => void
  /** Ask one question; the empty string when no terminal can ask. */
  readonly ask: (question: string) => Promise<string>
  /** Run the export while this process holds every profile's home lock; refuses while a home process runs. */
  readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>
}

/** The registry's record of one workspace, as `storages/workspace.json` holds it. */
const WorkspaceRecord = z.object({ path: z.string(), title: z.string(), sessionIds: z.array(z.string()) })

/** The part of the workspace registry's storage document the export reads. */
const WorkspaceDocument = z.object({ tables: z.object({ workspaces: z.record(z.string(), WorkspaceRecord) }) })

/**
 * Whether a path is a directory, without following a link.
 * @param path - the path.
 * @returns true for a real directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error: unknown) {
    // ENOENT: nothing is there; ENOTDIR: a file stands where a directory would be. Either way it is no directory.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * Find one chat's session directory under the sessions root.
 * @param sessionsRoot - the home's `sessions/`.
 * @param sessionId - the chat.
 * @returns the directory, or `undefined` when no project holds the chat.
 */
export async function findChatDirectory(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  if (!await isDirectory(sessionsRoot)) return undefined
  const encoded = encodeSegment(sessionId)
  for (const project of await readdir(sessionsRoot)) {
    const candidate = join(sessionsRoot, project, encoded)
    if (await isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * Read one chat's newest session generation as text, decompressing a Zstandard generation within the archive's
 * per-entry limit.
 * @param directory - the chat's session directory.
 * @returns the generation's text, or `undefined` when the directory holds none.
 * @throws {CliError} when a Zstandard generation is damaged or larger than one archive entry may be.
 */
export async function readChatText(directory: string): Promise<string | undefined> {
  const newest = (await generationFiles(directory))[0]
  if (newest === undefined) return undefined
  try {
    return await readGeneration(join(directory, newest))
  } catch (error: unknown) {
    throw new CliError(EXIT.failed, `delorun export: the chat in ${basename(directory)} cannot be read: ${(error as Error).message}`)
  }
}

/**
 * Read the attachments one chat's text names by digest, from the home's attachment store: the image object, or else
 * the file object, of each digest.
 * @param home - the Delorun home.
 * @param text - the chat's text.
 * @returns the bytes of every named attachment the store holds as a regular file.
 */
async function readAttachments(home: string, text: string): Promise<Uint8Array[]> {
  const root = join(home, 'attachments', 'v1')
  const found: Uint8Array[] = []
  for (const digest of attachmentDigests(text)) {
    for (const path of attachmentPaths(root, digest).slice(0, 2)) {
      const stats = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (stats?.isFile() !== true) continue
      found.push(await readFile(path))
      break
    }
  }
  return found
}

/**
 * The workspace registry's record of one workspace.
 * @param home - the Delorun home.
 * @param workspaceId - the workspace.
 * @returns the record, or `undefined` when the registry holds no such workspace.
 * @throws {CliError} when the registry's document is not one the export reads.
 */
async function workspaceRecord(home: string, workspaceId: string): Promise<z.infer<typeof WorkspaceRecord> | undefined> {
  let raw: string
  try {
    raw = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed
  try {
    parsed = WorkspaceDocument.safeParse(JSON.parse(raw))
  } catch (error: unknown) {
    throw new CliError(EXIT.failed, `delorun export: the workspace registry's document is not JSON (${(error as Error).message})`)
  }
  if (!parsed.success) throw new CliError(EXIT.failed, 'delorun export: the workspace registry\'s document is not one this version reads')
  return Object.hasOwn(parsed.data.tables.workspaces, workspaceId) ? parsed.data.tables.workspaces[workspaceId] : undefined
}

/**
 * The workspace an export carries for one chat or one workspace id.
 * @param home - the Delorun home.
 * @param target - the chat's or the workspace's id.
 * @returns the workspace to export.
 * @throws {CliError} when neither a workspace nor a chat carries the id.
 */
export async function exportTarget(home: string, target: string): Promise<ExportWorkspace> {
  const sessionsRoot = join(home, 'sessions')
  const record = await workspaceRecord(home, target)
  const ids = record === undefined ? [target] : record.sessionIds
  const chats: ExportWorkspace['chats'][number][] = []
  const attachments: Uint8Array[] = []
  for (const sessionId of ids) {
    const directory = await findChatDirectory(sessionsRoot, sessionId)
    const text = directory === undefined ? undefined : await readChatText(directory)
    if (text === undefined) continue
    chats.push({ id: sessionId, text })
    attachments.push(...await readAttachments(home, text))
  }
  if (record === undefined && chats.length === 0) throw new CliError(EXIT.failed, `delorun export: no chat or workspace carries the id ${JSON.stringify(target)}`)
  const entity = record === undefined ? { kind: 'chat', sessionId: target } : { kind: 'workspace', title: record.title, path: record.path }
  return {
    id: target,
    name: record?.title ?? target,
    entity: new TextEncoder().encode(JSON.stringify(entity)),
    chats,
    attachments,
  }
}

/**
 * The findings of a secret scan, one line each.
 * @param findings - the findings.
 * @returns the lines.
 */
function findingLines(findings: readonly SecretFinding[]): string {
  return findings.map(finding => `  ${finding.kind} in chat ${finding.chatId}`).join('\n')
}

/**
 * Write a new file at mode 0600, refusing an existing one.
 * @param path - the file.
 * @param bytes - its contents.
 * @throws {CliError} when the file exists.
 */
async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(EXIT.failed, `delorun export: ${path} exists; choose another --out file`)
    throw error
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Run `delorun export`.
 * @param args - the arguments after `export`, without `--profile`.
 * @param io - the home, the version, the output and the question.
 * @returns the exit code.
 * @throws {CliError} for a wrong command line, an unknown id, a declined secret warning or an existing file.
 */
export async function runExport(args: readonly string[], io: ExportIo): Promise<ExitCode> {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { out: { type: 'string' } }, strict: true, allowPositionals: true })
  } catch (error: unknown) {
    throw parseFailure('export', error)
  }
  const [target, ...extra] = parsed.positionals
  const out = parsed.values.out
  if (target === undefined || extra.length > 0 || out === undefined || out.length === 0) throw new CliError(EXIT.usage, EXPORT_USAGE)
  return io.exclusive(() => writeExport(target, out, io))
}

/**
 * Read one chat or workspace, ask about any secret it holds, and write it as a signed archive.
 * @param target - the chat's or the workspace's id.
 * @param out - the archive file to create.
 * @param io - the home, the version, the output and the question.
 * @returns the exit code.
 * @throws {CliError} for an unknown id, a declined secret warning or an existing file.
 */
async function writeExport(target: string, out: string, io: ExportIo): Promise<ExitCode> {
  const workspace = await exportTarget(io.home, target)
  const key = (await loadHomeKey(io.home, { create: true }))!
  const input: ArchiveExportInput = {
    createdBy: io.version,
    origin: { homeKeyId: key.keyId, publicKey: key.publicKey },
    workspaces: [workspace],
    customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] },
    sign: manifestBytes => signManifest(manifestBytes, key.keyId, key.privateKey),
  }
  let result = exportArchive(input)
  if (result.cancelled) {
    io.stdout(`The chat history holds what looks like ${String(result.warnings.length)} secret${result.warnings.length === 1 ? '' : 's'}:\n${findingLines(result.warnings)}\n`)
    const answer = await io.ask('Include them in the archive? Anyone with the file can read them. [y/N] ')
    if (!isYes(answer)) throw new CliError(EXIT.failed, 'delorun export: nothing was written')
    result = exportArchive({ ...input, confirmSecrets: true })
  }
  await writeNewFile(out, result.bytes!)
  io.stdout(`Wrote ${quoted(basename(out))}: ${quoted(workspace.name)}, ${String(workspace.chats.length)} chat${workspace.chats.length === 1 ? '' : 's'}, ${String(workspace.attachments.length)} attachment${workspace.attachments.length === 1 ? '' : 's'}, signed by this home's key ${key.keyId}.\n`)
  return EXIT.ok
}
