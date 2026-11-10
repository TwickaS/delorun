import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_FORMATS_FILE, DATA_FORMATS_SCHEMA } from '@delo/contract-update-report'
import {
  buildUpdateReport,
  compareDataFacts,
  confirmsWithoutAsking,
  dataCopyNote,
  dataFormatsOf,
  dataFormatsText,
  dataItems,
  DELO_RECORDS,
  parseDataFormats,
  readDataFormats,
  reasonMessage,
} from '../src/index.ts'
import { COPY, DATA, FORMATS, FROM, input, TO, version } from './support.ts'

describe('data-formats.json', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'delo-data-formats-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('records the persistence-schema digest and Delo\'s own records', () => {
    const formats = dataFormatsOf(new TextEncoder().encode('{"formatVersion":2}'))
    expect(formats.schema).toBe(DATA_FORMATS_SCHEMA)
    expect(formats.persistence).toMatch(/^[0-9a-f]{64}$/u)
    expect(formats.deloRecords).toEqual(DELO_RECORDS)
    expect(parseDataFormats(dataFormatsText(formats))).toEqual(formats)
  })

  it('reads the file at a runtime root, and reads a missing or malformed one as absent', async () => {
    expect(await readDataFormats(directory)).toBeUndefined()
    await writeFile(join(directory, DATA_FORMATS_FILE), '{"schema":"delo.data-formats/9"}')
    expect(await readDataFormats(directory)).toBeUndefined()
    await writeFile(join(directory, DATA_FORMATS_FILE), dataFormatsText(FORMATS))
    expect(await readDataFormats(directory)).toEqual(FORMATS)
  })

  it('refuses text that is not a record', () => {
    expect(() => parseDataFormats('{"schema":"delo.data-formats/1","persistence":"x","deloRecords":{}}')).toThrow(/not a delo.data-formats\/1 record/u)
    expect(() => parseDataFormats('[]')).toThrow(/not a delo.data-formats\/1 record/u)
  })
})

describe('the comparison', () => {
  const other = { ...FORMATS, persistence: FORMATS.persistence.replace(/c/gu, 'd') as typeof FORMATS.persistence }

  it('finds two releases with equal facts the same', () => {
    expect(compareDataFacts(DATA.from, DATA.to)).toEqual({ kind: 'same' })
    expect(dataItems(DATA)).toEqual([])
  })

  it('names each part that differs', () => {
    expect(compareDataFacts(DATA.from, { dsh: version('0.3.0'), formats: FORMATS })).toEqual({ kind: 'changed', differs: ['dsh'] })
    expect(compareDataFacts(DATA.from, { dsh: version('0.2.2'), formats: other })).toEqual({ kind: 'changed', differs: ['persistence'] })
    expect(compareDataFacts(DATA.from, { dsh: version('0.2.2'), formats: { ...FORMATS, deloRecords: { 'update-record': 2 } } })).toEqual({ kind: 'changed', differs: ['delo-records'] })
    expect(compareDataFacts(DATA.from, { dsh: version('0.2.2'), formats: { ...FORMATS, deloRecords: { 'update-record': 1, 'safe-mode': 1 } } })).toEqual({ kind: 'changed', differs: ['delo-records'] })
    expect(compareDataFacts(DATA.from, { dsh: version('0.2.2'), formats: { ...FORMATS, deloRecords: { 'store-lock': 1 } } })).toEqual({ kind: 'changed', differs: ['delo-records'] })
  })

  it('c03-data-change-named: a change is one verified data item with the copy\'s size and the free space', () => {
    const report = buildUpdateReport(input({ data: { ...DATA, to: { dsh: version('0.3.0'), formats: other } } }))
    const items = report.items.filter(item => item.kind === 'data')
    expect(items).toEqual([{
      kind: 'data',
      subject: { directories: ['sessions', 'storages'] },
      reason: 'data-format-changed',
      effect: 'changed',
      verification: 'verified',
      detail: { differs: ['dsh', 'persistence'], copy: COPY },
      actions: ['copy-session-data', 'continue-without-copy'],
    }])
    expect(report.counts.data).toBe(1)
    expect(report.items.at(-1)?.kind).toBe('data')
    expect(reasonMessage(items[0]!, { from: FROM, to: TO })).toBe('Delo 1.0.0 keeps chat data in a format Delo 0.9.0 may not read.')
    expect(dataCopyNote({ from: FROM, to: TO })).toBe('Without the copy, Delo cannot go back to 0.9.0 after 1.0.0 first starts.')
  })

  it('c03-unknown-data-format-is-unverified: a missing file is unverified, and --yes does not confirm it', () => {
    const report = buildUpdateReport(input({ data: { ...DATA, to: { dsh: version('0.2.2'), formats: undefined } } }))
    const item = report.items.find(entry => entry.kind === 'data')
    expect(item).toMatchObject({ reason: 'data-format-unknown', verification: 'unverified', detail: { unreadable: ['to'] } })
    expect(report.counts.unverified).toBeGreaterThanOrEqual(1)
    expect(reasonMessage(item!, { from: FROM, to: TO })).toBe('Delo cannot tell whether Delo 0.9.0 reads the chat data Delo 1.0.0 writes.')
    const confirmable = { ...report, items: report.items.filter(entry => entry.kind === 'data'), counts: { ...report.counts } }
    expect(confirmsWithoutAsking(confirmable)).toBe(false)
    const both = compareDataFacts({ dsh: version('0.2.2'), formats: undefined }, { dsh: version('0.2.2'), formats: undefined })
    expect(both).toEqual({ kind: 'unknown', unreadable: ['from', 'to'] })
  })

  it('confirms a report whose only item is a verified data change', () => {
    const report = buildUpdateReport(input({ data: { ...DATA, to: { dsh: version('0.3.0'), formats: FORMATS } } }))
    expect(confirmsWithoutAsking({ ...report, items: report.items.filter(entry => entry.kind === 'data') })).toBe(true)
  })
})
