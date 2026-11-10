/**
 * The text of a chat's session generations, and the attachments it names. A
 * generation is `session*.jsonl` or its Zstandard form `session*.jsonl.zstd`;
 * a compressed one is decompressed within a bound, so a damaged or hostile
 * file cannot exhaust memory. Upstream's attachment ids name their content as
 * `sha256:<digest>`, which is how a chat refers to an attachment it carries.
 *
 * @module @delo/trash/session-text
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isSessionGenerationFilename } from './paths.ts'

/** The largest decompressed generation read, in bytes: 1 GiB, an archive entry's limit. */
export const MAX_GENERATION_BYTES = 1024 * 1024 * 1024

/** A content digest as upstream's attachment ids name it. */
const ATTACHMENT_REFERENCE = /sha256:([0-9a-f]{64})/g

/**
 * The version of one generation file name: `session.jsonl` is 0, `session.vN.jsonl` is N.
 * @param name - a generation file name.
 * @returns its version.
 */
export function generationVersion(name: string): number {
  return Number(/^session\.v([0-9]+)\./.exec(name)?.[1] ?? 0)
}

/**
 * Read one generation file as text.
 * @param path - the file.
 * @returns its text, decompressed when its name ends in `.zstd`.
 * @throws Error when a Zstandard file is damaged or decompresses past {@link MAX_GENERATION_BYTES}.
 */
export async function readGeneration(path: string): Promise<string> {
  const bytes = await readFile(path)
  const text = path.endsWith('.zstd') ? zstdDecompressSync(bytes, { maxOutputLength: MAX_GENERATION_BYTES }) : bytes
  return new TextDecoder().decode(text)
}

/**
 * The generation files of one session directory, newest version first.
 * @param directory - the session directory.
 * @returns the file names; none when the directory does not exist.
 */
export async function generationFiles(directory: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
  return names.filter(isSessionGenerationFilename).sort((left, right) => generationVersion(right) - generationVersion(left))
}

/**
 * The attachment digests one text names.
 * @param text - a generation's text.
 * @returns each digest once.
 */
export function attachmentDigests(text: string): Set<string> {
  return new Set([...text.matchAll(ATTACHMENT_REFERENCE)].map(match => match[1]!))
}

/**
 * The attachment digests every generation of one session directory names.
 * @param directory - the session directory.
 * @returns each digest once.
 */
export async function directoryDigests(directory: string): Promise<Set<string>> {
  const found = new Set<string>()
  for (const name of await generationFiles(directory)) {
    for (const digest of attachmentDigests(await readGeneration(join(directory, name)))) found.add(digest)
  }
  return found
}

/**
 * The attachment digests every session directory two levels under a root names, `<root>/<project>/<chat>`.
 * @param root - a sessions root, or an item's `chats/`.
 * @param skip - session directories to leave out.
 * @returns each digest once.
 */
export async function treeDigests(root: string, skip: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  const found = new Set<string>()
  for (const project of await subdirectories(root)) {
    for (const chat of await subdirectories(join(root, project))) {
      const directory = join(root, project, chat)
      if (skip.has(directory)) continue
      for (const digest of await directoryDigests(directory)) found.add(digest)
    }
  }
  return found
}

/**
 * The directories directly under one directory.
 * @param directory - the directory.
 * @returns their names; none when the directory does not exist.
 */
async function subdirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}
