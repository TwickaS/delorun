import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isNodeExecutable, linuxScopeUnit, linuxStartTime, nodeScript, programRecordPath, ProgramRecords, systemProcessTable, type ProcessIdentity, type ProcessTable } from '../src/reap.ts'

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

  /** Identities a process shows before its table entry, read one per call: how a scope start looks. */
  readonly starting = new Map<number, ProcessIdentity[]>()

  async identify(pid: number): Promise<ProcessIdentity | undefined> {
    return this.starting.get(pid)?.shift() ?? this.processes.get(pid)
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
function records(test: { onTestFinished: (fn: () => void) => void }, table: ProcessTable, settleMs = 2_000, located: readonly string[] = [claude.exe]): { readonly records: ProgramRecords, readonly warnings: string[], readonly path: string } {
  const home = mkdtempSync(join(tmpdir(), 'ea1-gate-reap-'))
  test.onTestFinished(() => rmSync(home, { recursive: true, force: true }))
  const warnings: string[] = []
  const path = programRecordPath(home)
  return { records: new ProgramRecords({ path, table, graceMs: 5, settleMs, located: () => new Set(located), warn: message => warnings.push(message) }), warnings, path }
}

const run = promisify(execFile)

/**
 * Whether this machine has a user systemd that can start a scope.
 * @returns true when `systemctl --user` answers running or degraded.
 */
async function userSystemd(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    const { stdout } = await run('systemctl', ['--user', 'is-system-running'])
    return /^(?:running|degraded)/u.test(stdout)
  } catch (error) {
    // `is-system-running` exits non-zero when degraded; its output still names the state.
    const stdout: unknown = Reflect.get(Object(error), 'stdout')
    return typeof stdout === 'string' && /^degraded/u.test(stdout)
  }
}

const hasUserSystemd = await userSystemd()

/**
 * Write a record file naming one Codex program, as a forged or older record would read.
 * @param path - the record file.
 * @param identity - the identity it names.
 */
function writeRecord(path: string, identity: ProcessIdentity): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ v: 1, programs: [{ provider: 'codex', identity }] }), { mode: 0o600 })
}

describe('a Node leader is told apart by the script it runs (review P2)', () => {
  const node = { pid: 5151, startTime: '777', bootId: 'b-1', exe: '/usr/bin/node', script: '/profile/node_modules/@openai/codex/bin/codex.js' }

  it('reads the script past Node options and their values', () => {
    expect(nodeScript(['/usr/bin/node', '/a/codex.js', 'exec'])).toBe('/a/codex.js')
    expect(nodeScript(['node', '--import', 'file:///tsx/esm.mjs', '--no-warnings', '/r/bin.ts', '--', 'x'])).toBe('/r/bin.ts')
    expect(nodeScript(['node', '-r', 'hook.cjs', '--', '/w/watcher.mjs'])).toBe('/w/watcher.mjs')
    expect(nodeScript(['node', '-e', 'setTimeout(() => {}, 1e6)'])).toBeUndefined()
    expect(nodeScript(['node'])).toBeUndefined()
    expect([isNodeExecutable('/opt/node/bin/node'), isNodeExecutable('C:\\node\\node.exe'), isNodeExecutable('/usr/bin/nodemon')]).toEqual([true, true, false])
  })

  it.for([
    ['another script', { script: '/home/someone/server.js' }],
    ['no script', { script: undefined }],
  ] as const)('never stops a Node process whose record names %s', async ([, change], test) => {
    const table = new FakeTable()
    table.processes.set(node.pid, node)
    const { path } = records(test, table)
    writeRecord(path, { ...node, ...change })
    const after = new ProgramRecords({ path, table, graceMs: 5, settleMs: 5, located: () => new Set([node.exe]), warn: () => {} })
    expect((await after.reap()).map(done => done.outcome)).toEqual(['not-the-program'])
    expect(table.calls).toEqual([])
  })

  it('stops a Node program whose script still matches', async (test) => {
    const table = new FakeTable()
    table.processes.set(node.pid, node)
    const { path } = records(test, table)
    writeRecord(path, node)
    const after = new ProgramRecords({ path, table, graceMs: 5, settleMs: 5, located: () => new Set([node.exe]), warn: () => {} })
    expect((await after.reap()).map(done => done.outcome)).toEqual(['stopped-group'])
  })

  it('records a scoped Node program once the subprocess runner has handed over to it', async (test) => {
    const table = new FakeTable()
    const unit = 'dsh-subprocess-cd34.scope'
    table.starting.set(node.pid, [
      { ...node, exe: '/usr/bin/systemd-run', script: undefined },
      { ...node, unit, script: '/repo/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js' },
    ])
    table.processes.set(node.pid, { ...node, unit })
    const { records: one } = records(test, table)
    expect(await one.started('codex', node.pid, unit)).toEqual({ ...node, unit })
  })

  it.skipIf(process.platform !== 'linux')('reads a real Node process\'s script from its command line', async (test) => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ea1-gate-node-')))
    const script = join(folder, 'wait.mjs')
    writeFileSync(script, 'setTimeout(() => {}, 30_000)\n')
    const child = spawn(process.execPath, ['--no-warnings', script], { stdio: 'ignore' })
    test.onTestFinished(() => {
      child.kill('SIGKILL')
      rmSync(folder, { recursive: true, force: true })
    })
    const table = systemProcessTable('linux', async argv => (await run(argv[0]!, argv.slice(1))).stdout)
    await expect.poll(async () => (await table.identify(child.pid!))?.script).toBe(script)
    expect((await table.identify(child.pid!))?.exe).toBe(realpathSync(process.execPath))
  })
})

describe('reaping only located programs (review P3)', () => {
  it('never stops a matching record whose executable is not a located agent program', async (test) => {
    const table = new FakeTable()
    const vim = { ...claude, exe: '/usr/bin/vim' }
    table.processes.set(vim.pid, vim)
    const { records: one, path } = records(test, table)
    await one.started('claude-code', vim.pid)
    const after = new ProgramRecords({ path, table, graceMs: 5, settleMs: 5, located: () => new Set([claude.exe]), warn: () => {} })
    expect((await after.reap()).map(done => done.outcome)).toEqual(['not-located'])
    expect(table.calls).toEqual([])
    expect(table.processes.has(vim.pid)).toBe(true)
  })
})

describe('a program the subprocess owner starts in a systemd scope (review P2)', () => {
  const scoped = { ...claude, unit: 'dsh-subprocess-ab12.scope' }

  it('records the program once it has left systemd-run and entered the handle\'s unit, never systemd-run itself', async (test) => {
    const table = new FakeTable()
    table.starting.set(claude.pid, [
      { ...claude, exe: '/usr/bin/systemd-run', unit: undefined },
      { ...claude, exe: '/usr/bin/systemd-run', unit: 'dsh-subprocess-ab12.scope' },
    ])
    table.processes.set(claude.pid, scoped)
    const { records: one } = records(test, table)
    expect(await one.started('claude-code', claude.pid, 'dsh-subprocess-ab12.scope')).toEqual(scoped)
  })

  it('records nothing for a process that never enters the handle\'s unit in time', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, { ...claude, exe: '/usr/bin/systemd-run', unit: undefined })
    const { records: one, warnings, path } = records(test, table, 50)
    expect(await one.started('claude-code', claude.pid, 'dsh-subprocess-ab12.scope')).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(() => readFileSync(path)).toThrow()
  })

  it.skipIf(!hasUserSystemd)('records a real scoped process as the program in its unit, and stops that unit at the next start', async (test) => {
    const unit = `dsh-subprocess-ea1gate${randomUUID().slice(0, 8)}.scope`
    const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sleep', '30'], { stdio: 'ignore', detached: true })
    test.onTestFinished(async () => {
      await run('systemctl', ['--user', 'stop', unit]).catch(() => undefined)
      child.kill('SIGKILL')
    })
    const table = systemProcessTable('linux', async argv => (await run(argv[0]!, argv.slice(1))).stdout)
    const sleep = realpathSync((await run('sh', ['-c', 'command -v sleep'])).stdout.trim())
    const { records: one, path } = records(test, table, 2_000, [sleep])
    const identity = await one.started('claude-code', child.pid!, unit)
    expect(identity).toMatchObject({ pid: child.pid, unit, exe: sleep })
    const after = new ProgramRecords({ path, table, graceMs: 5, settleMs: 5, located: () => new Set([sleep]), warn: () => {} })
    expect((await after.reap()).map(done => done.outcome)).toEqual(['stopped-unit'])
    await expect.poll(async () => (await table.identify(child.pid!)) === undefined, { timeout: 5_000 }).toBe(true)
  })
})

describe('reaping programs a dead Host left behind', () => {
  it('stops a recorded program whose identity still matches, SIGTERM then SIGKILL, and clears the record', async (test) => {
    const table = new FakeTable()
    table.processes.set(claude.pid, claude)
    const { records: one, path } = records(test, table)
    expect(await one.started('claude-code', claude.pid)).toEqual(claude)
    expect((readFileSync(path).length)).toBeGreaterThan(0)

    table.honoursTerm = false
    const after = new ProgramRecords({ path, table, graceMs: 5, settleMs: 5, located: () => new Set([claude.exe]), warn: () => {} })
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
