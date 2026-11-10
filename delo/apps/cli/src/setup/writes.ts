/**
 * The two stores a setup step writes: the model key in upstream's credentials document under the home, and the
 * per-profile `cordis.patch.yml` layer. Both merge into what is there, so a row or ref that setup does not own
 * stays as the person left it.
 *
 * @module @delo/cli/setup/writes
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { writeProtectedFile } from '@delo/home'
import { Document, parse, parseDocument, stringify } from 'yaml'
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
 * @param home - the Delo home, which is upstream's `DSH_HOME`; it must exist.
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

/** One scalar value of a patch row's config. */
export type PatchValue = boolean | number | string

/** One row of a profile patch: an upstream row's id and the config keys setup sets on it. */
export interface PatchRow {
  /** The row's entry id. */
  readonly id: string
  /** The config keys to set; other keys already on the row stay. A nested record replaces that key's whole value. */
  readonly config: Readonly<Record<string, PatchValue | Readonly<Record<string, PatchValue>>>>
}

/**
 * @param value - a parsed YAML value.
 * @returns whether it is a mapping.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Merge one row into a profile's patch list, creating the file when it is absent. The file is rewritten as a
 * YAML list: setup owns the rows it sets, and a row it does not name keeps its values. Comments in the file do
 * not survive the rewrite.
 * @param path - the profile's `cordis.patch.yml`.
 * @param row - the row to set.
 * @throws {CliError} `EXIT.failed` when the file is not a YAML patch list; it is left unchanged.
 */
export function setPatchRow(path: string, row: PatchRow): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  let list: unknown
  try {
    list = parse(text) ?? []
  } catch {
    // parse rejects a document whose text is not YAML or uses a tag setup does not read; the file is left unchanged.
    throw new CliError(EXIT.failed, `delorun setup: ${path} is not a YAML patch list setup can read; it was not changed`)
  }
  if (!Array.isArray(list)) throw new CliError(EXIT.failed, `delorun setup: ${path} is not a patch list; it was not changed`)
  const rows: unknown[] = list
  const existing = rows.find(entry => isRecord(entry) && entry['id'] === row.id)
  if (isRecord(existing)) {
    const config = isRecord(existing['config']) ? existing['config'] : {}
    existing['config'] = { ...config, ...row.config }
  } else {
    rows.push({ id: row.id, config: { ...row.config } })
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, stringify(rows), { mode: 0o600 })
  renameSync(temporary, path)
}
