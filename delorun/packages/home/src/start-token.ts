/**
 * The per-start token (contract C1, "Sockets and the start token"): its format, its file under `run/<profile>/`,
 * the writing of a new one at each home-process start, its removal at a clean stop, and the constant-time check
 * every request on the update channel and the supervisor's socket passes before anything else is read from it.
 *
 * The home process writes the token file before either channel listens and keeps the token in memory; the
 * supervisor receives it over an inherited pipe. `delorun` client commands read the file with
 * {@link readStartTokenFile} when they send a request.
 *
 * @module @delorun/home/start-token
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RUN_ENTRIES, START_TOKEN_BYTES, START_TOKEN_LENGTH, type StartToken } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from './protected-file.ts'
import { runDirectory } from './tree.ts'

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${String(START_TOKEN_LENGTH)}}$`)

/**
 * Validate a start token's text: 43 base64url characters without padding.
 * @param text - the candidate.
 * @returns the token, or `undefined` when the text is not one.
 */
export function parseStartToken(text: string): StartToken | undefined {
  return TOKEN_PATTERN.test(text) ? brandString<StartToken>(text) : undefined
}

/**
 * The start token file of one CLI profile.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/start-token`.
 */
export function startTokenFile(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.startToken)
}

/**
 * Create a new start token: 32 bytes from the operating system's cryptographic random source, as base64url.
 * @returns the token.
 */
export function newStartToken(): StartToken {
  return brandString<StartToken>(randomBytes(START_TOKEN_BYTES).toString('base64url'))
}

/**
 * Write a new start token to the profile's token file, replacing the previous start's atomically at mode 0600.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the new token, which the caller keeps only in memory.
 */
export async function writeNewStartToken(home: string, profile: string): Promise<StartToken> {
  const token = newStartToken()
  await writeProtectedFile(startTokenFile(home, profile), `${token}\n`)
  return token
}

/**
 * Read the start token file through C1's protected-file check. The file holds the token and one newline.
 * @param path - the token file, from {@link startTokenFile}.
 * @returns the token.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` for a laxer, linked or foreign file.
 * @throws {Error} when the file does not hold one token and one newline; the message never quotes the content.
 */
export async function readStartTokenFile(path: string): Promise<StartToken> {
  const text = (await readProtectedFile(path)).toString('utf8')
  const token = text.endsWith('\n') ? parseStartToken(text.slice(0, -1)) : undefined
  if (token === undefined) throw new Error(`${path} does not hold one start token followed by one newline`)
  return token
}

/**
 * Remove the token file when it still holds this start's token, synchronously, so a process `exit` listener can
 * call it. A file a newer start has written is left in place.
 * @param path - the token file.
 * @param token - this start's token.
 */
export function removeStartTokenFile(path: string, token: StartToken): void {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  } catch (error) {
    // ENOENT: nothing to remove. ELOOP: a link is not a token file this process wrote, so it is left alone.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return
    throw error
  }
  let held: boolean
  try {
    const buffer = Buffer.alloc(START_TOKEN_LENGTH + 1)
    held = fstatSync(fd).isFile() && readSync(fd, buffer, 0, buffer.length, 0) === buffer.length && new StartTokenCheck(token).accepts(buffer.toString('utf8', 0, START_TOKEN_LENGTH))
  } finally {
    closeSync(fd)
  }
  if (!held) return
  try {
    unlinkSync(path)
  } catch (error) {
    // ENOENT: another remover was first.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * The digest a token is compared by: comparing fixed-length digests keeps the comparison's time independent of
 * where, and whether, the lengths differ.
 * @param text - a token or a candidate.
 * @returns its SHA-256 digest.
 */
function digestOf(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** Accepts only the current home-process start's token, compared in constant time. */
export class StartTokenCheck {
  private readonly digest: Buffer

  /** @param token - the current start's token. */
  constructor(token: StartToken) {
    this.digest = digestOf(token)
  }

  /**
   * Whether a request's `token` field is the current start's token. A missing, non-string, wrong or previous
   * start's token is refused alike.
   * @param candidate - the field's value as parsed from the request line.
   * @returns true only for the current token.
   */
  accepts(candidate: unknown): boolean {
    return timingSafeEqual(this.digest, digestOf(typeof candidate === 'string' ? candidate : ''))
  }
}
