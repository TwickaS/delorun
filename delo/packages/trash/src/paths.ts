/**
 * The storage locations that contract C8's purge reaches. Every helper derives
 * the same path the owning store writes, so a purge removes exactly what the
 * store holds and nothing beside it.
 *
 * @module @delo/trash/paths
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings, exactly as `packages/session/session-persistence-jsonl`'s
 * format module does for a Session id: literal `[A-Za-z0-9._-]` (minus `~`),
 * every other code unit as `~XXXX`, and the whole-segment tokens `.`/`..`
 * escaped, so a session id cannot traverse or collide.
 * @param raw - the unvalidated id to encode.
 * @returns one injective filesystem-safe path segment.
 */
/* jscpd:ignore-start -- the derivation is the storage format; the owning
   package's module graph reaches built artifacts this fork lane does not build,
   so the pure encoding is mirrored here under its own name. */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * Build the readable project directory key for a session's cwd, exactly as the
 * JSONL session-persistence backend derives it: separators collapse to `-`,
 * unsafe code units escape as `~XXXX`, and the bounded slug is wrapped in
 * `--…--`.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}
/* jscpd:ignore-end */

/**
 * The directory one chat's session generations live in under the JSONL
 * backend's root: `<root>/<projectKey(cwd)>/<encodeSegment(id)>`. C8's purge
 * removes this directory with every generation in it.
 * @param sessionsRoot - the JSONL session-persistence root.
 * @param cwd - the session's project directory, as its header carries it.
 * @param sessionId - the session id.
 * @returns the session directory's absolute path.
 */
export function sessionDirectoryPath(sessionsRoot: string, cwd: string | undefined, sessionId: string): string {
  return cwd === undefined
    ? join(sessionsRoot, '_no-cwd', encodeSegment(sessionId))
    : join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId))
}

/**
 * Whether one entry name of a session directory is a committed generation
 * file, exactly as `sessionFormatLogFilename` writes it: version zero keeps
 * the original `session.jsonl`, every later generation carries a lowercase
 * numeric `.vN` component, and the physical encoding appends `.zstd`.
 * @param name - one entry name.
 * @returns whether the name identifies a `session*.jsonl(.zstd)` generation.
 */
export function isSessionGenerationFilename(name: string): boolean {
  return /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(name)
}

/**
 * The spill storage's session directory, exactly as `dsh-spill-local` derives
 * it: `session-` plus the first 12 lowercase hex characters of the SHA-256 of
 * the session id. C8's purge removes this directory with every spill file of
 * the chat in it.
 * @param spillRoot - the spill storage root.
 * @param sessionId - the owning session id.
 * @returns the session-scoped spill directory's absolute path.
 */
export function spillSessionDirectoryPath(spillRoot: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(spillRoot, `session-${hash}`)
}

/**
 * One attachment object's content-addressed path under a versioned attachment
 * root, as `dsh-attachment-local` publishes it: `objects/<first digest byte
 * pair>/<sha256>`.
 * @param attachmentsRoot - the versioned attachment root, `<home>/attachments/v1`.
 * @param sha256 - the lowercase hexadecimal digest of the object's bytes.
 * @returns the object's absolute path.
 */
export function attachmentObjectPath(attachmentsRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`attachment digest is not a lowercase sha256: ${sha256}`)
  return join(attachmentsRoot, 'objects', sha256.slice(0, 2), sha256)
}

/**
 * Every path the local attachment store keeps one attachment under: the image
 * object `objects/<xx>/<sha256>`, the file object `file-objects/<xx>/<sha256>`
 * and the file's alias directory `files/<xx>/<sha256>`, as
 * `dsh-attachment-local` publishes them.
 * @param attachmentsRoot - the versioned attachment root, `<home>/attachments/v1`.
 * @param sha256 - the lowercase hexadecimal digest of the attachment's bytes.
 * @returns the three paths.
 */
export function attachmentPaths(attachmentsRoot: string, sha256: string): string[] {
  const object = attachmentObjectPath(attachmentsRoot, sha256)
  const prefix = sha256.slice(0, 2)
  return [object, join(attachmentsRoot, 'file-objects', prefix, sha256), join(attachmentsRoot, 'files', prefix, sha256)]
}
