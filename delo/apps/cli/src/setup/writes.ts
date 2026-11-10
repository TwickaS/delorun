/**
 * The two stores a setup step writes: the model key in upstream's credentials document under the home, and the
 * per-profile `cordis.patch.yml` layer. Both merge into what is there, so a row or ref that setup does not own
 * stays as the person left it.
 *
 * @module @delo/cli/setup/writes
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parse, parseDocument, stringify } from 'yaml'
import { CliError, EXIT } from '../exit.ts'

/** Upstream's credentials document under the home (contract C1). */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The layout version upstream's credentials reader accepts. */
const CREDENTIALS_VERSION = 1

/**
 * Store a model key under a credential reference in upstream's credentials document, at mode 0600. The value is
 * written only to that file and never reaches an error message.
 * @param home - the Delo home, which is upstream's `DSH_HOME`.
 * @param name - the reference name, the environment variable the provider reads.
 * @param value - the key.
 * @throws {CliError} `EXIT.failed` when the existing document is not one upstream reads.
 */
export function storeCredential(home: string, name: string, value: string): void {
  const path = join(home, CREDENTIALS_FILENAME)
  const temporary = `${path}.tmp`
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
  writeFileSync(temporary, document.toString(), { mode: 0o600 })
  renameSync(temporary, path)
}

/** One row of a profile patch: an upstream row's id and the config keys setup sets on it. */
export interface PatchRow {
  /** The row's entry id. */
  readonly id: string
  /** The config keys to set; other keys already on the row stay. */
  readonly config: Readonly<Record<string, boolean | number | string>>
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
