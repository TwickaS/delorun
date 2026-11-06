/**
 * `delorun logs`: the overview of every C20 surface's location and the CLI home process's recent records, a
 * surface's records with filters and in stored JSON, the active file's path, following across a rotation, the clear
 * effect after confirmation, the age check on demand, and its usage errors.
 */
import { SURFACE_FILES, type SessionId } from '@delo/contract-operational-logs'
import { Redactor, resolveSurface, rotatedFile, SurfaceLog, type SurfaceLocation } from '@delo/logs'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/main.ts'
import { formatRecord, runLogs, type LogsIo } from '../../src/logs/index.ts'

const NOW = Date.parse('2026-11-06T12:00:00.000Z')
const DAY = 86_400_000

let home: string | undefined
afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly asked: readonly string[]
}

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), 'delorun-logs-'))
  return home
}

async function logs(root: string, argv: readonly string[], options: { readonly confirm?: boolean; readonly signal?: AbortSignal; readonly onOut?: (text: string) => void } = {}): Promise<Run> {
  let out = ''
  let err = ''
  const asked: string[] = []
  const io: LogsIo = {
    home: root,
    profile: 'default',
    stdout: (text) => {
      out += text
      options.onOut?.(text)
    },
    stderr: (text) => { err += text },
    confirm: (question) => {
      asked.push(question)
      return Promise.resolve(options.confirm ?? false)
    },
    now: () => NOW,
    signal: options.signal ?? new AbortController().signal,
  }
  const code = await runLogs(argv, io)
  return { code, out, err, asked }
}

/** A writer on a surface whose records are stamped by a clock the spec moves. */
function writer(root: string, kind: 'home' | 'supervisor' | 'desktop-host' = 'home') {
  const time = { now: NOW - DAY }
  const location: SurfaceLocation = resolveSurface({ kind, home: root, profile: 'default' })
  const log = SurfaceLog.open({ location, redactor: new Redactor(), pid: 7, level: 'debug', onFailure: (error) => { throw error }, now: () => time.now })
  return { log, location, time, logger: log.logger('delo-home') }
}

describe('delorun logs', () => {
  it('lists each C20 surface with its location and then the home process\'s last 50 records', async () => {
    const root = newHome()
    const { logger, time } = writer(root)
    for (let index = 1; index <= 60; index += 1) {
      time.now += 1000
      logger.info(`record ${String(index)}`)
    }
    writeFileSync(join(root, 'logs', 'startup-2026-11-01.log'), 'raw\n', { mode: 0o600 })
    const { code, out } = await logs(root, [])
    expect(code).toBe(0)
    expect(out).toContain(`home-default  ${join(root, SURFACE_FILES.home.replace('<profile>', 'default'))}  `)
    expect(out).toMatch(/home-default .* in 1 file, oldest record 2026-11-05T12:00:01\.000Z/)
    expect(out).toContain(`supervisor-default  ${join(root, SURFACE_FILES.supervisor.replace('<profile>', 'default'))}  not created`)
    expect(out).toContain(`desktop-host  ${join(root, SURFACE_FILES['desktop-host'])}  not created`)
    expect(out).toContain(`startup  ${join(root, 'logs', 'startup-*.log')}  1 upstream startup report`)
    expect(out).toContain(`relay  ${SURFACE_FILES.relay}  inside the self-hosted relay's container`)
    const tail = out.slice(out.indexOf('Last 50 records of home-default:'))
    expect(tail.split('\n').filter(line => line.includes(' info home-default '))).toHaveLength(50)
    expect(tail).toContain('record 11\n')
    expect(tail).not.toContain('record 10\n')
    expect(tail).toContain('record 60\n')
  })

  it('prints a surface\'s records in C20\'s human form, filtered by session, turn and age', async () => {
    const root = newHome()
    const { log, time } = writer(root)
    const logger = log.logger('agent')
    logger.info('old')
    time.now = NOW - 10 * 60_000
    logger.info('turn one', { keys: { sessionId: 's-1' as SessionId, turn: 1 } })
    logger.error('turn two failed', { keys: { sessionId: 's-1' as SessionId, turn: 2 }, err: Object.assign(new Error('exit 1'), { code: 'EEXIT' }) })
    logger.info('other chat', { keys: { sessionId: 's-2' as SessionId } })
    expect((await logs(root, ['home', '-n', '2'])).out).toBe([
      '2026-11-06T11:50:00.000Z error home-default [s-1/2] turn two failed (Error EEXIT: exit 1)',
      '2026-11-06T11:50:00.000Z info home-default [s-2] other chat',
      '',
    ].join('\n'))
    expect((await logs(root, ['home', '--session', 's-1'])).out.split('\n').filter(Boolean).map(line => line.slice(line.lastIndexOf(']') + 2))).toEqual(['turn one', 'turn two failed (Error EEXIT: exit 1)'])
    expect((await logs(root, ['home', '--session', 's-1', '--turn', '2'])).out).toContain('turn two failed')
    expect((await logs(root, ['home', '--since', '30m'])).out).not.toContain(' old')
    expect((await logs(root, ['home', '--since', '2d'])).out).toContain(' old')
  })

  it('prints the records as stored with --json and leaves out lines that are not records', async () => {
    const root = newHome()
    const { logger, location } = writer(root)
    logger.info('stored')
    writeFileSync(location.file, `${readFileSync(location.file, 'utf8')}not a record\n`)
    const { out, err } = await logs(root, ['home', '--json'])
    expect(out).toBe(readFileSync(location.file, 'utf8').split('\n')[0] + '\n')
    expect(err).toContain('1 line is not a log record')
  })

  it('prints only the active file\'s path with --path, and the relay\'s location inside its container', async () => {
    const root = newHome()
    expect((await logs(root, ['--path'])).out).toBe(`${join(root, 'logs', 'home-default', 'home.log')}\n`)
    expect((await logs(root, ['supervisor', '--path', '--profile', 'work'])).out).toBe(`${join(root, 'logs', 'supervisor-work', 'supervisor.log')}\n`)
    expect((await logs(root, ['relay', '--path'])).out).toBe('/var/log/delo-relay/relay.log\n')
    const relay = await logs(root, ['relay'])
    expect(relay.out).toContain('/var/log/delo-relay/relay.log inside the self-hosted relay\'s container')
    expect(relay.out).toContain('docker exec <relay-container> tail -n 50 /var/log/delo-relay/relay.log')
  })

  it('lists upstream\'s startup reports with upstream\'s warning and never prints their contents', async () => {
    const root = newHome()
    writer(root)
    const report = join(root, 'logs', 'startup-2026-11-01.log')
    writeFileSync(report, 'raw diagnostics with a value\n', { mode: 0o600 })
    const { out } = await logs(root, ['startup'])
    expect(out).toContain('WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.')
    expect(out).toContain(report)
    expect(out).not.toContain('raw diagnostics with a value')
  })

  it('follows new records across a rotation until stopped', async () => {
    const root = newHome()
    const { log, logger, location } = writer(root)
    logger.info('before')
    const controller = new AbortController()
    let printed = ''
    const following = logs(root, ['home', '--follow', '-n', '1'], { signal: controller.signal, onOut: (text) => { printed += text } })
    await vi.waitFor(() => { expect(printed).toContain('before') })
    logger.info('after one')
    log.close()
    renameSync(location.file, rotatedFile(location, 1))
    logger.info('after rotation')
    await vi.waitFor(() => { expect(printed).toContain('after rotation') }, { timeout: 3000 })
    controller.abort()
    const { code } = await following
    expect(code).toBe(0)
    expect(printed.split('\n').filter(Boolean).map(line => line.split(' ').slice(3).join(' '))).toEqual(['before', 'after one', 'after rotation'])
  })

  it('clears after confirmation only, a surface or every local log with the startup reports', async () => {
    const root = newHome()
    const home1 = writer(root)
    const desktop = writer(root, 'desktop-host')
    home1.logger.info('home record')
    desktop.logger.info('desktop record')
    const report = join(root, 'logs', 'startup-2026-11-01.log')
    writeFileSync(report, 'raw\n', { mode: 0o600 })

    const declined = await logs(root, ['--clear', 'home'], { confirm: false })
    expect(declined.code).toBe(1)
    expect(declined.asked).toEqual(['Delete the rotated files and empty the active file of the home-default log? The records cannot be recovered.'])
    expect(readFileSync(home1.location.file, 'utf8')).toContain('home record')

    const one = await logs(root, ['--clear', 'home'], { confirm: true })
    expect(one.code).toBe(0)
    expect(one.out).toBe(`emptied ${home1.location.file}\n`)
    expect(readFileSync(desktop.location.file, 'utf8')).toContain('desktop record')

    const all = await logs(root, ['--clear'], { confirm: true })
    expect(all.asked[0]).toContain('every local operational log and upstream\'s startup reports')
    expect(all.out).toContain(`emptied ${desktop.location.file}`)
    expect(all.out).toContain(`deleted ${report}`)
    expect(existsSync(report)).toBe(false)
    expect(readFileSync(desktop.location.file, 'utf8')).toBe('')
  })

  it('prunes every expired file of every local surface with --prune and prints each', async () => {
    const root = newHome()
    const old = writer(root, 'supervisor')
    old.time.now = NOW - 15 * DAY
    old.logger.info('expired')
    old.log.close()
    const fresh = writer(root)
    fresh.logger.info('fresh')
    const { code, out } = await logs(root, ['--prune'])
    expect(code).toBe(0)
    expect(out).toBe(`deleted ${old.location.file}\n`)
    expect(existsSync(fresh.location.file)).toBe(true)
    expect((await logs(root, ['--prune'])).out).toBe('No log file is older than the retention period.\n')
  })

  it('refuses a log file another user could read, with the fix', async () => {
    const root = newHome()
    const { logger, location } = writer(root)
    logger.info('x')
    chmodSync(location.file, 0o644)
    const { code, err } = await logs(root, ['home'])
    expect(code).toBe(1)
    expect(err).toContain(`fix: chmod 600 ${location.file}`)
  })

  it.each([
    [['nope']],
    [['home', 'supervisor']],
    [['-n', '0']],
    [['-n', '10001']],
    [['--since', '5 minutes']],
    [['--turn', '-1']],
    [['--clear', '--prune']],
    [['--prune', 'home']],
    [['--profile', '../x']],
    [['--unknown']],
    [['--clear', 'relay']],
    [['startup', '--path']],
  ])('exits 2 with the usage for %j', async (argv) => {
    const { code, err } = await logs(newHome(), argv)
    expect(code).toBe(2)
    expect(err).toMatch(/^delorun logs: /)
  })

  it('shows control characters from captured output escaped', () => {
    expect(formatRecord({ ts: 't', level: 'info', surface: 'home-default', pid: 1, logger: 'stdout', source: 'captured', msg: 'red \u001b[31m text\u0007' })).toBe('t info home-default red \\u001b[31m text\\u0007')
  })
})

describe('delorun logs in the command table', () => {
  async function delorun(argv: readonly string[], env: Record<string, string>): Promise<Run> {
    let out = ''
    let err = ''
    const code = await main(argv, { env, stdout: (text) => { out += text }, stderr: (text) => { err += text } })
    return { code: code ?? -1, out, err, asked: [] }
  }

  it('resolves the home and the profile from the environment and creates nothing', async () => {
    const root = newHome()
    const { code, out } = await delorun(['logs', '--path'], { DELO_HOME: root, DELO_PROFILE: 'work' })
    expect(code).toBe(0)
    expect(out).toBe(`${join(root, 'logs', 'home-work', 'home.log')}\n`)
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect((await delorun(['logs', '--path', '--profile=other'], { DELO_HOME: root })).out).toBe(`${join(root, 'logs', 'home-other', 'home.log')}\n`)
  })

  it('refuses the desktop profile and declines a clear without a terminal', async () => {
    const root = newHome()
    expect((await delorun(['logs', '--profile', 'desktop'], { DELO_HOME: root })).code).toBe(2)
    const cleared = await delorun(['logs', '--clear'], { DELO_HOME: root })
    expect(cleared.code).toBe(1)
    expect(cleared.err).toContain('needs a terminal')
  })
})
