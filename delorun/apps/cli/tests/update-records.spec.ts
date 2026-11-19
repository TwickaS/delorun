/**
 * `c03-previous-release-reads-delorun-records`: every versioned record Delorun keeps under the home is listed in
 * `DELORUN_RECORDS` at the version its owner writes, so a release that changes one names a data change and the update
 * takes a copy; and the update record a release writes is read back by the reader the same release ships, which is
 * what the previous release runs at its next start.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { STORE_LAYOUT, type RuntimeVersion } from '@delorun/contract-home-layout'
import { UPDATE_REPORT_SCHEMA } from '@delorun/contract-update-report'
import { readJournal, writeJournal } from '@delorun/home-process'
import { SAFE_MODE_SCHEMA, SAFETY_RECORD_SCHEMA } from '@delorun/profile-safety'
import { COPY_RECORD_SCHEMA, DELORUN_RECORDS, RESTORE_JOURNAL_SCHEMA } from '@delorun/update'
import { z } from 'zod'

/**
 * rc.3's update journal schema, copied from `packages/home-process/src/journal.ts` as rc.3 shipped it. An earlier release
 * parses the journal with it and rejects any unknown key, so the current journal must pass it.
 */
const RC3_JOURNAL_SCHEMA = z.strictObject({
  v: z.literal(1),
  from: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u),
  to: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u),
  previous: z.string().optional(),
  phase: z.enum(['checking', 'installing', 'reporting', 'snapshot', 'waiting', 'switching', 'health-check', 'committed', 'rolling-back']),
  startedAt: z.string().datetime(),
  dataDiffers: z.boolean(),
  copy: z.boolean(),
  targetStarted: z.boolean(),
  snapshot: z.string().min(1).optional(),
  refused: z.literal(true).optional(),
  health: z.strictObject({
    disabledPlugins: z.array(z.string()),
    namedRows: z.array(z.string()),
    bundles: z.array(z.string()).optional(),
  }).optional(),
})

/**
 * The version a `delorun.<name>/<n>` schema names.
 * @param schema - the schema value.
 * @returns `n`.
 */
function versionOf(schema: string): number {
  return Number(schema.split('/').at(-1))
}

/** The Delorun source trees whose records live under the home. */
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
 * The versioned Delorun records the sources declare: each `defineDomain` storage domain, each `*_SCHEMA_VERSION`
 * constant, and each `'delorun.<name>/<n>'` schema of a record kept under the home.
 * @returns the declarations found, as `storage:<name>` or the constant or schema text, with their versions.
 */
function declaredRecords(): Map<string, number> {
  const found = new Map<string, number>()
  for (const text of SOURCE_ROOTS.flatMap(sources)) {
    for (const match of text.matchAll(/defineDomain\(\{\s*name: '([a-z_]+)',\s*version: (\d+)/gu)) found.set(`storage:${match[1]!}`, Number(match[2]))
    for (const match of text.matchAll(/export const ([A-Z_]+_SCHEMA_VERSION) = (\d+)/gu)) found.set(match[1]!, Number(match[2]))
    for (const match of text.matchAll(/'delorun\.([a-z-]+)\/(\d+)'/gu)) found.set(`delorun.${match[1]!}`, Number(match[2]))
  }
  return found
}

/**
 * Each declaration the sources hold, mapped to its `DELORUN_RECORDS` name, or to `null` with the reason it is no record
 * a previous release reads from the home. A new declaration fails the spec until it is listed here.
 */
const DECLARATIONS: Readonly<Record<string, string | null>> = {
  'storage:delorun_workspaces': 'storage:delorun_workspaces',
  'storage:delorun_chat_states': 'storage:delorun_chat_states',
  TRASH_ITEM_SCHEMA_VERSION: 'trash-item',
  'delorun.profile-safety': 'profile-safety',
  'delorun.safe-mode': 'safe-mode',
  'delorun.update-report': 'update-report',
  'delorun.session-data-copy': 'session-data-copy',
  'delorun.data-restore': 'data-restore-journal',
  'delorun.changes-protection': 'changes-protection',
  'delorun.changes-version': 'changes-version',
  'delorun.changes-approved': 'changes-approved',
  'delorun.changes-log': 'changes-log',
  'delorun.changes-work-session': 'changes-work-session',
  'delorun.changes-active': 'changes-active',
  'delorun.changes-boot': 'changes-boot',
  'delorun.changes-work': 'changes-work',
  'delorun.changes-migration': 'changes-migration',
  'delorun.changes-harness': 'changes-harness',
  'delorun.changes-notices': 'changes-notices',
  // A cache of file digests that a start rebuilds when it cannot read it; never decides anything.
  'delorun.changes-scan-cache': null,
  // The files of the changes the last read of a harness copy found; an action checks each file again, and reads the whole copy when it cannot use it.
  'delorun.changes-harness-pending': null,
  // Documents a person exports, passes in or reads; no release reads them back from the home's data.
  ARCHIVE_CUSTOMISATION_SCHEMA_VERSION: null,
  SETUP_ANSWERS_SCHEMA_VERSION: null,
  SETUP_DOCUMENT_SCHEMA_VERSION: null,
  VERIFICATION_REPORT_SCHEMA_VERSION: null,
  // A release's own signed file, read from the runtime closure, never from the home's data.
  'delorun.data-formats': null,
  // The home's data-format record, written by each start and read by `delorun repair`; a release that cannot read it treats it as absent, which repair reads as unknown.
  'delorun.home-data-format': null,
  // The release tool's inventory of plugin-facing interfaces, read from the repository at signing, never from the home.
  'delorun.plugin-interface': null,
  // The update check's record, which the next check replaces; a release that cannot read it reads it as absent.
  'delorun.update-check': null,
  // Signed release and catalogue metadata: each is verified against its signature and refetched, never chat data.
  'delorun.catalogue-index': null,
  'delorun.catalogue-revocations': null,
  'delorun.release-files': null,
  'delorun.release-log-bundle': null,
  'delorun.release-manifest': null,
  'delorun.release-packs': null,
  'delorun.release-rebuild': null,
  'delorun.release-root': null,
  'delorun.release-timestamp': null,
  // Verification state under trust/, replaced by every install and never part of a session-data copy.
  'delorun.release-log-checkpoint': null,
  'delorun.release-log-state': null,
  // A cache of the start check under trust/: a release that cannot read it, or reads another schema, hashes every file.
  'delorun.runtime-identity': null,
  // The plugin install check's records under a profile: a release that cannot read one lists its plugin as unrecorded,
  // never unchanged, and the next installation writes it again; the trust status is replaced by every check.
  'delorun.plugin-install': null,
  'delorun.plugin-trust': null,
  // What the start check did, handed to the runtime in its environment by the launcher that starts it; never a file.
  'delorun.start-check': null,
  // The bill `delorun verify --json` prints and the Host serves to the studio; produced on request, never stored.
  'delorun.trust-bill': null,
}

describe('c03-previous-release-reads-delorun-records', () => {
  it('maps every versioned record the sources declare, at the version DELORUN_RECORDS lists', () => {
    const declared = declaredRecords()
    for (const [declaration, version] of declared) {
      expect(Object.hasOwn(DECLARATIONS, declaration), `${declaration} is declared in the sources and not mapped in this spec`).toBe(true)
      const name = DECLARATIONS[declaration]
      if (name !== null && name !== undefined) expect(DELORUN_RECORDS[name], declaration).toBe(version)
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
      'storage:delorun_workspaces': 1,
      'storage:delorun_chat_states': 1,
      'trash-item': 1,
      'changes-protection': 1,
      'changes-version': 1,
      'changes-approved': 1,
      'changes-log': 1,
      'changes-work-session': 1,
      'changes-active': 1,
      'changes-boot': 1,
      'changes-work': 1,
      'changes-migration': 1,
      'changes-harness': 1,
      'changes-notices': 1,
    }
    expect(DELORUN_RECORDS).toEqual(written)
  })

  it('reads back the update record it writes, at the listed version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delorun-records-'))
    try {
      const path = join(home, 'update.json')
      const version = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
      await writeJournal(path, { from: version('1.0.0'), to: version('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: true, targetStarted: true }, 'committed')
      expect((JSON.parse(readFileSync(path, 'utf8')) as { readonly v: number }).v).toBe(DELORUN_RECORDS['update-record'])
      expect(await readJournal(path)).toMatchObject({ from: '1.0.0', to: '1.1.0', phase: 'committed', dataDiffers: true, copy: true, targetStarted: true })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('writes a journal that rc.3 parses, and resumes it without bundleRows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delorun-records-'))
    try {
      const path = join(home, 'update.json')
      const version = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
      const health = { disabledPlugins: ['plugin-a'], namedRows: ['row-b'], bundleRows: ['plugin-shared'], bundles: ['bundle-c'] }
      await writeJournal(path, { from: version('1.0.0'), to: version('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: false, copy: false, targetStarted: false, health }, 'health-check')
      expect(RC3_JOURNAL_SCHEMA.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success).toBe(true)
      expect((await readJournal(path))?.health).toEqual({ disabledPlugins: ['plugin-a'], namedRows: ['row-b'], bundles: ['bundle-c'] })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
