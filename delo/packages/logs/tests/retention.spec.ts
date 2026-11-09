/**
 * Retention: the age check deletes each file whose oldest record is older than 14 days and upstream's startup
 * reports past that window, at a process start, on its interval and on demand; the clear effect empties active files
 * in place and deletes rotated files and upstream's startup reports; session logs and other files are never touched.
 */
import { AGE_CHECK_INTERVAL_MS, RETENTION_MS } from '@delo/contract-operational-logs'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLocalLogs, clearSurface, localSurfaces, oldestRecordTime, pruneLocalSurfaces, pruneSurface, resolveSurface, rotatedFile, startAgeChecks, startupReports } from '../src/index.ts'
import { openLog, recordsOf, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  vi.useRealTimers()
  temp?.remove()
  temp = undefined
})

const DAY = 86_400_000

function seedHome(home: string) {
  const session = join(home, 'sessions', 's-1.jsonl')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(session, `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', type: 'turn/start' })}\n`)
  utimesSync(session, new Date('2020-01-01'), new Date('2020-01-01'))
  const report = join(home, 'logs', 'startup-2020-01-01.log')
  writeFileSync(report, 'WARNING: raw diagnostics\n', { mode: 0o600 })
  utimesSync(report, new Date('2020-01-01'), new Date('2020-01-01'))
  return { session, report }
}

describe('the age check', () => {
  it('deletes each file whose oldest record is older than 14 days and leaves session logs and other files', () => {
    temp = tempHome()
    const { log, clock, location } = openLog(temp.home)
    const { session, report } = seedHome(temp.home)
    const start = clock.now
    log.logger('x').info('old')
    log.close()
    renameSync(location.file, rotatedFile(location, 2))
    clock.now = start + 10 * DAY
    log.logger('x').info('recent')
    log.close()
    renameSync(location.file, rotatedFile(location, 1))
    clock.now = start + 15 * DAY
    log.logger('x').info('today')
    const stray = join(location.dir, 'notes.txt')
    writeFileSync(stray, 'kept', { mode: 0o600 })

    const report1 = pruneSurface(location, start + 14 * DAY + 1)
    expect(report1).toEqual({ deleted: [rotatedFile(location, 2)], emptied: [], failures: [] })
    expect(existsSync(rotatedFile(location, 1))).toBe(true)

    const report2 = pruneLocalSurfaces(temp.home, start + 30 * DAY)
    expect([...report2.deleted].sort()).toEqual([location.file, rotatedFile(location, 1), report].sort())
    expect(existsSync(location.file)).toBe(false)
    expect(readFileSync(session, 'utf8')).toContain('turn/start')
    expect(existsSync(report)).toBe(false)
    expect(readFileSync(stray, 'utf8')).toBe('kept')
  })

  it('deletes an old startup report and keeps one inside the window', () => {
    temp = tempHome()
    mkdirSync(join(temp.home, 'logs'), { recursive: true, mode: 0o700 })
    const { report } = seedHome(temp.home)
    const fresh = join(temp.home, 'logs', 'startup-today.log')
    writeFileSync(fresh, 'WARNING: raw diagnostics\n', { mode: 0o600 })
    const now = Date.now()

    const report1 = pruneLocalSurfaces(temp.home, now)

    expect(report1.deleted).toEqual([report])
    expect(existsSync(report)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('rotates an expired active file away from a running writer, which continues in a new file', () => {
    temp = tempHome()
    const { log, clock, location, failures } = openLog(temp.home)
    log.logger('x').info('expired')
    clock.now += RETENTION_MS + 1
    expect(pruneLocalSurfaces(temp.home, clock.now).deleted).toEqual([location.file])
    log.logger('x').info('after')
    expect(failures).toEqual([])
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['after'])
  })

  it('runs at start and on its interval, and prunes the logs of a surface whose process has stopped', () => {
    temp = tempHome()
    const supervisor = openLog(temp.home, { kind: 'supervisor' })
    supervisor.log.logger('x').info('stopped process')
    supervisor.log.close()
    const desktop = openLog(temp.home, { kind: 'desktop-host' })
    desktop.log.logger('x').info('later')
    desktop.log.close()
    vi.useFakeTimers()
    let now = supervisor.clock.now + RETENTION_MS + 1
    const reports: string[][] = []
    const stop = startAgeChecks({ home: temp.home, now: () => now, onReport: (report) => { reports.push([...report.deleted]) } })
    expect(reports).toEqual([[desktop.location.file, supervisor.location.file]])
    vi.advanceTimersByTime(AGE_CHECK_INTERVAL_MS)
    expect(reports).toHaveLength(2)
    stop()
    now += AGE_CHECK_INTERVAL_MS
    vi.advanceTimersByTime(AGE_CHECK_INTERVAL_MS)
    expect(reports).toHaveLength(2)
  })

  it('ages a file whose first line holds no time by the file\'s own times, and never ages an empty file', () => {
    temp = tempHome()
    const { location } = openLog(temp.home)
    expect(oldestRecordTime(location.file)).toBeUndefined()
    writeFileSync(location.file, 'not json\n')
    utimesSync(location.file, new Date('2020-01-01'), new Date('2020-01-01'))
    expect(oldestRecordTime(location.file)).toBeLessThanOrEqual(Date.parse('2026-11-01'))
  })

  it('refuses a symbolic link planted at logs/ and touches nothing it points to', () => {
    temp = tempHome()
    const outside = join(temp.home, 'outside')
    mkdirSync(join(outside, 'home-default'), { recursive: true, mode: 0o700 })
    const log = join(outside, 'home-default', 'home.log')
    writeFileSync(log, `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', level: 'info', surface: 'home-default', msg: 'old' })}\n`, { mode: 0o600 })
    utimesSync(log, new Date('2020-01-01'), new Date('2020-01-01'))
    rmSync(join(temp.home, 'logs'), { recursive: true, force: true })
    symlinkSync(outside, join(temp.home, 'logs'))

    const aged = pruneLocalSurfaces(temp.home, Date.now())
    const cleared = clearLocalLogs(temp.home)

    expect(aged.failures.map(failure => failure.code)).toEqual(['HOME_MODE'])
    expect(cleared.failures.map(failure => failure.code)).toEqual(['HOME_MODE'])
    expect(readFileSync(log, 'utf8')).toContain('old')
  })

  it('reports a refused surface and still prunes the others', () => {
    temp = tempHome()
    const { log, clock } = openLog(temp.home)
    log.logger('x').info('old')
    const outside = join(temp.home, 'sessions')
    mkdirSync(outside, { recursive: true, mode: 0o700 })
    symlinkSync(outside, join(temp.home, 'logs', 'supervisor-default'))
    const report = pruneLocalSurfaces(temp.home, clock.now + RETENTION_MS + 1)
    expect(report.deleted).toHaveLength(1)
    expect(report.failures.map(failure => failure.code)).toEqual(['HOME_MODE'])
    expect(localSurfaces(temp.home).map(location => location.surface)).toEqual(['home-default', 'supervisor-default'])
  })
})

describe('the clear effect', () => {
  it('empties active files in place, deletes rotated files and startup reports, and leaves session logs', () => {
    temp = tempHome()
    const { log, location } = openLog(temp.home)
    const { session, report } = seedHome(temp.home)
    log.logger('x').info('before')
    log.close()
    renameSync(location.file, rotatedFile(location, 1))
    log.logger('x').info('active')
    expect(startupReports(temp.home)).toEqual([report])

    const cleared = clearLocalLogs(temp.home)
    expect(cleared).toEqual({ deleted: [rotatedFile(location, 1), report], emptied: [location.file], failures: [] })
    expect(readFileSync(location.file, 'utf8')).toBe('')
    expect(readFileSync(session, 'utf8')).toContain('turn/start')

    log.logger('x').info('continues')
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['continues'])
  })

  it('refuses to follow a symbolic link in place of an active file', () => {
    temp = tempHome()
    const { location } = openLog(temp.home)
    const target = join(temp.home, 'sessions.jsonl')
    writeFileSync(target, 'session data\n')
    const linked = resolveSurface({ kind: 'desktop-host', home: temp.home })
    mkdirSync(linked.dir, { mode: 0o700 })
    symlinkSync(target, linked.file)
    const report = clearSurface(linked)
    expect(report.failures.map(failure => failure.code)).toEqual(['SECRET_FILE_MODE'])
    expect(readFileSync(target, 'utf8')).toBe('session data\n')
    expect(clearSurface(location).failures).toEqual([])
  })
})
