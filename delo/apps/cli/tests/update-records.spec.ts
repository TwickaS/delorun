/**
 * `c03-previous-release-reads-delorun-records`: every versioned record Delo keeps under the home is listed in
 * `DELO_RECORDS` at the version its owner writes, so a release that changes one names a data change and the update
 * takes a copy; and the update record a release writes is read back by the reader the same release ships, which is
 * what the previous release runs at its next start.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { STORE_LAYOUT, type RuntimeVersion } from '@delo/contract-home-layout'
import { UPDATE_REPORT_SCHEMA } from '@delo/contract-update-report'
import { readJournal, writeJournal } from '@delo/home-process'
import { SAFE_MODE_SCHEMA, SAFETY_RECORD_SCHEMA } from '@delo/profile-safety'
import { COPY_RECORD_SCHEMA, DELO_RECORDS, RESTORE_JOURNAL_SCHEMA } from '@delo/update'

/**
 * The version a `delo.<name>/<n>` schema names.
 * @param schema - the schema value.
 * @returns `n`.
 */
function versionOf(schema: string): number {
  return Number(schema.split('/').at(-1))
}

/** The Delo source trees whose records live under the home. */
const SOURCE_ROOTS = [join(import.meta.dirname, '../../../packages'), join(import.meta.dirname, '../src')]

/**
 * The text of every `.ts` file under a directory, leaving out `node_modules`, `tests` and build output.
 * @param directory - a packages directory or a source directory.
 * @returns the files' text.
 */
function sources(directory: string): string[] {
  const texts: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'lib', 'dist'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) texts.push(...sources(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) texts.push(readFileSync(path, 'utf8'))
  }
  return texts
}

/**
 * The versioned Delo records the sources declare: each `defineDomain` storage domain, each `*_SCHEMA_VERSION`
 * constant, and each `'delo.<name>/<n>'` schema of a record kept under the home.
 * @returns the declarations found, as `storage:<name>` or the constant or schema text, with their versions.
 */
function declaredRecords(): Map<string, number> {
  const found = new Map<string, number>()
  for (const text of SOURCE_ROOTS.flatMap(sources)) {
    for (const match of text.matchAll(/defineDomain\(\{\s*name: '([a-z_]+)',\s*version: (\d+)/gu)) found.set(`storage:${match[1]!}`, Number(match[2]))
    for (const match of text.matchAll(/export const ([A-Z_]+_SCHEMA_VERSION) = (\d+)/gu)) found.set(match[1]!, Number(match[2]))
    for (const match of text.matchAll(/'delo\.([a-z-]+)\/(\d+)'/gu)) found.set(`delo.${match[1]!}`, Number(match[2]))
  }
  return found
}

/**
 * Each declaration the sources hold, mapped to its `DELO_RECORDS` name, or to `null` with the reason it is no record
 * a previous release reads from the home. A new declaration fails the spec until it is listed here.
 */
const DECLARATIONS: Readonly<Record<string, string | null>> = {
  'storage:delo_workspaces': 'storage:delo_workspaces',
  TRASH_ITEM_SCHEMA_VERSION: 'trash-item',
  'delo.profile-safety': 'profile-safety',
  'delo.safe-mode': 'safe-mode',
  'delo.update-report': 'update-report',
  'delo.session-data-copy': 'session-data-copy',
  'delo.data-restore': 'data-restore-journal',
  // Documents a person exports, passes in or reads; no release reads them back from the home's data.
  ARCHIVE_CUSTOMISATION_SCHEMA_VERSION: null,
  SETUP_ANSWERS_SCHEMA_VERSION: null,
  VERIFICATION_REPORT_SCHEMA_VERSION: null,
  // A release's own signed file, read from the runtime closure, never from the home's data.
  'delo.data-formats': null,
  // Signed release and catalogue metadata: each is verified against its signature and refetched, never chat data.
  'delo.catalogue-index': null,
  'delo.catalogue-revocations': null,
  'delo.release-files': null,
  'delo.release-log-bundle': null,
  'delo.release-manifest': null,
  'delo.release-rebuild': null,
  'delo.release-root': null,
  'delo.release-timestamp': null,
  // Verification state under trust/, replaced by every install and never part of a session-data copy.
  'delo.release-log-checkpoint': null,
  'delo.release-log-state': null,
}

describe('c03-previous-release-reads-delorun-records', () => {
  it('maps every versioned record the sources declare, at the version DELO_RECORDS lists', () => {
    const declared = declaredRecords()
    for (const [declaration, version] of declared) {
      expect(Object.hasOwn(DECLARATIONS, declaration), `${declaration} is declared in the sources and not mapped in this spec`).toBe(true)
      const name = DECLARATIONS[declaration]
      if (name !== null && name !== undefined) expect(DELO_RECORDS[name], declaration).toBe(version)
    }
  })

  it('lists every record at the version its owner writes, and no other record', () => {
    const written: Record<string, number> = {
      'update-record': 1,
      'store-layout': STORE_LAYOUT,
      'profile-safety': versionOf(SAFETY_RECORD_SCHEMA),
      'safe-mode': versionOf(SAFE_MODE_SCHEMA),
      'update-report': versionOf(UPDATE_REPORT_SCHEMA),
      'session-data-copy': versionOf(COPY_RECORD_SCHEMA),
      'data-restore-journal': versionOf(RESTORE_JOURNAL_SCHEMA),
      'storage:delo_workspaces': 1,
      'trash-item': 1,
    }
    expect(DELO_RECORDS).toEqual(written)
  })

  it('reads back the update record it writes, at the listed version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delo-records-'))
    try {
      const path = join(home, 'update.json')
      const version = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
      await writeJournal(path, { from: version('1.0.0'), to: version('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: true, targetStarted: true }, 'committed')
      expect((JSON.parse(readFileSync(path, 'utf8')) as { readonly v: number }).v).toBe(DELO_RECORDS['update-record'])
      expect(await readJournal(path)).toMatchObject({ from: '1.0.0', to: '1.1.0', phase: 'committed', dataDiffers: true, copy: true, targetStarted: true })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
