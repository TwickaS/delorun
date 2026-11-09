/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, and the exclusive owner-only write.
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Prefix shared by default-root creation and startup discovery, for the temp
 * root a home that cannot host its own spill directory falls back to.
 */
export const DEFAULT_ROOT_PREFIX = 'dsh-spill-'

/** Name of the default spill root inside the Harness home: `<home>/spill`. */
export const DEFAULT_ROOT_DIR_NAME = 'spill'

/**
 * Test a caught value for a Node system error code.
 *
 * @param error The caught value.
 * @param code The expected system error code.
 * @returns Whether the code matches.
 */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

/** The private root of each home this process has resolved, keyed by that home. */
const privateRoots = new Map<string, string>()

/**
 * Create the private spill root of one home: `<home>/spill` at mode 0700, or —
 * when the home cannot host it — a private `dsh-spill-*` directory under the OS
 * temp dir.
 *
 * @param home The Harness home that owns the root.
 * @returns The absolute root path.
 */
function createPrivateRoot(home: string): string {
  const preferred = join(home, DEFAULT_ROOT_DIR_NAME)
  try {
    mkdirSync(preferred, { recursive: true, mode: 0o700 })
    return preferred
  } catch {
    // A read-only home, or a home path a file occupies, cannot hold the spill
    // directory; the temp root keeps spilling working. It sits outside the home
    // that `home-read` covers, so a deployment that protects the home must
    // protect these `dsh-spill-*` roots too.
    return mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX))
  }
}

/**
 * Return the lazily-created private per-home spill root: `<home>/spill` at mode
 * 0700. Keeping the default inside the home is what lets a deployment's
 * protected home — the set confined commands can neither read nor write — cover
 * spilled tool output, which the OS temp dir, granted to every confined command,
 * shared across every home on the machine.
 *
 * @param home The Harness home that owns the root; defaults to `$DSH_HOME`.
 * @returns The private root path, one per home for this process's lifetime.
 */
export function privateRoot(home: string = resolveDshHome()): string {
  const cached = privateRoots.get(home)
  if (cached !== undefined) return cached
  const created = createPrivateRoot(home)
  privateRoots.set(home, created)
  return created
}

// Spill keeps its empty-name policy local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 *
 * @param raw Untrusted text.
 * @returns One injective filesystem-safe path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
/* jscpd:ignore-end */

/**
 * Derive the stable session-scoped directory under a spill root.
 *
 * @param root The spill root.
 * @param sessionId The owning session id.
 * @returns The stable session-scoped directory.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Inputs needed to save a local spill file. */
export interface SaveTextOptions {
  /** Spill root. */
  root: string
  /** Owning session id. */
  sessionId: string
  /** Caller-suggested filename. */
  suggestedName: string
  /** Full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  /** Absolute saved path. */
  path: string
  /** UTF-8 content length. */
  bytes: number
}

/**
 * Write text to a fresh 0600 file below its private session directory.
 * @param options The save request.
 * @returns The saved path and UTF-8 byte length.
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${encodeSegment(options.suggestedName)}`)
  let handle
  for (;;) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      handle = await open(path, 'wx', 0o600)
      break
    } catch (error: unknown) {
      /* v8 ignore start -- requires another process to remove the directory
         between mkdir and open, or an external permission/IO race. */
      if (isErrno(error, 'ENOENT')) continue
      throw error
      /* v8 ignore stop */
    }
  }
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes: Buffer.byteLength(options.content, 'utf8') }
}
