import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linuxScopeUnit, linuxStartTime, programRecordPath, ProgramRecords, systemProcessTable, type ProcessIdentity, type ProcessTable } from '../src/reap.ts'

/** A fake process table: live processes by id, and every signal and unit stop it was asked for. */
class FakeTable implements ProcessTable {
  readonly platform: NodeJS.Platform
  readonly processes = new Map<number, ProcessIdentity>()
  readonly calls: string[] = []
  /** Whether a process leaves on SIGTERM. */
  honoursTerm = true

  constructor(platform: NodeJS.Platform = 'linux') {
    this.platform = platform
  }

  async identify(pid: number): Promise<ProcessIdentity | undefined> {
    return this.processes.get(pid)
  }

  killGroup(pgid: number, signal: NodeJS.Signals): void {
    this.calls.push(`kill -${pgid} ${signal}`)
    if (signal === 'SIGKILL' || this.honoursTerm) this.processes.delete(pgid)
  }

  async stopUnit(unit: string): Promise<void> {
    this.calls.push(`stop ${unit}`)
  }
}

const claude: ProcessIdentity = { pid: 4242, startTime: '81234', bootId: 'b-1', exe: '/opt/claude/claude' }

/**
 * @param test - the running test, whose teardown removes the home.
 * @param table - the process table.
 * @returns the records, the warnings and the record file's path.
 */
function records(test: { onTestFinished: (fn: () => void) => void }, table: ProcessTable): { readonly records: ProgramRecords, readonly warnings: string[], readonly path: string } {
  const home = mkdtempSync(join(tmpdir(), 'ea1-gate-reap-'))
  test.onTestFinished(() => rmSync(home, { recursive: true, force: true }))
  const warnings: string[] = []
  const path = programRecordPath(home)
  return { records: new ProgramRecords({ path, table, graceMs: 5, warn: message => warnings.push(message) }), warnings, path }
}

describe('reaping programs a dead Host left behind', () => {
  it('stops a recorded program whose identity still matches, SIGTERM then SIGKILL, and clears the record', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one, path } = records(test, table)
    expect(await one.started('claude-code', claude.pid)).toEqual(claude)
    expect((readFileSync(path).length)).toBeGreaterThan(0)

    table.honoursTerm = false
    const after = new ProgramRecords({ path, table, graceMs: 5, warn: () => {} })
    expect((await after.reap()).map(done => done.outcome)).toEqual(['stopped-group'])
    expect(table.calls).toEqual(['kill -4242 SIGTERM', 'kill -4242 SIGKILL'])
    expect(await after.reap()).toEqual([])
  })

  it('sends no SIGKILL to a program that left on SIGTERM', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one } = records(test, table)
    await one.started('claude-code', claude.pid)
    await one.reap()
    expect(table.calls).toEqual(['kill -4242 SIGTERM'])
  })

  it.for([
    ['start time', { startTime: '99999' }],
    ['boot id', { bootId: 'b-2' }],
    ['executable path', { exe: '/usr/bin/vim' }],
    ['unit', { unit: 'dsh-subprocess-x.scope' }],
  ] as const)('never signals a reused process id whose %s differs', async ([, change], test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one } = records(test, table)
    await one.started('claude-code', claude.pid)
    table.processes.set(claude.pid, { ...claude, ...change })
    expect((await one.reap()).map(done => done.outcome)).toEqual(['not-the-program'])
    expect(table.calls).toEqual([])
    expect(await one.reap()).toEqual([])
  })

  it('drops the record of a program that is gone, with no signal', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one } = records(test, table)
    await one.started('claude-code', claude.pid)
    table.processes.delete(claude.pid)
    expect((await one.reap()).map(done => done.outcome)).toEqual(['gone'])
    expect(table.calls).toEqual([])
  })

  it('stops the recorded systemd scope instead of signalling the group', async (test) => {
    const table = new FakeTable()
    const scoped = { ...claude, unit: 'dsh-subprocess-ab12.scope' }
    table.processes.set(claude.pid, scoped)
    const { records: one } = records(test, table)
    await one.started('codex', claude.pid)
    expect((await one.reap()).map(done => done.outcome)).toEqual(['stopped-unit'])
    expect(table.calls).toEqual(['stop dsh-subprocess-ab12.scope'])
  })

  it('records and reaps nothing on Windows', async (test) => {
    const table = new FakeTable('win32')
    table.processes.set(claude.pid, claude)
    const { records: one, path } = records(test, table)
    expect(await one.started('claude-code', claude.pid)).toBeUndefined()
    expect(await one.reap()).toEqual([])
    expect(() => readFileSync(path)).toThrow()
    expect(table.calls).toEqual([])
  })

  it('records nothing for a process whose identity cannot be read, and says so', async (test) => {
    const table = new FakeTable()
    const { records: one, warnings } = records(test, table)
    expect(await one.started('claude-code', 7)).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('process 7 could not be read')])
    expect(await one.reap()).toEqual([])
  })

  it('forgets a program that ended, so the next start does not stop the id', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one } = records(test, table)
    const identity = await one.started('claude-code', claude.pid)
    await one.ended(identity!)
    expect(await one.reap()).toEqual([])
    expect(table.calls).toEqual([])
  })

  it('reaps nothing from an unreadable or unknown record file and leaves it in place', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one, warnings, path } = records(test, table)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    for (const text of ['not json', JSON.stringify({ v: 2, programs: [{ provider: 'claude-code', identity: claude }] })]) {
      writeFileSync(path, text, { mode: 0o600 })
      expect(await one.reap()).toEqual([])
      expect(readFileSync(path, 'utf8')).toBe(text)
    }
    expect(table.calls).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('reads the start time after a command name with spaces and parentheses, and the subprocess owner\'s scope', () => {
    const fields = Array.from({ length: 50 }, (_unused, index) => String(index + 3))
    expect(linuxStartTime(`4242 (node (x) y) ${fields.join(' ')}`)).toBe('22')
    expect(linuxStartTime('4242 node')).toBeUndefined()
    expect(linuxScopeUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-subprocess-ab12.scope\n')).toBe('dsh-subprocess-ab12.scope')
    expect(linuxScopeUnit('0::/user.slice/user-1000.slice/session-2.scope\n')).toBeUndefined()
  })

  it.runIf(process.platform === 'linux')('reads this process\'s identity on Linux and none for an id no process has', async () => {
    const table = systemProcessTable('linux', () => Promise.reject(new Error('no command runs on Linux identity reads')))
    const own = await table.identify(process.pid)
    expect(own).toMatchObject({ pid: process.pid, exe: realpathSync(process.execPath) })
    expect(own?.startTime).toMatch(/^\d+$/u)
    expect(own?.bootId).toMatch(/^[\da-f-]{36}$/u)
    expect(await table.identify(2 ** 22 + 1)).toBeUndefined()
  })

  it('reads a macOS identity from ps, and none when ps finds no process or no absolute path', async () => {
    const answers = new Map([['lstart', 'Tue Nov 17 10:00:01 2026\n'], ['comm', '/opt/codex/codex\n']])
    const run = async (argv: readonly string[]): Promise<string> => answers.get(argv[2]!.replace('=', '')) ?? ''
    expect(await systemProcessTable('darwin', run).identify(9)).toEqual({ pid: 9, startTime: 'Tue Nov 17 10:00:01 2026', exe: '/opt/codex/codex' })
    answers.set('comm', 'codex\n')
    expect(await systemProcessTable('darwin', run).identify(9)).toBeUndefined()
    expect(await systemProcessTable('darwin', () => Promise.reject(new Error('exit 1'))).identify(9)).toBeUndefined()
  })
})
