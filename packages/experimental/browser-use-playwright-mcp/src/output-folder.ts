/** The server's output folder and the guards that keep a browser tool call's files inside the Session's folder. */
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { BrowserToolCall } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
/**
 * The folder, in the folder its client names as the MCP root, where Playwright's MCP server saves screenshots, PDFs and
 * snapshots when no output folder is set. The provider always sets one ({@link outputRoot}), so a new chat's folder
 * has none; a chat that already has one keeps it and nothing writes there.
 */
export const OUTPUT_FOLDER = '.playwright-mcp'

/** The folder, in the per-user cache folder, that holds one output folder for each Session. */
export const OUTPUT_ROOT_NAME = 'delorun-browser-output'

/**
 * Where the server's output folders live: a folder in the per-user cache folder, which the sandbox dialects mount
 * read-only for a confined command (or do not grant) and which lies outside the protected Delorun home, so a
 * sandboxed command can read a saved file but cannot write, remove, rename or replace the folder.
 * @param platform - the Host platform.
 * @param env - the Host environment.
 * @param home - the Host user's home folder.
 * @returns an absolute folder: `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, otherwise an absolute
 * `$XDG_CACHE_HOME` or `~/.cache`, then {@link OUTPUT_ROOT_NAME}.
 */
export function outputRoot(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  const absolute = (value: string | undefined): value is string => value !== undefined && isAbsolute(value)
  switch (platform) {
    case 'win32': return join(absolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'), OUTPUT_ROOT_NAME)
    case 'darwin': return join(home, 'Library', 'Caches', OUTPUT_ROOT_NAME)
    default: return join(absolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'), OUTPUT_ROOT_NAME)
  }
}

/**
 * The refusal of every browser tool call while the Session's {@link OUTPUT_FOLDER} is a link that leads outside the
 * Session's folder: the server saves default-named files and downloads there without a file argument.
 */
export const LINKED_OUTPUT_FOLDER_MESSAGE = `Browser saves files in "${OUTPUT_FOLDER}" in this chat's folder, and that name is a link that leads outside the folder, so no browser tool can run. Stop using browser tools for this request and tell the person to remove or replace "${OUTPUT_FOLDER}" in the chat's folder.`

/**
 * Whether a real location is the folder or inside it.
 * @param folder - the folder's real path.
 * @param real - a real location, or `undefined` when it cannot be told.
 * @returns true when inside.
 */
function inside(folder: string, real: string | undefined): boolean {
  return real !== undefined && (real === folder || real.startsWith(folder + sep))
}

/**
 * The refusal of a browser tool call whose file argument leads outside the Session's folder.
 * @param name - the argument as the model wrote it.
 * @returns the model-visible text.
 */
export function outsideFolderMessage(name: string): string {
  return `Browser only saves and reads files inside this chat's folder, and "${name}" leads outside it. Use a file name or a path inside the chat's folder.`
}

/**
 * Where a path really is: the real path of its nearest existing ancestor, followed by the part that does not exist yet.
 * @param path - an absolute path.
 * @returns the real location, or `undefined` when it cannot be told: a link whose target is missing, a link loop, or
 * a folder that cannot be read.
 */
async function realLocation(path: string): Promise<string | undefined> {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
    }
    // A link whose target does not exist yet would be created wherever it points.
    if (await lstat(current).then(stats => stats.isSymbolicLink(), () => false)) return undefined
    /* v8 ignore next -- the filesystem root always resolves, so the walk ends above */
    if (dirname(current) === current) return undefined
    missing.unshift(basename(current))
  }
}

/**
 * Refuse a tool call that would save or read a file really outside the Session's folder. Playwright's server compares
 * paths as text, so a link inside the folder would let a call write or read wherever the link points; this compares
 * real paths. A call's `filename` and `paths` are tested where the server resolves them: against the folder and against
 * the Session's output folder, which the Host owns outside the folder ({@link outputRoot}) and which the test treats as
 * inside. A call with no output folder (a caller that set none) is refused while {@link OUTPUT_FOLDER} really lies
 * outside the folder, because the server then saves default-named files and downloads there. A path that changes
 * between this test and the server's use is not covered; {@link refuseWrittenOutside} checks after the call.
 * @param call - the tool call and the folder the Session's server was told as its MCP root.
 * @returns {@link LINKED_OUTPUT_FOLDER_MESSAGE}, or {@link outsideFolderMessage} for the first name that leads
 * outside, or `undefined` when nothing does.
 */
export async function refuseOutsideFolder(call: BrowserToolCall): Promise<string | undefined> {
  const folder = await realpath(call.directory)
  if (call.outputDirectory !== undefined) return refuseWriteOutsideOutput(call, call.outputDirectory)
  if (!inside(folder, await realLocation(join(call.directory, OUTPUT_FOLDER)))) return LINKED_OUTPUT_FOLDER_MESSAGE
  if (typeof call.arguments !== 'object' || call.arguments === null) return undefined
  const { filename, paths } = call.arguments as { filename?: unknown; paths?: unknown }
  const names = [filename, ...Array.isArray(paths) ? paths as unknown[] : []].filter(name => typeof name === 'string')
  for (const name of names) {
    for (const base of [call.directory, join(call.directory, OUTPUT_FOLDER)]) {
      if (!inside(folder, await realLocation(resolve(base, name)))) return outsideFolderMessage(name)
    }
  }
  return undefined
}

/**
 * The refusal of a browser tool call that would write a file anywhere but the Session's output folder.
 * @param directory - the Session's output folder.
 * @returns the model-visible text.
 */
export function writeOutsideOutputMessage(directory: string): string {
  return `Browser saves to its own folder: ${directory}. Give a file name without a path, or a path inside that folder.`
}

/** The tools that read the file a `filename` argument names, which the other tools write. */
const FILENAME_READ_TOOLS: readonly string[] = ['browser_set_storage_state']

/**
 * The names a call asks the server to read, resolved against the Session's folder.
 * @param call - the call.
 * @returns the argument key and the names it holds, or `undefined` when the call reads no file.
 */
function readNames(call: BrowserToolCall): { key: 'paths' | 'filename'; names: string[] } | undefined {
  if (typeof call.arguments !== 'object' || call.arguments === null) return undefined
  const { filename, paths } = call.arguments as { filename?: unknown; paths?: unknown }
  if (Array.isArray(paths)) return { key: 'paths', names: (paths as unknown[]).filter(name => typeof name === 'string') }
  if (FILENAME_READ_TOOLS.includes(call.tool) && typeof filename === 'string') return { key: 'filename', names: [filename] }
  return undefined
}

/**
 * Refuse a call whose `filename` would be written outside the Session's output folder. The chat's own folder is not a
 * write base: a link the chat planted there could lead the server's write anywhere.
 * @param call - the call.
 * @param output - the Session's output folder.
 * @returns the refusal, or `undefined`.
 */
async function refuseWriteOutsideOutput(call: BrowserToolCall, output: string): Promise<string | undefined> {
  if (readNames(call)?.key === 'filename' || typeof call.arguments !== 'object' || call.arguments === null) return undefined
  const { filename } = call.arguments as { filename?: unknown }
  if (typeof filename !== 'string') return undefined
  const real = await realLocation(resolve(output, filename))
  return inside(await realpath(output), real) ? undefined : writeOutsideOutputMessage(output)
}

/**
 * The refusal of a browser tool call that reads a file the Host could not show to be inside the Session's folder.
 * @param name - the argument as the model wrote it.
 * @returns the model-visible text.
 */
export function unreadableMessage(name: string): string {
  return `Browser can only read files that are inside this chat's folder or its own output folder, and "${name}" is not one it could open there.`
}

/**
 * Copy a file the server would read, from the Session's folder or its output folder, into the output folder, so the
 * server, which runs outside the sandbox, never opens a path a confined command can swap. The Host opens the file, takes
 * its identity from the open descriptor, resolves the path again, and copies from the descriptor only when the resolved path is inside the
 * Session's folder or its output folder and names the same file.
 * @param name - the argument as the model wrote it.
 * @param call - the call.
 * @param folder - the Session's real folder.
 * @param output - the Session's output folder.
 * @returns the path of the copy the server reads, or `undefined` when the file is not inside the Session's folder or its
 * output folder, or changed during the check.
 */
async function readableCopy(name: string, call: BrowserToolCall, folder: string, output: string): Promise<string | undefined> {
  const path = resolve(call.directory, name)
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    // The file is missing or unreadable; the refusal names it.
    return undefined
  }
  try {
    const opened = await handle.stat({ bigint: true })
    const real = await realpath(path).catch(() => undefined)
    if (real === undefined || !opened.isFile()) return undefined
    const resolved = await stat(real, { bigint: true })
    if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) return undefined
    // Every file is copied, the Host's own output files too: the server never gets a path the model wrote, which can pass
    // through a link the chat controls.
    if (!inside(folder, real) && !inside(await realpath(output), real)) return undefined
    const copy = join(output, `upload-${randomUUID()}-${basename(real)}`)
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(copy, { flags: 'wx', mode: 0o600 }))
    return copy
  } finally {
    await handle.close()
  }
}

/**
 * Replace each path a call asks the server to read with a Host-made copy ({@link readableCopy}), so a link the chat
 * swaps in after the check is never followed by the server.
 * @param call - the call.
 * @returns the refusal, the replacement arguments with a note that names each original path, or `undefined` when
 * the call reads no file or has no output folder.
 */
export async function copyReadArguments(
  call: BrowserToolCall,
): Promise<string | { arguments: Record<string, unknown>; note?: string } | undefined> {
  const reads = readNames(call)
  if (call.outputDirectory === undefined || reads === undefined) return undefined
  const folder = await realpath(call.directory)
  const copies: string[] = []
  for (const name of reads.names) {
    const copy = await readableCopy(name, call, folder, call.outputDirectory).catch(() => undefined)
    if (copy === undefined) return unreadableMessage(name)
    copies.push(copy)
  }
  const originals = reads.names.map(name => resolve(call.directory, name))
  const sent = reads.names.flatMap((name, index) => copies[index] === originals[index] ? [] : [`"${name}" as "${copies[index] ?? ''}"`])
  const note = sent.length === 0
    ? undefined
    : `Delorun uploaded a copy of ${sent.join(', ')}, because Browser reads only its own copy of a file from this chat's folder.`
  return { arguments: { [reads.key]: reads.key === 'paths' ? copies : copies[0] }, ...note === undefined ? {} : { note } }
}

/** The deepest folder level of the output folder's tree that {@link refuseWrittenOutside} looks through. */
const OUTPUT_TREE_DEPTH = 6

/**
 * The refusal of a browser tool call whose file landed outside the Session's folder.
 * @param removed - whether the file was removed.
 * @returns the model-visible text.
 */
export function writtenOutsideMessage(removed: boolean): string {
  return `Browser saved a file outside this chat's folder, through a link, so the result is refused${removed ? ' and the file was removed' : ', and the file could not be removed'}. Stop using browser tools for this request and tell the person to remove the link from the chat's folder.`
}

/**
 * Remove a file the call wrote, when it is a plain file the call just created.
 * @param real - the file's real location.
 * @param startedAt - when the call was sent, in milliseconds since the epoch.
 * @returns true when the file was removed; false when it was left, because it is not a plain file, is older than the
 * call, or could not be removed. The final name is never followed.
 */
async function removeWritten(real: string, startedAt: number): Promise<boolean> {
  try {
    const stats = await lstat(real)
    if (!stats.isFile() || stats.mtimeMs < startedAt - 1000 || stats.birthtimeMs < startedAt - 1000) return false
    await unlink(real)
    return true
  } catch {
    // The file is gone or cannot be changed; the refusal says it was not removed.
    return false
  }
}

/**
 * The links inside the output folder's tree that lead outside the Session's folder. The walk lists folders and
 * reads link names; it never follows one.
 * @param roots - the real folders a link may lead to: the Session's folder and its output folder.
 * @param directory - the folder to look through.
 * @param depth - how many more levels to look through.
 * @returns the real locations the links lead to.
 */
async function outsideLinks(roots: readonly string[], directory: string, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const real = await realLocation(path)
      if (!roots.some(root => inside(root, real))) found.push(real ?? path)
    } else if (entry.isDirectory() && depth > 0) {
      found.push(...await outsideLinks(roots, path, depth - 1))
    }
  }
  return found
}

/**
 * Check, after a browser tool call, that nothing it wrote landed outside the Session's folder: the call's `filename`
 * where the server resolved it, and every folder a link inside the output folder leads to outside the folder (where
 * downloads and default-named files land). A plain file there that the call created is removed without following the
 * final name; one that cannot be removed is left and reported. This is what covers the replacement of a folder or link
 * after {@link refuseOutsideFolder}'s test, which that test cannot stop.
 * @param call - the finished call.
 * @param startedAt - when the call was sent, in milliseconds since the epoch.
 * @param log - receives one line for each refusal.
 * @returns {@link writtenOutsideMessage}, or `undefined` when nothing landed outside.
 */
export async function refuseWrittenOutside(
  call: BrowserToolCall, startedAt: number, log: (line: string) => void,
): Promise<string | undefined> {
  const folder = await realpath(call.directory)
  const output = call.outputDirectory ?? join(call.directory, OUTPUT_FOLDER)
  const roots = call.outputDirectory === undefined ? [folder] : [folder, await realpath(call.outputDirectory)]
  const landed: string[] = []
  const { filename } = (typeof call.arguments === 'object' && call.arguments !== null ? call.arguments : {}) as { filename?: unknown }
  if (typeof filename === 'string') {
    for (const base of [call.directory, output]) {
      const real = await realLocation(resolve(base, filename))
      if (real !== undefined && !roots.some(root => inside(root, real))) landed.push(real)
    }
  }
  for (const target of await outsideLinks(roots, output, OUTPUT_TREE_DEPTH)) {
    const names = await readdir(target).catch(() => [])
    landed.push(target, ...names.map(name => join(target, name)))
  }
  const found: string[] = []
  let kept = false
  for (const real of new Set(landed)) {
    const stats = await lstat(real).catch(() => undefined)
    if (stats === undefined || !stats.isFile() || stats.mtimeMs < startedAt - 1000) continue
    found.push(real)
    if (!await removeWritten(real, startedAt)) kept = true
  }
  if (found.length === 0) return undefined
  log(`${call.tool} saved a file outside the chat's folder through a link (${found.join(', ')}); the result was refused${kept ? '' : ' and the file removed'}`)
  return writtenOutsideMessage(!kept)
}
