import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recorded, serializeCheckState, type RecordedCheck } from '@delorun/release-verify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkImportRecord, checkReleaseLog, type DshImportRecordEntry } from '../../src/doctor/records.ts'
import { POSIX } from './fixtures.ts'

const RELEASE = '0.4.0'
/** 2026-11-10T12:00:00Z. */
const NOW = 1_794_312_000

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-records-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * Write the home's release-log state record at mode 0600.
 * @param text - the record's text.
 * @returns the record's path.
 */
function writeState(text: string): string {
  mkdirSync(join(home, 'trust'), { recursive: true, mode: 0o700 })
  const path = join(home, 'trust', 'release-log.json')
  writeFileSync(path, text, { mode: 0o600 })
  return path
}

/**
 * Write a state record holding the given entries.
 * @param entries - one recorded check per release.
 * @returns the record's path.
 */
function writeChecks(...entries: RecordedCheck[]): string {
  return writeState(serializeCheckState(new Map(entries.map(entry => [entry.release, entry]))))
}

/** One import entry with no entry left behind. */
const IMPORT: DshImportRecordEntry = { at: '2026-11-09T08:00:00.000Z', source: '/home/person/.dsh', chats: 3, workspaces: 1, profiles: ['web'], credentials: [], skipped: 0 }

describe('checkReleaseLog', () => {
  it('passes a release the release log verified, with the time of the check', async () => {
    writeChecks(recorded(RELEASE, 'verified', NOW - 60))
    expect(await checkReleaseLog(home, RELEASE, NOW)).toEqual({ name: 'release-log', status: 'pass', message: 'release 0.4.0 verified against the release log at 2026-11-10T11:59:00Z.' })
  })

  it('warns for an unchecked release with the time since which it stayed unchecked and the recorded reason, in delorun verify\'s words', async () => {
    const first = recorded(RELEASE, 'unchecked', NOW - 3 * 3600, { detail: 'the distributor did not answer' })
    writeChecks(recorded(RELEASE, 'unchecked', NOW - 600, { detail: 'the distributor did not answer\nagain' }, first))
    expect(await checkReleaseLog(home, RELEASE, NOW)).toEqual({
      name: 'release-log',
      status: 'warn',
      message: 'Release 0.4.0 has not been checked against the release log; Delorun checks it at the next connection. It has stayed unchecked since 2026-11-10T09:00:00Z (3 hours); the last attempt, at 2026-11-10T11:50:00Z, recorded: the distributor did not answer again.',
    })
  })

  it('warns for an unchecked release whose record holds no reason and no start of its unchecked run', async () => {
    writeState(`${JSON.stringify({ schema: 'delorun.release-log-state/1', releases: { [RELEASE]: { release: RELEASE, state: 'unchecked', lastAttempt: NOW - 30 } } })}\n`)
    const result = await checkReleaseLog(home, RELEASE, NOW)
    expect(result.status).toBe('warn')
    expect(result.message).toContain('It has stayed unchecked since 2026-11-10T11:59:30Z (under a minute); the last attempt, at 2026-11-10T11:59:30Z, recorded no reason.')
  })

  it('fails a release the release log refused, naming the refusal and what the check saw', async () => {
    writeChecks(recorded(RELEASE, 'failed', NOW - 60, { refusal: 'inclusion-proof-invalid', detail: 'the proof does not reach the root' }))
    const result = await checkReleaseLog(home, RELEASE, NOW)
    expect(result.status).toBe('fail')
    expect(result.message).toBe('the release log refused release 0.4.0 (inclusion-proof-invalid) at 2026-11-10T11:59:00Z: the proof does not reach the root')
  })

  it('fails a refused release whose record names only the contract\'s failure class, or nothing', async () => {
    writeState(`${JSON.stringify({ schema: 'delorun.release-log-state/1', releases: { [RELEASE]: { release: RELEASE, state: 'failed', lastAttempt: NOW } } })}\n`)
    const result = await checkReleaseLog(home, RELEASE, NOW)
    expect(result).toMatchObject({ status: 'fail', message: 'the release log refused release 0.4.0 (no refusal recorded) at 2026-11-10T12:00:00Z: no detail recorded' })
    writeState(`${JSON.stringify({ schema: 'delorun.release-log-state/1', releases: { [RELEASE]: { release: RELEASE, state: 'failed', failure: 'log-inconsistent', lastAttempt: NOW } } })}\n`)
    expect((await checkReleaseLog(home, RELEASE, NOW)).message).toContain('(log-inconsistent)')
  })

  it('warns when no state is recorded, whether the record is absent or holds only other releases', async () => {
    const path = join(home, 'trust', 'release-log.json')
    const absent = await checkReleaseLog(home, RELEASE, NOW)
    expect(absent).toEqual({ name: 'release-log', status: 'warn', message: `no release-log check of release 0.4.0 is recorded in ${path}; run delorun verify to check it against the release log.` })
    writeChecks(recorded('0.3.0', 'verified', NOW))
    expect(await checkReleaseLog(home, RELEASE, NOW)).toEqual(absent)
  })

  it('warns when the state record does not read, and says the next check rewrites it', async () => {
    const path = writeState('{"schema":"delorun.release-log-state/1","releases":[]}\n')
    const result = await checkReleaseLog(home, RELEASE, NOW)
    expect(result.status).toBe('warn')
    expect(result.message).toMatch(new RegExp(`^the release-log state at ${path.replaceAll('.', '\\.')} does not read \\(.+\\); the next start or delorun verify checks release 0\\.4\\.0 again and rewrites it\\.$`))
    expect(result.message).not.toMatch(/[\n\r]/)
  })

  it.runIf(POSIX)('throws SECRET_FILE_MODE for a record other users can read', async () => {
    const path = writeChecks(recorded(RELEASE, 'verified', NOW))
    chmodSync(path, 0o644)
    await expect(checkReleaseLog(home, RELEASE, NOW)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
  })

  it('throws the filesystem error when the record cannot be read', async () => {
    mkdirSync(join(home, 'trust', 'release-log.json'), { recursive: true })
    await expect(checkReleaseLog(home, RELEASE, NOW)).rejects.toThrow()
  })
})

describe('checkImportRecord', () => {
  it('passes a home no stock home was imported into', async () => {
    expect(await checkImportRecord(home, () => Promise.resolve([]))).toEqual({ name: 'import', status: 'pass', message: 'no stock DeepSeek Harness home has been imported into this home.' })
  })

  it('passes the newest import that left nothing behind, and reads the record of the home it is given', async () => {
    const homes: string[] = []
    const older: DshImportRecordEntry = { ...IMPORT, at: '2026-11-01T00:00:00.000Z', chats: 1, workspaces: 2, profiles: [], credentials: ['DEEPSEEK_API_KEY'] }
    const result = await checkImportRecord(home, (from) => { homes.push(from); return Promise.resolve([older, IMPORT]) })
    expect(homes).toEqual([home])
    expect(result).toEqual({ name: 'import', status: 'pass', message: 'the newest of 2 stock-home imports, from /home/person/.dsh at 2026-11-09T08:00:00.000Z, carried 3 chats, 1 workspace, 1 profile and 0 credentials.' })
  })

  it('warns when the newest import left entries behind, and keeps recorded text on one line', async () => {
    const result = await checkImportRecord(home, () => Promise.resolve([{ ...IMPORT, source: '/home/person/\u001b[31m.dsh\nx', skipped: 2, profiles: ['web', 'cli'], credentials: ['A'] }]))
    expect(result).toEqual({
      name: 'import',
      status: 'warn',
      message: 'the newest of 1 stock-home import, from /home/person/ [31m.dsh x at 2026-11-09T08:00:00.000Z, carried 3 chats, 1 workspace, 2 profiles and 1 credential; it left 2 entries of the stock home behind, which it did not copy.',
    })
    const one = await checkImportRecord(home, () => Promise.resolve([{ ...IMPORT, skipped: 1 }]))
    expect(one.message).toContain('it left 1 entry of the stock home behind')
  })

  it('passes the reader\'s failure on to the caller', async () => {
    await expect(checkImportRecord(home, () => Promise.reject(new Error('EISDIR: the record is a directory')))).rejects.toThrow('EISDIR')
  })
})
