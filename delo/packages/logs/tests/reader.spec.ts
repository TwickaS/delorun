/**
 * Reading a surface: the last matching records across rotated files, lines that are not records, and following new
 * records across a rotation and an emptied file.
 */
import { chmodSync, renameSync, truncateSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followLines, parseRecord, readLines, rotatedFile, type StoredLine } from '../src/index.ts'
import { openLog, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

describe('readLines', () => {
  it('returns the last matching lines oldest first, across rotated files', () => {
    temp = tempHome()
    const { log, location } = openLog(temp.home)
    const logger = log.logger('x')
    for (const msg of ['a', 'b']) logger.info(msg)
    log.close()
    renameSync(location.file, rotatedFile(location, 1))
    for (const msg of ['c', 'd', 'e']) logger.info(msg)
    expect(readLines(location, 4, () => true).map(line => line.record?.msg)).toEqual(['b', 'c', 'd', 'e'])
    expect(readLines(location, 10, line => line.record?.msg !== 'c').map(line => line.record?.msg)).toEqual(['a', 'b', 'd', 'e'])
  })

  it('passes a line that is not a record with no record, and ignores unknown fields', () => {
    temp = tempHome()
    const { location } = openLog(temp.home)
    const known = { ts: '2026-11-01T00:00:00.000Z', level: 'info', surface: 'home-default', pid: 1, logger: 'x', source: 'delo', msg: 'm', future: true }
    writeFileSync(location.file, `not json\n${JSON.stringify(known)}\n{"ts":1}\npartial`)
    const lines = readLines(location, 10, () => true)
    expect(lines.map(line => line.record === undefined)).toEqual([true, false, true])
    expect(lines[1]?.record).toMatchObject({ msg: 'm', future: true })
    expect(parseRecord('[1]')).toBeUndefined()
  })

  it('refuses a file with group or other bits', () => {
    temp = tempHome()
    const { location } = openLog(temp.home)
    chmodSync(location.file, 0o640)
    expect(() => readLines(location, 1, () => true)).toThrow(expect.objectContaining({ code: 'SECRET_FILE_MODE' }))
  })
})

describe('followLines', () => {
  it('delivers each new line across a rotation and an emptied file, from the end at the call', async () => {
    temp = tempHome()
    const { log, location } = openLog(temp.home)
    const logger = log.logger('x')
    logger.info('before')
    const seen: StoredLine[] = []
    const controller = new AbortController()
    const following = followLines(location, { onLine: (line) => { seen.push(line) }, signal: controller.signal, intervalMs: 5 })
    const count = (expected: number): Promise<void> => vi.waitFor(() => { expect(seen).toHaveLength(expected) })
    logger.info('one')
    await count(1)
    logger.info('two')
    log.close()
    renameSync(location.file, rotatedFile(location, 1))
    logger.info('three')
    await count(3)
    truncateSync(location.file, 0)
    // The emptied file's new line is shorter than the line already read from it, so any check finds the file shorter.
    logger.info('four')
    await count(4)
    controller.abort()
    await following
    expect(seen.map(line => line.record?.msg)).toEqual(['one', 'two', 'three', 'four'])
  })
})
