/**
 * `c03-previous-release-reads-delorun-records`: every versioned record Delo keeps under the home is listed in
 * `DELO_RECORDS` at the version its owner writes, so a release that changes one names a data change and the update
 * takes a copy; and the update record a release writes is read back by the reader the same release ships, which is
 * what the previous release runs at its next start.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

describe('c03-previous-release-reads-delorun-records', () => {
  it('lists every record at the version its owner writes, and no other record', () => {
    const written: Record<string, number> = {
      'update-record': 1,
      'store-layout': STORE_LAYOUT,
      'profile-safety': versionOf(SAFETY_RECORD_SCHEMA),
      'safe-mode': versionOf(SAFE_MODE_SCHEMA),
      'update-report': versionOf(UPDATE_REPORT_SCHEMA),
      'session-data-copy': versionOf(COPY_RECORD_SCHEMA),
      'data-restore-journal': versionOf(RESTORE_JOURNAL_SCHEMA),
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
