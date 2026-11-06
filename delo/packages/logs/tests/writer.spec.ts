/**
 * The surface writer: C20's record fields and keys, the line limit, rotation at 10 MiB with 5 files kept, the
 * modes and C1's refusal rule, and a writer continuing after another process rotated, pruned or emptied its file.
 */
import { RECORD_MAX_BYTES, ROTATE_BYTES, type WorkspaceId } from '@delo/contract-operational-logs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLogsFailure, resolveSurface, rotatedFile, SurfaceLog } from '../src/index.ts'
import { canary, modeOf, openLog, recordsOf, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

function home(): string {
  temp = tempHome()
  return temp.home
}

describe('records', () => {
  it('writes one JSON line per record with C20\'s fields, the start id and the keys it is given', () => {
    const { log, location } = openLog(home(), { startId: '0123456789abcdef0123456789abcdef' })
    log.logger('delo-home').info('started', { keys: { sessionId: SessionId('s-1'), turn: 2, workspaceId: 'w-1' as WorkspaceId } })
    log.logger('delo-home').debug('plain')
    expect(location.file.endsWith(join('logs', 'home-default', 'home.log'))).toBe(true)
    expect(recordsOf(location.file)).toEqual([
      { ts: '2026-11-01T00:00:00.000Z', level: 'info', surface: 'home-default', pid: 4242, startId: '0123456789abcdef0123456789abcdef', logger: 'delo-home', source: 'delo', msg: 'started', sessionId: 's-1', turn: 2, workspaceId: 'w-1' },
      { ts: '2026-11-01T00:00:00.000Z', level: 'debug', surface: 'home-default', pid: 4242, startId: '0123456789abcdef0123456789abcdef', logger: 'delo-home', source: 'delo', msg: 'plain' },
    ])
  })

  it('takes ambient keys from the newest key source when a record names none', () => {
    const { log, location } = openLog(home())
    const stopOuter = log.useKeys(() => ({ sessionId: SessionId('outer') }))
    const stopInner = log.useKeys(() => undefined)
    log.logger('x').info('one')
    stopInner()
    stopOuter()
    log.logger('x').info('two')
    expect(recordsOf(location.file).map(record => record.sessionId)).toEqual(['outer', undefined])
  })

  it('writes only the levels its level includes', () => {
    const temp = home()
    const location = resolveSurface({ kind: 'supervisor', home: temp, profile: 'default' })
    const log = SurfaceLog.open({ location, redactor: openLog(temp).redactor, pid: 1, level: 'warn', onFailure: () => {}, now: Date.now })
    const logger = log.logger('supervisor')
    logger.debug('no')
    logger.info('no')
    logger.warn('yes')
    logger.error('yes')
    expect(recordsOf(location.file).map(record => record.level)).toEqual(['warn', 'error'])
  })

  it('redacts the message, the structured details and the error of every record', () => {
    const { log, redactor, location } = openLog(home())
    const value = canary('deploy-key')
    redactor.register(value, 'deploy-key')
    log.logger('delo-update').error(`push with ${value} refused`, {
      data: { apiToken: 'unregistered-value', attempt: 2, note: value },
      err: Object.assign(new Error(`remote said ${value}`), { code: 'EPUSH' }),
    })
    const text = readFileSync(location.file, 'utf8')
    expect(text).not.toContain(value)
    expect(text).not.toContain('unregistered-value')
    const [record] = recordsOf(location.file)
    expect(record?.msg).toBe('push with [redacted:deploy-key] refused {"apiToken":"[redacted]","attempt":2,"note":"[redacted:deploy-key]"}')
    expect(record?.err).toMatchObject({ name: 'Error', code: 'EPUSH', message: 'remote said [redacted:deploy-key]' })
  })
})

describe('the line limit', () => {
  it('cuts a long message after redaction and states the bytes removed', () => {
    const { log, redactor, location } = openLog(home())
    const value = canary('relay-key')
    redactor.register(value, 'relay-key')
    // The secret straddles the point where the line is cut, so only redaction before truncation removes it.
    const cutAt = RECORD_MAX_BYTES - 300
    const msg = `${'é'.repeat(cutAt / 2)}${value}${'x'.repeat(RECORD_MAX_BYTES)}`
    log.logger('x').info(msg)
    const line = readFileSync(location.file, 'utf8')
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(RECORD_MAX_BYTES)
    expect(line).not.toContain(value.slice(0, 16))
    const [record] = recordsOf(location.file)
    const redacted = redactor.text(msg)
    expect(record?.truncated).toBe(Buffer.byteLength(redacted) - Buffer.byteLength(record?.msg ?? ''))
    expect(redacted.startsWith(record?.msg ?? '')).toBe(true)
  })

  it('cuts the error stack before the message', () => {
    const { log, location } = openLog(home())
    const error = new Error('short message')
    error.stack = `Error: short message\n${'    at frame (file.ts:1:1)\n'.repeat(2000)}`
    log.logger('x').error('failed', { err: error })
    const [record] = recordsOf(location.file)
    expect(record?.msg).toBe('failed')
    expect(record?.err?.message).toBe('short message')
    expect(record?.err?.stack?.length).toBeLessThan(error.stack.length)
    expect(record?.truncated).toBeGreaterThan(0)
    expect(Buffer.byteLength(readFileSync(location.file, 'utf8'))).toBeLessThanOrEqual(RECORD_MAX_BYTES)
  })
})

// Writing past 10 MiB six times takes several seconds on a loaded host.
describe('rotation', { timeout: 120_000 }, () => {
  it('rotates before a write would pass 10 MiB, keeps at most the active file and 4 rotated files, and deletes any beyond', () => {
    const { log, location } = openLog(home())
    writeFileSync(rotatedFile(location, 7), '', { mode: 0o600 })
    const chunk = 'r'.repeat(RECORD_MAX_BYTES - 400)
    const perFile = Math.floor(ROTATE_BYTES / Buffer.byteLength(chunk))
    for (let index = 0; index < perFile * 6 + 10; index += 1) log.logger('x').info(chunk)
    const names = readdirSync(location.dir).sort()
    expect(names).toEqual(['home.log', 'home.log.1', 'home.log.2', 'home.log.3', 'home.log.4'])
    for (const name of names) expect(statSync(join(location.dir, name)).size).toBeLessThanOrEqual(ROTATE_BYTES)
    expect(statSync(rotatedFile(location, 1)).size).toBeGreaterThan(ROTATE_BYTES - RECORD_MAX_BYTES)
  })

  it('continues in the file at its path after another process rotated, emptied or removed it', () => {
    const { log, location, failures } = openLog(home())
    const logger = log.logger('x')
    logger.info('one')
    renameSync(location.file, rotatedFile(location, 1))
    logger.info('two')
    truncateSync(location.file, 0)
    logger.info('three')
    rmSync(location.dir, { recursive: true })
    logger.info('four')
    expect(failures).toEqual([])
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['four'])
    expect(modeOf(location.dir)).toBe(0o700)
    expect(modeOf(location.file)).toBe(0o600)
  })
})

describe('modes and refusals', () => {
  it('creates the directory at 0700 and the file at 0600 whatever the umask', () => {
    const previous = process.umask(0)
    try {
      const { location } = openLog(home())
      expect(modeOf(location.dir)).toBe(0o700)
      expect(modeOf(location.file)).toBe(0o600)
      expect(modeOf(dirname(location.dir))).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  it('refuses an existing file with group or other bits, with chmod 600 as the fix', () => {
    const root = home()
    const location = resolveSurface({ kind: 'home', home: root, profile: 'default' })
    mkdirSync(location.dir, { recursive: true, mode: 0o700 })
    writeFileSync(location.file, '', { mode: 0o600 })
    chmodSync(location.file, 0o644)
    expect(() => openLog(root)).toThrow(expect.objectContaining({ code: 'SECRET_FILE_MODE', fix: `chmod 600 ${location.file}` }))
  })

  it('refuses a symbolic link in place of the file and a directory with group or other bits', () => {
    const root = home()
    const location = resolveSurface({ kind: 'home', home: root, profile: 'default' })
    mkdirSync(location.dir, { recursive: true, mode: 0o700 })
    const target = join(root, 'elsewhere.log')
    writeFileSync(target, 'untouched', { mode: 0o600 })
    symlinkSync(target, location.file)
    expect(() => openLog(root)).toThrow(expect.objectContaining({ code: 'SECRET_FILE_MODE' }))
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    rmSync(location.file)
    chmodSync(location.dir, 0o755)
    expect(() => openLog(root)).toThrow(expect.objectContaining({ code: 'HOME_MODE', fix: `chmod 700 ${location.dir}` }))
  })

  it('reports a failed write and drops the record without throwing', () => {
    const { log, location, failures } = openLog(home())
    log.close()
    rmSync(location.file)
    mkdirSync(location.file)
    expect(() => { log.logger('x').info('lost') }).not.toThrow()
    expect(failures).toHaveLength(1)
    expect(isLogsFailure(failures[0])).toBe(true)
    expect(existsSync(join(location.file, 'lost'))).toBe(false)
  })

  it('refuses a profile name that is not one before it becomes a path', () => {
    expect(() => resolveSurface({ kind: 'home', home: home(), profile: '../sessions' })).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }))
    expect(() => resolveSurface({ kind: 'home', home: 'relative', profile: 'default' })).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }))
    expect(resolveSurface({ kind: 'relay', home: '/unused' }).file).toBe('/var/log/delo-relay/relay.log')
  })
})
