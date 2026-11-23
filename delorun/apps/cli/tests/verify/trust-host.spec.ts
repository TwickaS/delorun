/**
 * The trust bill's source in a running Host (`delorun/apps/cli/src/verify/trust-host.ts`): `read` produces the start bill
 * once and answers it after, producing it again only after a failure; `check` runs the `verify` stage each time with
 * the clock read then and logs its warnings and notices; and `watchTrust` attaches the source to the `delorunTrust`
 * service whenever the service is present.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { getPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DELORUN_START_CHECK_ENV } from '@delorun/contract-home-layout'
import { START_CHECK_SCHEMA, startCheckHandoffText } from '@delorun/runtime-store'
import type { TrustSource } from '@delorun/bundle-local/trust'
import { TRUST_BILL_SCHEMA, type TrustBill } from '@delorun/bundle-local/trust-bill'
import type { DelorunLogger } from '@delorun/logs'
import type { BillContext } from '../../src/verify/bill.ts'
import type { ReleaseCheckOutcome } from '../../src/verify/checks.ts'
import { BACKGROUND_NICE, billOfVerifyOutput, childRunner, hostTrustOptions, launcherVerifyCommand, runChild, trustSource, watchTrust, type ChildRun, type RunChild, type TrustStages, type TrustWatchOptions } from '../../src/verify/trust-host.ts'

/**
 * A bill of one stage.
 * @param stage - the stage.
 * @returns the bill.
 */
function bill(stage: TrustBill['stage']): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage,
    generatedAt: '2026-11-11T10:00:00Z',
    release: {
      version: '0.1.0', commit: null, manifestSha256: null, fileListSha256: null, root: null,
      launcher: { version: null, path: null }, lastFullHashAt: null, startCheck: null, signature: 'unknown', files: 'unknown',
    },
    releaseLog: { state: 'unknown', lastAttempt: null, uncheckedSince: null },
    plugins: { status: 'unknown', entries: [] },
    changes: { status: 'unknown', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
  }
}

/** A logger that keeps its lines. */
function logger(): DelorunLogger & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    error: (message) => { lines.push(`error ${message}`) },
    warn: (message) => { lines.push(`warn ${message}`) },
    info: (message) => { lines.push(`info ${message}`) },
    debug: () => undefined,
  }
}

/**
 * The options of a Host, with a clock that advances one second per read.
 * @param log - the home log.
 * @returns the options.
 */
function options(log: DelorunLogger): TrustWatchOptions {
  let now = 1_800_000_000
  return {
    home: '/home/person/.delorun', profile: 'default', platform: 'linux-x64', running: '0.1.0', env: { DELORUN_START_CHECK: 'x' },
    node: process.execPath, logger: log, fetch: globalThis.fetch, now: () => now++, elapsed: () => 0,
  }
}

/**
 * Stages whose answers the test controls, recording each context they were given.
 * @param start - what the start stage does.
 * @returns the stages and the contexts.
 */
function stages(start: () => Promise<TrustBill> = async () => bill('start'), launcher: RunChild = () => Promise.reject(new Error('no launcher may run'))) {
  const contexts: { readonly stage: string, readonly context: BillContext }[] = []
  const outcome: ReleaseCheckOutcome = {
    results: [], root: undefined, launcher: undefined, onlineOnly: true, recorded: undefined, origins: undefined,
    warnings: ['the release log was not reached'], notices: ['a newer root is stored'],
  }
  const value: TrustStages = {
    start: (context) => { contexts.push({ stage: 'start', context }); return start() },
    verify: async (context, verifyOptions) => {
      contexts.push({ stage: 'verify', context })
      expect(verifyOptions.release).toBeUndefined()
      return { bill: bill('verify'), outcome }
    },
    launcher,
  }
  return { stages: value, contexts }
}

describe('the trust source', () => {
  it('produces the start bill once, with the Host\'s context', async () => {
    const { stages: value, contexts } = stages()
    const source = trustSource(options(logger()), value)
    expect((await source.read()).stage).toBe('start')
    expect((await source.read()).stage).toBe('start')
    expect(contexts).toEqual([{ stage: 'start', context: { home: '/home/person/.delorun', profile: 'default', platform: 'linux-x64', running: '0.1.0', env: { DELORUN_START_CHECK: 'x' }, now: 1_800_000_000 } }])
  })

  it('gives the running Host\'s start bill the plugin install check and Changes, so its badge is not unknown for want of a reader', async () => {
    const { stages: value, contexts } = stages()
    await trustSource(hostTrustOptions(options(logger())), value).read()
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.context.plugins).toBeDefined()
    expect(contexts[0]?.context.changes).toBeDefined()
  })

  it('makes a new start bill on each refresh, which hashes nothing and leaves the read bill alone', async () => {
    let made = 0
    const { stages: value, contexts } = stages(async () => ({ ...bill('start'), generatedAt: `2026-11-11T10:0${String(made++)}:00Z` }))
    const source = trustSource(options(logger()), value)
    expect((await source.read()).generatedAt).toBe('2026-11-11T10:00:00Z')
    expect((await source.refresh()).generatedAt).toBe('2026-11-11T10:01:00Z')
    expect((await source.refresh()).generatedAt).toBe('2026-11-11T10:02:00Z')
    expect((await source.read()).generatedAt).toBe('2026-11-11T10:00:00Z')
    expect(contexts.map(entry => entry.stage)).toEqual(['start', 'start', 'start'])
  })

  it('produces the start bill again after a failed one', async () => {
    let fail = true
    const { stages: value, contexts } = stages(async () => {
      if (fail) throw new Error('no record')
      return bill('start')
    })
    const source = trustSource(options(logger()), value)
    await expect(source.read()).rejects.toThrow('no record')
    fail = false
    expect((await source.read()).stage).toBe('start')
    expect(contexts).toHaveLength(2)
  })

  it('runs the verify stage in this process on each check when no launcher started it, with the clock read then, and logs its warnings and notices', async () => {
    const log = logger()
    const { stages: value, contexts } = stages()
    const source = trustSource(options(log), value)
    expect(await source.check(1000)).toMatchObject({ stage: 'verify', checkedBy: { via: 'host', reason: 'no-launcher' } })
    expect((await source.check(1000)).stage).toBe('verify')
    expect(contexts.map(entry => [entry.stage, entry.context.now])).toEqual([['verify', 1_800_000_000], ['verify', 1_800_000_001]])
    expect(log.lines.slice(0, 2)).toEqual(['warn delorun-trust: the release log was not reached', 'info delorun-trust: a newer root is stored'])
  })
})

/**
 * A launcher package directory with a `bin` entry, and the handoff record that names it.
 * @param bin - the manifest's `bin` field.
 * @returns the directory and the record.
 */
function launcherPackage(bin: unknown = { delorun: 'dist/bin.js' }): { readonly directory: string, readonly handoff: string } {
  const directory = mkdtempSync(join(tmpdir(), 'delorun-launcher-package-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  mkdirSync(join(directory, 'dist'))
  writeFileSync(join(directory, 'dist', 'bin.js'), '// the launcher\n')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'delorun', version: '0.1.0', bin }))
  const handoff = startCheckHandoffText({ schema: START_CHECK_SCHEMA, release: '0.1.0', at: 1, full: false, hashed: 1, files: 2, fullCheckAt: 1, launcher: { version: '0.1.0', path: directory } })
  return { directory, handoff }
}

describe('Check now through the launcher', () => {
  it('resolves the launcher the start-check record names and runs delorun verify --json under this runtime\'s Node', async () => {
    const { directory, handoff } = launcherPackage()
    const command = await launcherVerifyCommand({
      home: '/home/person/.delorun', profile: 'work', node: '/runtime/node', running: '0.1.0',
      env: { [DELORUN_START_CHECK_ENV]: handoff, DELORUN_LAUNCHER_ROOTS: '/old', PATH: '/bin', UNSET: undefined, NODE_OPTIONS: '--require x', OPENSSL_CONF: '/x', ld_preload: '/x.so', DYLD_INSERT_LIBRARIES: '/x' },
    })
    expect(command).toEqual({
      command: '/runtime/node',
      args: [join(directory, 'dist', 'bin.js'), '--profile', 'work', '--', 'verify', '--release', '0.1.0', '--json'],
      env: { PATH: '/bin', DELORUN_HOME: '/home/person/.delorun', DELORUN_PROFILE: 'work' },
    })
  })

  it.each<[string, () => Readonly<Record<string, string | undefined>>, string]>([
    ['no start-check record', () => ({}), 'no-launcher'],
    ['a record that does not read', () => ({ [DELORUN_START_CHECK_ENV]: 'not json' }), 'no-launcher'],
    ['a launcher directory without a manifest, as a source launch', () => {
      const { directory, handoff } = launcherPackage()
      rmSync(join(directory, 'package.json'))
      return { [DELORUN_START_CHECK_ENV]: handoff }
    }, 'launcher-unresolvable'],
    ['a bin outside the launcher\'s directory', () => ({ [DELORUN_START_CHECK_ENV]: launcherPackage({ delorun: '../outside.js' }).handoff }), 'launcher-unresolvable'],
    ['a bin that names no file', () => ({ [DELORUN_START_CHECK_ENV]: launcherPackage({ delorun: 'dist/missing.js' }).handoff }), 'launcher-unresolvable'],
    ['a manifest without a bin', () => ({ [DELORUN_START_CHECK_ENV]: launcherPackage(null).handoff }), 'launcher-unresolvable'],
    ['a record of another release, as an update\'s predecessor was given', () => ({ [DELORUN_START_CHECK_ENV]: launcherPackage().handoff.replace('"release":"0.1.0"', '"release":"0.0.9"') }), 'no-launcher'],
    ['a bin that leaves the launcher\'s directory for a file that exists', () => {
      const { directory, handoff } = launcherPackage({ delorun: '../outside.js' })
      writeFileSync(join(directory, '..', 'outside.js'), '// outside\n')
      onTestFinished(() => { rmSync(join(directory, '..', 'outside.js'), { force: true }) })
      return { [DELORUN_START_CHECK_ENV]: handoff }
    }, 'launcher-unresolvable'],
    ['a manifest that is a symbolic link', () => {
      const { directory, handoff } = launcherPackage()
      const real = join(directory, 'real.json')
      writeFileSync(real, JSON.stringify({ bin: { delorun: 'dist/bin.js' } }))
      rmSync(join(directory, 'package.json'))
      symlinkSync(real, join(directory, 'package.json'))
      return { [DELORUN_START_CHECK_ENV]: handoff }
    }, 'launcher-unresolvable'],
    ['a bin that is a symbolic link', () => {
      const { directory, handoff } = launcherPackage({ delorun: 'dist/link.js' })
      symlinkSync(join(directory, 'dist', 'bin.js'), join(directory, 'dist', 'link.js'))
      return { [DELORUN_START_CHECK_ENV]: handoff }
    }, 'launcher-unresolvable'],
  ])('falls back to this process with %s', async (_case, env, reason) => {
    expect(await launcherVerifyCommand({ home: '/h', profile: 'default', node: '/n', running: '0.1.0', env: env() })).toBe(reason)
  })

  it('answers the bill delorun verify printed, naming the launcher and the time it took', async () => {
    const { handoff } = launcherPackage()
    const printed = { ...bill('verify'), release: { ...bill('verify').release, signature: 'pass', files: 'pass' } }
    const runs: number[] = []
    const { stages: value } = stages(undefined, async (_command, timeoutMs) => {
      runs.push(timeoutMs)
      return { status: 0, stdout: `${JSON.stringify({ schemaVersion: 1, bill: printed })}\n`, stderr: 'notice: something\n', timedOut: false }
    })
    let clock = 0
    const log = logger()
    const source = trustSource({ ...options(log), env: { [DELORUN_START_CHECK_ENV]: handoff }, elapsed: () => (clock += 12_340) }, value)
    expect(await source.check(5_000)).toEqual({ ...printed, checkedBy: { via: 'launcher', seconds: 12.3 }, checkNow: { via: 'launcher' } })
    expect(runs).toEqual([5_000])
    expect(log.lines).toContain('info delorun-trust: delorun verify: notice: something')
  })

  it('hands the background check\'s low priority and stop signal to the launcher run', async () => {
    const { handoff } = launcherPackage()
    const given: unknown[] = []
    const { stages: value } = stages(undefined, async (_command, _timeoutMs, runOptions) => {
      given.push(runOptions)
      return { status: 0, stdout: `${JSON.stringify({ bill: bill('verify') })}\n`, stderr: '', timedOut: false }
    })
    const source = trustSource({ ...options(logger()), env: { [DELORUN_START_CHECK_ENV]: handoff } }, value)
    const signal = new AbortController().signal
    await source.check(5_000, { lowPriority: true, signal })
    await source.check(5_000)
    expect(given).toEqual([{ lowPriority: true, signal }, {}])
  })

  it('c15-check-now-runs-through-launcher: a launcher that refuses to run delorun verify makes a bill whose files failed, with its refusal', async () => {
    const { handoff } = launcherPackage()
    const { stages: value } = stages(undefined, async () => ({ status: 1, stdout: '', stderr: 'Delorun did not run delorun verify: release 0.1.0 failed its start check.\nWhy: RUNTIME_CHANGED: node/bin/node (sha256)\n', timedOut: false }))
    const checked = await trustSource({ ...options(logger()), env: { [DELORUN_START_CHECK_ENV]: handoff } }, value).check(5_000)
    expect(checked).toMatchObject({ stage: 'verify', checkedBy: { via: 'launcher' }, release: { files: 'fail', signature: 'unknown' } })
    expect(checked.release.detail).toContain('RUNTIME_CHANGED: node/bin/node (sha256)')
  })

  it('refuses a bill of another release than the running one', async () => {
    const { handoff } = launcherPackage()
    const other = { ...bill('verify'), release: { ...bill('verify').release, version: '0.0.9' } }
    const { stages: value } = stages(undefined, async () => ({ status: 0, stdout: `${JSON.stringify({ bill: other })}\n`, stderr: '', timedOut: false }))
    await expect(trustSource({ ...options(logger()), env: { [DELORUN_START_CHECK_ENV]: handoff } }, value).check(5_000)).rejects.toThrow('reported release 0.0.9, not the running 0.1.0')
  })

  it('fails a check that outlasts its deadline', async () => {
    const { handoff } = launcherPackage()
    const { stages: value } = stages(undefined, async (): Promise<ChildRun> => ({ status: null, stdout: '', stderr: '', timedOut: true }))
    await expect(trustSource({ ...options(logger()), env: { [DELORUN_START_CHECK_ENV]: handoff } }, value).check(30_000)).rejects.toThrow('did not finish within 30 s')
  })

  it('reads only a report that validates', () => {
    expect(billOfVerifyOutput(`noise\n${JSON.stringify({ bill: bill('verify') })}\n`)).toEqual(bill('verify'))
    expect(billOfVerifyOutput(JSON.stringify({ bill: { ...bill('verify'), schema: 'other' } }))).toBeUndefined()
    expect(billOfVerifyOutput('{not json')).toBeUndefined()
    expect(billOfVerifyOutput('')).toBeUndefined()
  })

  it('runs a child to its end, and stops one that outlasts its time', async () => {
    const ended = await runChild({ command: process.execPath, args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'], env: {} }, 10_000)
    expect(ended).toEqual({ status: 3, stdout: 'out', stderr: 'err', timedOut: false })
    const stopped = await runChild({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'], env: {} }, 200)
    expect(stopped.timedOut).toBe(true)
  })
})

/**
 * Whether a process is alive.
 * @param pid - its id.
 * @returns false once it has ended.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: it has ended.
    return false
  }
}

/** A child that starts a grandchild holding its standard output and error, prints the grandchild's id, and waits. */
const WITH_GRANDCHILD = (then: string): string => `const g = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); process.stdout.write(String(g.pid) + '\\n'); ${then}`

describe.skipIf(process.platform === 'win32')('a child\'s process tree', () => {
  const runner = childRunner({ killMs: 300, closeMs: 300 })

  it('stops the whole group of a child that outlasts its time, a grandchild holding its output included, and escalates to SIGKILL', async () => {
    const started = performance.now()
    const run = await runner({ command: process.execPath, args: ['-e', WITH_GRANDCHILD('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')], env: {} }, 500)
    expect(run.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(5_000)
    const grandchild = Number(run.stdout.trim().split('\n')[0])
    expect(grandchild).toBeGreaterThan(0)
    await vi.waitFor(() => { expect(alive(grandchild)).toBe(false) })
  })

  it('stops the whole group when the background check is stopped, and rejects with the reason', async () => {
    const controller = new AbortController()
    const run = runner({ command: process.execPath, args: ['-e', WITH_GRANDCHILD('setInterval(() => {}, 1000)')], env: {} }, 30_000, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('a turn started'))
    await expect(run).rejects.toThrow('a turn started')
  })

  it('starts nothing for a check stopped before it began', async () => {
    const controller = new AbortController()
    controller.abort(new Error('a turn started'))
    await expect(runner({ command: '/no/such/command', args: [], env: {} }, 1_000, { signal: controller.signal })).rejects.toThrow('a turn started')
  })

  it.runIf(process.platform === 'linux')('runs the background check at nice 10, and Check now at the Host\'s own priority', async () => {
    // The priority is lowered just after the child starts, so the child reads its own a moment later.
    const read = 'setTimeout(() => { process.stdout.write(String(require("node:os").getPriority())) }, 200)'
    const low = await runner({ command: process.execPath, args: ['-e', read], env: {} }, 10_000, { lowPriority: true })
    // A process may raise its nice value but not lower it, so under a Host already nicer than 10 the child keeps the Host's.
    expect(Number(low.stdout)).toBe(Math.max(BACKGROUND_NICE, getPriority()))
    const normal = await runner({ command: process.execPath, args: ['-e', read], env: {} }, 10_000)
    expect(Number(normal.stdout)).toBe(getPriority())
  })

  it('settles when the child exits though a grandchild still holds its output, and ends the grandchild', async () => {
    const run = await runner({ command: process.execPath, args: ['-e', WITH_GRANDCHILD('setTimeout(() => process.exit(0), 100)')], env: {} }, 30_000)
    expect({ status: run.status, timedOut: run.timedOut }).toEqual({ status: 0, timedOut: false })
    const grandchild = Number(run.stdout.trim().split('\n')[0])
    await vi.waitFor(() => { expect(alive(grandchild)).toBe(false) })
  })
})

describe('watchTrust', () => {
  it('attaches the source to the delorunTrust service once it is present', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const attached: TrustSource[] = []
    const { stages: value } = stages()
    watchTrust(ctx, options(logger()), value)
    expect(attached).toEqual([])
    ctx.provide('delorunTrust', { attach: (source: TrustSource) => { attached.push(source); return () => {} } } as never)
    await vi.waitFor(() => { expect(attached).toHaveLength(1) })
    expect((await attached[0]?.read())?.stage).toBe('start')
  })
})
