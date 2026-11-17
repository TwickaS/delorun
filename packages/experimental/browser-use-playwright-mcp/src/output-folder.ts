/** The server's output folder and the guard that keeps a browser tool call's files inside the Session's folder. */
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { BrowserToolCall } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

/** The folder, in the folder its client names as the MCP root, that Playwright's MCP server saves screenshots, PDFs and snapshots to. */
export const OUTPUT_FOLDER = '.playwright-mcp'

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
 * real paths. Every call is refused while the {@link OUTPUT_FOLDER} really lies outside the folder, because the server
 * saves default-named files and downloads there whatever the call's arguments. A call's `filename` and `paths` are
 * tested where the server resolves them: against the folder and against its {@link OUTPUT_FOLDER}. A path that
 * changes between this test and the server's use, a download that lands between calls included, is not covered.
 * @param call - the tool call and the folder the Session's server was told as its MCP root.
 * @returns {@link LINKED_OUTPUT_FOLDER_MESSAGE}, or {@link outsideFolderMessage} for the first name that leads
 * outside, or `undefined` when nothing does.
 */
export async function refuseOutsideFolder(call: BrowserToolCall): Promise<string | undefined> {
  const folder = await realpath(call.directory)
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
