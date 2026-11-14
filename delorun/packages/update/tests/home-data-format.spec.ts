import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_FORMATS_FILE, DATA_FORMATS_SCHEMA, HOME_DATA_FORMAT_FILE, HOME_DATA_FORMAT_SCHEMA, type DataFormats, type HomeDataFormat } from '@delorun/contract-update-report'
import { dataFormatsText } from '../src/data-formats.ts'
import { parseHomeDataFormat, readHomeDataFormat, recordHomeDataFormat, relateHomeData, writeHomeDataFormat } from '../src/home-data-format.ts'

const FORMATS: DataFormats = { schema: DATA_FORMATS_SCHEMA, persistence: 'c'.repeat(64) as DataFormats['persistence'], delorunRecords: { 'update-record': 1 } }

const record = (overrides: Partial<HomeDataFormat> = {}): HomeDataFormat => ({ schema: HOME_DATA_FORMAT_SCHEMA, delorun: '0.1.0', dsh: '0.2.2', formats: FORMATS, ...overrides })

describe('the home data-format record', () => {
  let home: string
  let runtime: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'delorun-home-format-'))
    runtime = await mkdtemp(join(tmpdir(), 'delorun-runtime-format-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(runtime, { recursive: true, force: true })
  })

  it('reads a home with no record, or a malformed one, as unknown', async () => {
    expect(await readHomeDataFormat(home)).toBeUndefined()
    await writeFile(join(home, HOME_DATA_FORMAT_FILE), '{"schema":"delorun.home-data-format/9"}')
    expect(await readHomeDataFormat(home)).toBeUndefined()
    expect(relateHomeData(undefined, { dsh: '0.2.2', formats: FORMATS })).toBe('unknown')
    expect(() => parseHomeDataFormat('[]')).toThrow(/not a delorun.home-data-format\/1 record/u)
  })

  it('writes the record at mode 0600 and reads it back', async () => {
    await writeHomeDataFormat(home, record())
    expect(await readHomeDataFormat(home)).toEqual(record())
    expect((await stat(join(home, HOME_DATA_FORMAT_FILE))).mode & 0o777).toBe(0o600)
  })

  it('relates a release to the home by DSH version, Delorun records and the persistence digest', () => {
    const release = { dsh: '0.2.2', formats: FORMATS }
    expect(relateHomeData(record(), release)).toBe('same')
    expect(relateHomeData(record({ dsh: '0.3.0' }), release)).toBe('newer')
    expect(relateHomeData(record({ dsh: '0.2.0' }), release)).toBe('older')
    expect(relateHomeData(record({ formats: { ...FORMATS, delorunRecords: { 'update-record': 2 } } }), release)).toBe('newer')
    expect(relateHomeData(record({ formats: { ...FORMATS, delorunRecords: { 'update-record': 1, 'safe-mode': 1 } } }), release)).toBe('newer')
    expect(relateHomeData(record(), { dsh: '0.2.2', formats: { ...FORMATS, delorunRecords: { 'update-record': 2 } } })).toBe('older')
    expect(relateHomeData(record(), { dsh: '0.2.2', formats: { ...FORMATS, persistence: FORMATS.persistence.replace(/c/gu, 'd') as typeof FORMATS.persistence } })).toBe('different')
    expect(relateHomeData(record(), { dsh: '0.2.2', formats: undefined })).toBe('unknown')
  })

  it('writes the running release\'s facts at a start, and writes nothing when the release has none', async () => {
    expect(await recordHomeDataFormat({ home, runtimeDirectory: runtime, delorun: '0.1.0', dsh: '0.2.2' })).toBe('no-formats')
    expect(await readHomeDataFormat(home)).toBeUndefined()
    await writeFile(join(runtime, DATA_FORMATS_FILE), dataFormatsText(FORMATS))
    expect(await recordHomeDataFormat({ home, runtimeDirectory: runtime, delorun: '0.1.0', dsh: '0.2.2' })).toBe('written')
    expect(await readHomeDataFormat(home)).toEqual(record())
  })

  it('keeps a record that shows newer data when an older release starts over it', async () => {
    await writeFile(join(runtime, DATA_FORMATS_FILE), dataFormatsText(FORMATS))
    await writeHomeDataFormat(home, record({ delorun: '0.2.0', dsh: '0.3.0' }))
    const before = await readFile(join(home, HOME_DATA_FORMAT_FILE), 'utf8')
    expect(await recordHomeDataFormat({ home, runtimeDirectory: runtime, delorun: '0.1.0', dsh: '0.2.2' })).toBe('kept')
    expect(await readFile(join(home, HOME_DATA_FORMAT_FILE), 'utf8')).toBe(before)
  })

  it('moves the record forward when a newer release starts over older data', async () => {
    await writeFile(join(runtime, DATA_FORMATS_FILE), dataFormatsText(FORMATS))
    await writeHomeDataFormat(home, record({ delorun: '0.0.9', dsh: '0.2.0' }))
    expect(await recordHomeDataFormat({ home, runtimeDirectory: runtime, delorun: '0.1.0', dsh: '0.2.2' })).toBe('written')
    expect((await readHomeDataFormat(home))?.delorun).toBe('0.1.0')
  })
})
