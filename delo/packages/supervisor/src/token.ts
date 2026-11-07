/**
 * The per-start token as the supervisor uses it (contract C1, "Sockets and the start token"; C9, "The Docker
 * supervisor"): the token's format, its file under `run/<profile>/`, and the constant-time check every request
 * passes before anything else is read from it.
 *
 * The home process writes the token file with `@delo/home`'s `writeProtectedFile` before either channel listens,
 * and hands the same token to the supervisor over an inherited pipe ({@link ./launch.ts}). The supervisor keeps
 * the token only in memory; {@link readStartTokenFile} is for `delorun` client commands and specs, which read the
 * file when they send a request.
 *
 * @module @delo/supervisor/token
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { RUN_ENTRIES, START_TOKEN_LENGTH, type StartToken } from '@delo/contract-home-layout'
import { readProtectedFile, runDirectory } from '@delo/home'

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${String(START_TOKEN_LENGTH)}}$`)

/**
 * Validate a start token's text: 43 base64url characters without padding.
 * @param text - the candidate.
 * @returns the token, or `undefined` when the text is not one.
 */
export function parseStartToken(text: string): StartToken | undefined {
  return TOKEN_PATTERN.test(text) ? text as StartToken : undefined
}

/**
 * The start token file of one CLI profile.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/start-token`.
 */
export function startTokenFile(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.startToken)
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

  /** @param token - the current start's token, received from the home process. */
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
