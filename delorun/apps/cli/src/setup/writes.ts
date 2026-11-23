/**
 * The model key setup stores in upstream's credentials document under the home. The write merges into what is there,
 * so a ref that setup does not own stays as the person left it. The per-profile `cordis.patch.yml` layer is
 * `@delorun/setup-apply`'s.
 *
 * @module @delorun/cli/setup/writes
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { writeProtectedFile } from '@delorun/home'
import { Document, parseDocument } from 'yaml'
import { CliError, EXIT } from '../exit.ts'

/** Upstream's credentials document under the home (contract C1). */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The layout version upstream's credentials reader accepts. */
const CREDENTIALS_VERSION = 1

/**
 * Store a model key under a credential reference in upstream's credentials document, at mode 0600. The document is
 * read and replaced while holding upstream's writer lock for it (`withFileLock`, the lock the Host's credentials
 * provider takes), so a concurrent writer's change is not lost. The replacement goes through the protected-file
 * writer: a temporary file with a random name, created exclusively at 0600 without following a symbolic link, flushed,
 * renamed over the document, and the directory flushed. A stale or planted sibling file therefore never receives the
 * key, and a crash before the rename leaves the document as it was. The value is written only to that file and never
 * reaches an error message.
 * @param home - the Delorun home, which is upstream's `DSH_HOME`; it must exist.
 * @param name - the reference name, the environment variable the provider reads.
 * @param value - the key.
 * @returns when the document is replaced.
 * @throws {CliError} `EXIT.failed` when the existing document is not one upstream reads; it is left unchanged.
 */
export async function storeCredential(home: string, name: string, value: string): Promise<void> {
  const path = join(home, CREDENTIALS_FILENAME)
  await withFileLock(path, async () => {
    let document: Document
    if (existsSync(path)) {
      document = parseDocument(readFileSync(path, 'utf8'))
      if (document.errors.length > 0 || !document.has('version')) {
        throw new CliError(EXIT.failed, `delorun setup: ${path} is not a credentials document upstream reads; it was not changed`)
      }
    } else {
      document = new Document({ version: CREDENTIALS_VERSION, refs: {} })
    }
    document.setIn(['refs', name], value)
    await writeProtectedFile(path, document.toString())
  })
}

/**
 * Whether upstream's credentials document holds a non-empty value under a reference. The value is never returned.
 * @param home - the Delorun home.
 * @param name - the reference name.
 * @returns true when the reference holds a key; false when the document is absent, unreadable or has none.
 */
export function hasStoredCredential(home: string, name: string): boolean {
  const path = join(home, CREDENTIALS_FILENAME)
  if (!existsSync(path)) return false
  const document = parseDocument(readFileSync(path, 'utf8'))
  if (document.errors.length > 0) return false
  const value: unknown = document.getIn(['refs', name])
  return typeof value === 'string' && value !== ''
}
