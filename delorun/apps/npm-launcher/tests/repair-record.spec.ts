/**
 * The mark `delorun repair` keeps in `run/repair.json`: while it stands, no launcher start runs, whatever the profile,
 * and a mark left by a repair that died is reported and removed.
 */
// spec-lanes-allow: one short-lived child that has exited gives a process id no process holds.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { StorePaths, type LaunchCommand, type LaunchPlan, type VerifiedRuntime } from '@delorun/runtime-store'
import { fixtureRelease, type Fixture } from '../../install/tests/support.ts'
import { isRuntimesSetAsideName } from '@delorun/update/home-data'
import { runLauncher, type LauncherOptions, type LauncherStore } from '../src/launcher.ts'
import { beginRepairRecord, quoteForShell, repairRecordPath, resolveRepairMarkGraceSeconds, staleRepairText } from '../src/repair-record.ts'
import { runRepair, type RepairChannel, type RepairOptions, type RepairStore } from '../src/repair.ts'

const version = (text: string): RuntimeVersion => text as RuntimeVersion
const NOW = new Date('2026-11-13T12:00:00Z')
const GRACE = 5

/** A process id that no process has: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 })
  if (child.pid === undefined) throw new Error('the spec could not start a child process')
  return child.pid
}

describe('the repair mark', () => {
  let home: string
  let spawned: LaunchCommand[]
  let err: string[]
  let fixture: Fixture

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'delorun-repair-mark-'))
    fixture = await fixtureRelease()
    await mkdir(join(home, 'trust'), { mode: 0o700 })
    await writeFile(join(home, 'trust/root.json'), fixture.roots[0]!, { mode: 0o600 })
    spawned = []
    err = []
    await mkdir(join(home, 'run'), { recursive: true })
  })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  /** A launch of `profile` whose store holds an installed runtime and whose spawn is recorded. */
  function launch(profile: string): LauncherOptions {
    const store: LauncherStore = {
      prepareLaunch: (): Promise<LaunchPlan> => Promise.resolve({ command: 'node', args: ['entry.js'], env: {}, version: version('0.1.0'), check: { full: true, hashed: 0, files: 0, fullCheckAt: 1_700_000_000_000 } }),
      install: () => Promise.reject(new Error('a start installs nothing here')),
      retain: () => Promise.resolve({ removed: [], failed: [] }),
      pointers: () => Promise.reject(new Error('no pointers')),
      checkRuntime: () => Promise.reject(new Error('no check')),
      launchCommand: () => { throw new Error('no command') },
    }
    return {
      home, profile, platform: 'linux-x64', args: [], passedThrough: [], mode: 'enforce', fullCheckDays: 7, repairMarkGraceSeconds: GRACE, store,
      identity: { version: '0.3.0', path: '/launcher', now: () => 1_800_000_000_000 },
      channel: { resolve: () => Promise.reject(new Error('no channel')), fill: () => Promise.reject(new Error('no channel')) },
      roots: fixture.roots, logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
      spawn: (command) => { spawned.push(command); return Promise.resolve(0) },
      output: { stdout: () => undefined, stderr: text => void err.push(text) },
    }
  }

  it('starts when no repair is recorded', async () => {
    expect(await runLauncher(launch('default'))).toBe(0)
    expect(spawned).toHaveLength(1)
  })

  it('refuses the start of a brand-new profile while a repair runs, and starts once it ends', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    expect(existsSync(join(home, 'run/brand-new'))).toBe(false)
    expect(await runLauncher(launch('brand-new'))).toBe(1)
    expect(spawned).toEqual([])
    expect(err.join('')).toContain('Delorun is being repaired; wait for it to finish.')
    expect(err.join('')).toContain('REPAIR_RUNNING')
    await end()
    expect(await runLauncher(launch('brand-new'))).toBe(0)
    expect(spawned).toHaveLength(1)
  })

  it('reports and removes a mark whose repair died, then starts', async () => {
    await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
    expect(await runLauncher(launch('default'))).toBe(0)
    expect(err.join('')).toContain('A repair that began 2026-11-13T11:00:00.000Z ended without finishing')
    // Pins the recorded path: a mark with no set-aside folder names no restore, and never one that deletes.
    expect(err.join('')).toContain('nothing to put back. Run delorun repair again.')
    expect(err.join('')).not.toContain('rm -rf')
    expect(existsSync(repairRecordPath(home))).toBe(false)
  })

  describe('the restore command of a stale mark', () => {
    const record = (setAside: string | undefined) => ({ pid: 1, startedAt: '2026-11-13T11:00:00.000Z', ...setAside === undefined ? {} : { setAside } }) as never

    it('names no restore when the recorded folder is missing, even with older set-aside folders present', async () => {
      await mkdir(join(home, 'runtimes.set-aside-20260101T000000Z'))
      const text = await staleRepairText(record(join(home, 'runtimes.set-aside-20261113T120000Z')), home, NOW, 'linux')
      expect(text).toContain('Run delorun repair again.')
      expect(text).not.toMatch(/\bmv\b|rm /)
    })

    it('quotes a home path with $, double quotes, backticks and a single quote, and moves rather than deletes', async () => {
      const odd = join(home, 'a$HOME"b`id`\'c')
      await mkdir(join(odd, 'runtimes'), { recursive: true })
      await writeFile(join(odd, 'runtimes/new'), 'half')
      const setAside = join(odd, 'runtimes.set-aside-20261113T120000Z')
      await mkdir(setAside)
      await writeFile(join(setAside, 'old'), 'good')
      const text = await staleRepairText(record(setAside), odd, NOW, 'linux')
      expect(text).not.toContain('rm ')
      const command = /: (mv .*)\. delorun recover status/.exec(text)?.[1]
      if (command === undefined) throw new Error(`no command in ${text}`)
      // Pins the quoting: unquoted or double-quoted, the shell expands $HOME and runs `id`, and the moves miss.
      execFileSync('sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' }, timeout: 10_000 })
      expect(await readFile(join(odd, 'runtimes/old'), 'utf8')).toBe('good')
      expect(await readFile(join(odd, 'runtimes.set-aside-20261113T120000Z-1/new'), 'utf8')).toBe('half')
    })

    it('names the unfinished store as a set-aside folder that recover status lists and recover discard accepts', async () => {
      const setAside = join(home, 'runtimes.set-aside-20261113T120000Z')
      await mkdir(setAside)
      await mkdir(join(home, 'runtimes'))
      const text = await staleRepairText(record(setAside), home, NOW, 'linux')
      const unfinished = /keeping the unfinished store in (\S+):/u.exec(text)?.[1]
      if (unfinished === undefined) throw new Error(`no folder named in ${text}`)
      expect(isRuntimesSetAsideName(unfinished)).toBe(true)
      expect(isRuntimesSetAsideName(basename(setAside))).toBe(true)
      expect(unfinished).not.toBe(basename(setAside))
    })

    it('moves only the set-aside folder back when no store stands, and writes PowerShell on Windows', async () => {
      const setAside = join(home, 'runtimes.set-aside-20261113T120000Z')
      await mkdir(setAside)
      const posix = await staleRepairText(record(setAside), home, NOW, 'linux')
      expect(posix.match(/\bmv\b/g)).toHaveLength(1)
      const windows = await staleRepairText(record(setAside), home, NOW, 'win32')
      expect(windows).toContain(`Move-Item -LiteralPath '${setAside}' -Destination '${join(home, 'runtimes')}'`)
      expect(windows).not.toMatch(/Remove-Item|\bmv\b/)
      expect(await staleRepairText(record(join(home, "it's")), home, NOW, 'win32')).toContain('Run delorun repair again.')
    })

    it('records the set-aside path in the mark before a repair moves the store', async () => {
      const { noteSetAside, end } = await beginRepairRecord(home, NOW, GRACE)
      await noteSetAside(join(home, 'runtimes.set-aside-x'))
      expect(JSON.parse(await readFile(repairRecordPath(home), 'utf8')).setAside).toBe(join(home, 'runtimes.set-aside-x'))
      await end()
    })
  })

  it('removes an old mark that is not a record, without refusing the start', async () => {
    await writeFile(repairRecordPath(home), 'not json')
    const old = new Date(Date.now() - 60_000)
    await utimes(repairRecordPath(home), old, old)
    expect(await runLauncher(launch('default'))).toBe(0)
    expect(existsSync(repairRecordPath(home))).toBe(false)
  })

  it('refuses the start, and keeps the file, while a file that is not a record yet is younger than the grace', async () => {
    await writeFile(repairRecordPath(home), '{"pid": 12')
    expect(await runLauncher(launch('default'))).toBe(1)
    expect(spawned).toEqual([])
    expect(err.join('')).toContain('REPAIR_RUNNING')
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe('{"pid": 12')
  })

  it('refuses a second repair while a young unparsable mark stands, and replaces nothing', async () => {
    await writeFile(repairRecordPath(home), '{"pid": 12')
    await expect(beginRepairRecord(home, new Date(), GRACE)).rejects.toThrow('is writing its mark')
    expect(await readFile(repairRecordPath(home), 'utf8')).toBe('{"pid": 12')
  })

  it('writes the mark whole under its name and leaves no temporary file', async () => {
    const { end } = await beginRepairRecord(home, NOW, GRACE)
    expect(JSON.parse(await readFile(repairRecordPath(home), 'utf8'))).toMatchObject({ startedAt: NOW.toISOString() })
    expect((await readdir(join(home, 'run'))).filter(name => name.includes('.tmp-'))).toEqual([])
    await end()
  })

  it('validates the grace', () => {
    expect(resolveRepairMarkGraceSeconds(undefined)).toBe(5)
    expect(resolveRepairMarkGraceSeconds('12')).toBe(12)
    for (const bad of ['0', '61', '1.5', 'soon']) expect(() => resolveRepairMarkGraceSeconds(bad)).toThrow('DELORUN_REPAIR_MARK_GRACE_SECONDS')
  })

  it('refuses a second repair while one runs and keeps the first mark', async () => {
    const first = await beginRepairRecord(home, NOW, GRACE)
    await expect(beginRepairRecord(home, NOW, GRACE)).rejects.toThrow('another repair runs')
    expect(existsSync(repairRecordPath(home))).toBe(true)
    await first.end()
    expect(existsSync(repairRecordPath(home))).toBe(false)
  })

  describe('during delorun repair', () => {
    beforeEach(async () => {
      await mkdir(join(home, 'runtimes'), { recursive: true })
      await writeFile(join(home, 'runtimes/store.json'), 'old store')
    })

    function repairOptions(install: RepairStore['install']): RepairOptions {
      const paths = new StorePaths(home, 'linux-x64')
      const channel: RepairChannel = {
        resolve: () => Promise.resolve({ version: version('0.1.1'), root: fixture.rootMetadata }),
        fill: () => Promise.reject(new Error('the fake store does not fill')),
        recordInstalled: () => Promise.resolve(),
      }
      return {
        home, profile: 'default', line: { restoreCopy: false, resetTrust: false }, roots: fixture.roots,
        store: { paths, pointers: () => Promise.resolve({ current: version('0.1.0') }), install },
        channel, confirm: () => Promise.resolve(true), startCheck: () => Promise.resolve(),
        output: { stdout: () => undefined, stderr: text => void err.push(text) }, now: () => NOW, releaseChannel: 'stable', repairMarkGraceSeconds: GRACE,
      }
    }

    it('refuses the start of a profile that has no run directory, and removes the mark when the repair ends', async () => {
      const attempts: number[] = []
      const install: RepairStore['install'] = async () => {
        expect(existsSync(repairRecordPath(home))).toBe(true)
        attempts.push(await runLauncher(launch('brand-new')))
        return { version: version('0.1.1'), manifest: { dsh: '0.2.2' } } as VerifiedRuntime
      }
      expect(await runRepair(repairOptions(install))).toBe(0)
      expect(attempts).toEqual([1])
      expect(spawned).toEqual([])
      expect(err.join('')).toContain('Delorun is being repaired; wait for it to finish.')
      expect(existsSync(repairRecordPath(home))).toBe(false)
    })

    it('removes the mark when the repair fails', async () => {
      expect(await runRepair(repairOptions(() => Promise.reject(new Error('the disk filled'))))).toBe(1)
      expect(existsSync(repairRecordPath(home))).toBe(false)
    })

    it('reports the mark of a dead repair, removes it, and goes on', async () => {
      await writeFile(repairRecordPath(home), `${JSON.stringify({ pid: deadPid(), startedAt: '2026-11-13T11:00:00.000Z' })}\n`)
      const install: RepairStore['install'] = () => Promise.reject(new Error('stop here'))
      await runRepair(repairOptions(install))
      expect(err.join('')).toContain('ended without finishing')
      expect(await readFile(join(home, 'logs/repair.log'), 'utf8')).toContain('staleRepair')
    })

    it('refuses to repair while another repair of the home runs', async () => {
      const other = await beginRepairRecord(home, NOW, GRACE)
      expect(await runRepair(repairOptions(() => Promise.reject(new Error('never reached'))))).toBe(1)
      expect(err.join('')).toContain('REPAIR_RUNNING')
      expect(existsSync(repairRecordPath(home))).toBe(true)
      await other.end()
    })
  })
})

describe('quoting a path for the person\'s shell', () => {
  const smart = '\u2018\u2019\u201A\u201B'

  it('doubles every character PowerShell reads as a single quote', () => {
    // Pins the typographic quotes: PowerShell ends the string at U+2018 to U+201B, so a path holding one would break out.
    expect(quoteForShell('C:\\Users\\O\u2019Brien\\.delorun', 'win32')).toBe("'C:\\Users\\O\u2019\u2019Brien\\.delorun'")
    expect(quoteForShell(`a'${smart}b`, 'win32')).toBe(`'a''${[...smart].map(c => c + c).join('')}b'`)
  })

  it('leaves the POSIX form to the ASCII quote', () => {
    expect(quoteForShell(`a'${smart}b`, 'linux')).toBe(`'a'\\''${smart}b'`)
  })
})
