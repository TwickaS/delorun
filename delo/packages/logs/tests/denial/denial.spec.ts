/**
 * C20's cross-surface denial suite. Each test of C20's table runs over the reference surface and over every surface
 * whose package is in the tree and writes through `@delo/logs`; a surface that is absent or not yet wired is listed
 * as skipped with its reason, and a wired surface without a driver fails the suite.
 */
import { AGE_CHECK_INTERVAL_MS, CAPTURED_LINE_MAX_BYTES, KEPT_FILES, LOG_DIR_MODE, LOG_FILE_MODE, RECORD_MAX_BYTES, RETENTION_MS, ROTATE_BYTES, SURFACE_FILES } from '@delo/contract-operational-logs'
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLocalLogs, clearSurface, pruneLocalSurfaces, startAgeChecks } from '../../src/index.ts'
import { canary, clock, encodings, logTexts, openLog, patternCanaries, patternLines, patternSecrets, recordsOf, SECRET_KINDS, tempHome, type TempHome } from '../support.ts'
import { REFERENCE_DRIVER, SURFACES, surfaceState, type RunningSurface, type SurfaceDriver } from './surfaces.ts'

const states = SURFACES.map(entry => ({ entry, state: surfaceState(entry) }))
const drivers: { readonly label: string; readonly driver: SurfaceDriver }[] = [
  { label: 'reference surface (@delo/logs)', driver: REFERENCE_DRIVER },
  ...states.flatMap(({ entry, state }) => (state.kind === 'wired' && entry.driver !== undefined ? [{ label: entry.name, driver: entry.driver }] : [])),
]

let temp: TempHome | undefined
let running: RunningSurface | undefined
afterEach(async () => {
  await running?.stop()
  running = undefined
  temp?.remove()
  temp = undefined
})

async function start(driver: SurfaceDriver): Promise<{ readonly home: string; readonly surface: RunningSurface }> {
  temp = tempHome()
  running = await driver.start(temp.home)
  return { home: temp.home, surface: running }
}

/** Every text that must not appear in any log file, with the value it came from. */
function forbidden(values: readonly string[]): string[] {
  return values.flatMap(value => encodings(value))
}

function expectAbsent(home: string, values: readonly string[]): void {
  const texts = logTexts(home)
  expect(texts.length).toBeGreaterThan(0)
  for (const { path, text } of texts) {
    for (const form of forbidden(values)) expect(text.includes(form), `${form} in ${path}`).toBe(false)
  }
}

/** Write records through the logger until the active file has rotated at least `times` times. */
async function rotate(surface: RunningSurface, times: number): Promise<void> {
  const filler = 'f'.repeat(RECORD_MAX_BYTES - 512)
  const records = Math.ceil(ROTATE_BYTES / filler.length) * times + 1
  for (let index = 0; index < records; index += 1) await surface.log(filler)
}

describe('the surfaces C20 lists', () => {
  it('names every surface of the contract', () => {
    expect(SURFACES.map(entry => entry.kind).sort()).toEqual(Object.keys(SURFACE_FILES).sort())
  })

  for (const { entry, state } of states) {
    if (state.kind === 'wired') {
      it(`${entry.name}: writes through @delo/logs, so the suite runs it`, () => {
        expect(entry.driver, `${entry.owner} depends on @delo/logs; register its driver in tests/denial/surfaces.ts`).toBeDefined()
      })
    } else {
      it.skip(`${entry.name}: skipped, ${state.reason}`, () => {})
    }
  }
})

// These tests write tens of MiB and start child processes; a loaded host needs more than the default 5 seconds.
const IO_TIMEOUT_MS = 120_000

describe.each(drivers)('$label', { timeout: IO_TIMEOUT_MS }, ({ driver }) => {
  it('log-canary-every-surface: no registered secret of any kind reaches any log file, rotated files included, in any encoding', async () => {
    const { home, surface } = await start(driver)
    const values = SECRET_KINDS.map(kind => ({ kind, value: canary(kind) }))
    for (const { kind, value } of values) surface.register(value, kind)
    const plant = async (): Promise<void> => {
      for (const { kind, value } of values) {
        for (const form of encodings(value)) {
          await surface.log(`loaded ${kind} ${form}`, { data: { note: form, nested: { list: [form] } }, err: Object.assign(new Error(`failed with ${form}`), { detail: form }) })
        }
      }
      const lines = values.flatMap(({ kind, value }) => encodings(value).map(form => `upstream printed ${kind} ${form}\n`))
      await surface.print('stdout', lines)
      await surface.print('stderr', lines)
    }
    await plant()
    await rotate(surface, 1)
    await plant()
    expect(readdirSync(dirname(surface.location.file)).filter(name => name.includes('.log.')).length).toBeGreaterThan(0)
    expectAbsent(home, values.map(({ value }) => value))
    const all = logTexts(home).map(({ text }) => text).join('')
    for (const { kind } of values) expect(all, kind).toContain(`[redacted:${kind}]`)
    expect(surface.failures).toEqual([])
  })

  it('log-canary-split: a secret split across two writes, and secrets in a line longer than 65,536 bytes, never reach a log file', async () => {
    const { home, surface } = await start(driver)
    const split = canary('start-token')
    const early = canary('model-key')
    const straddling = canary('cookie')
    const late = canary('relay-key')
    for (const [value, kind] of [[split, 'start-token'], [early, 'model-key'], [straddling, 'cookie'], [late, 'relay-key']] as const) surface.register(value, kind)
    await surface.print('stderr', [`token ${split.slice(0, 9)}`, `${split.slice(9)} in use\n`])
    const head = `${early} ${'a'.repeat(20_000)}`
    const toBoundary = 'b'.repeat(CAPTURED_LINE_MAX_BYTES - head.length - 10)
    await surface.print('stdout', [head, `${toBoundary}${straddling}`, `${'c'.repeat(40_000)}${late}\n`])
    expectAbsent(home, [split, early, straddling, late])
    const records = recordsOf(surface.location.file)
    expect(records.some(record => record.msg === 'token [redacted:start-token] in use')).toBe(true)
    expect(records.some(record => record.msg.startsWith('[redacted:model-key] ') && (record.truncated ?? 0) > 0)).toBe(true)
  })

  it('log-canary-patterns: an Authorization header, URL user information, a PEM key and an owner code in captured output are redacted', async () => {
    const { home, surface } = await start(driver)
    const canaries = patternCanaries()
    await surface.print('stderr', patternLines(canaries).map(line => `${line}\n`))
    for (const { text } of logTexts(home)) {
      for (const secret of patternSecrets(canaries)) expect(text.includes(secret), secret).toBe(false)
    }
    const all = logTexts(home).map(({ text }) => text).join('')
    for (const kind of ['authorization', 'url-userinfo', 'private-key', 'owner-code']) expect(all, kind).toContain(`[redacted:${kind}]`)
  })

  it('log-rotation: writing past 10 MiB rotates the file and at most 5 files exist', async () => {
    const { home, surface } = await start(driver)
    const sessions = join(home, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const sessionLog = join(sessions, 'chat.jsonl')
    writeFileSync(sessionLog, '{"type":"turn/start"}\n')
    await rotate(surface, KEPT_FILES + 1)
    const dir = dirname(surface.location.file)
    const names = readdirSync(dir)
    expect(names.length).toBe(KEPT_FILES)
    for (const name of names) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(ROTATE_BYTES)
    expect(readFileSync(sessionLog, 'utf8')).toBe('{"type":"turn/start"}\n')
  })

  it('log-modes: log directories are created at 0700 and log files at 0600', async () => {
    const previous = process.umask(0)
    try {
      const { surface } = await start(driver)
      await surface.log('mode check')
      expect(statSync(dirname(surface.location.file)).mode & 0o777).toBe(LOG_DIR_MODE)
      expect(statSync(surface.location.file).mode & 0o777).toBe(LOG_FILE_MODE)
    } finally {
      process.umask(previous)
    }
  })

  it('log-purge-clear (the clear effect): after the clear, no residue of a chat remains in any log file, startup reports included', async () => {
    const { home, surface } = await start(driver)
    const residue = `chat-residue-${canary('session-secret')}`
    await surface.print('stderr', [`command failed: grep ${residue} notes.txt\n`])
    await rotate(surface, 1)
    await surface.print('stdout', [`echo ${residue}\n`])
    writeFileSync(join(home, 'logs', 'startup-2026-11-01T00-00-00.000Z-x.log'), `WARNING\n${residue}\n`, { mode: 0o600 })
    expect(logTexts(home).some(({ text }) => text.includes(residue))).toBe(true)
    const local = surface.location.dir.startsWith(join(home, 'logs')) ? clearLocalLogs(home) : clearSurface(surface.location)
    // A surface that keeps files of its own, such as the relay's container directory, clears them
    // in addition to the home's surfaces and startup reports.
    const own = surface.clear?.()
    const cleared = {
      deleted: [...local.deleted, ...own?.deleted ?? []],
      emptied: [...local.emptied, ...own?.emptied ?? []],
      failures: [...local.failures, ...own?.failures ?? []],
    }
    expect(cleared.failures).toEqual([])
    await surface.log('after the clear')
    expect(logTexts(home).some(({ text }) => text.includes(residue))).toBe(false)
    expect(recordsOf(surface.location.file).map(record => record.msg)).toEqual(['after the clear'])
  })
})

describe('log-rotation (age): every surface ages through @delo/logs\'s age check', () => {
  it('deletes files whose oldest record is older than 14 days at the next age check, at the next start of a Delo process and by delorun logs --prune, and leaves session logs', () => {
    temp = tempHome()
    const home = temp.home
    const time = clock()
    const sessionLog = join(home, 'sessions', 'chat.jsonl')
    mkdirSync(dirname(sessionLog), { recursive: true })
    writeFileSync(sessionLog, '{"type":"turn/start"}\n')
    utimesSync(sessionLog, new Date(0), new Date(0))
    const write = (kind: 'home' | 'supervisor' | 'desktop-host'): string => {
      const { log, location } = openLog(home, { kind, clock: time })
      log.logger('x').info('aged record')
      log.close()
      return location.file
    }
    vi.useFakeTimers()
    try {
      // At a start: the files of a process that is not running are pruned.
      const stopped = write('supervisor')
      time.now += RETENTION_MS + 1
      const deleted: string[] = []
      const stop = startAgeChecks({ home, now: time.read, onReport: (report) => { deleted.push(...report.deleted) } })
      expect(deleted).toEqual([stopped])
      // At the next age check while the process runs.
      const running = write('home')
      time.now += RETENTION_MS + 1
      vi.advanceTimersByTime(AGE_CHECK_INTERVAL_MS)
      expect(deleted).toEqual([stopped, running])
      stop()
      // On demand, the effect of delorun logs --prune.
      const desktop = write('desktop-host')
      time.now += RETENTION_MS + 1
      expect(pruneLocalSurfaces(home, time.now).deleted).toEqual([desktop])
    } finally {
      vi.useRealTimers()
    }
    expect(readFileSync(sessionLog, 'utf8')).toBe('{"type":"turn/start"}\n')
    expect(statSync(sessionLog).mtimeMs).toBe(0)
  })
})

describe('C20 denial tests that wait for other packages', () => {
  it.skip('log-desktop-host-file: skipped, the desktop Host is not wired to @delo/logs (WP6.1)', () => {})
  it.skip('log-purge-clear (after a purge): skipped, C8\'s purge and its offer are not in the tree; the clear effect it runs is proven above', () => {})
  it.skip('log-confined-write-denied: skipped, Delo\'s sandbox profiles for C1\'s home-write rule are not in the tree (WP2.14)', () => {})
})
