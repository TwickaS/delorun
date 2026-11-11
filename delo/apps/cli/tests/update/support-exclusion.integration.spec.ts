/**
 * The update support of one profile's home process beside another profile's: `sessions/`, `storages/` and `current`
 * are the whole home's, so a session-data copy, a rollback with its restore, a prepare and a rollback's report refuse
 * with `CHATS_RUNNING` while another profile's home process runs, naming it. A registration whose process has exited,
 * or whose process id another process now has, does not refuse, and neither does the process's own.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DATA_USERS_DIRECTORY, type RuntimeVersion } from '@delo/contract-home-layout'
import { readProcessStart } from '@delo/home'
import type { UpdateSupport } from '@delo/home-process'
import { RuntimeStore } from '@delo/runtime-store'
import { registerHomeProcess } from '../../src/home-exclusion.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { homeUpdateSupport } from '../../src/update/support.ts'

const REPOSITORY = join(import.meta.dirname, '../../../../..')
const USER = join(import.meta.dirname, '../fixtures/home-process-user.ts')
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const RECORD = { v: 1 as const, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed' as const, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }
const STEPS = { profileOnly: false, switchRuntime: async () => {}, markRollingBack: async () => {} }

let home: string
const children: ChildProcess[] = []
const releases: (() => void)[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delo-support-exclusion-'))
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(children.splice(0).map(child => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once('exit', () => { resolve() })
    child.kill('SIGKILL')
  })))
  rmSync(home, { recursive: true, force: true })
})

/**
 * Start a process registered as a profile's home process, as `delorun start` registers it.
 * @param profile - the profile.
 * @returns the process, once its registration is written.
 */
async function otherHomeProcess(profile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', USER, home, profile], { cwd: REPOSITORY, stdio: ['pipe', 'pipe', 'inherit'] })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('exit', code => { reject(new Error(`the registered process exited with ${String(code)}`)) })
    createInterface({ input: child.stdout! }).once('line', () => { resolve() })
  })
  return child
}

/**
 * The update support of this process as the home process of `default`, registered as `delorun start` registers it.
 * @returns the support.
 */
async function ownSupport(): Promise<UpdateSupport> {
  releases.push(await registerHomeProcess(home, 'default'))
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  const unused = (): Promise<never> => Promise.reject(new Error('not read before the refusal'))
  return homeUpdateSupport({
    home,
    profile: 'default',
    store: new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger }),
    root: unused,
    openChannel: unused,
    sources: { running: unused, statuses: unused, profile: unused, target: unused, data: unused, harness: unused, now: () => { throw new Error('not read before the refusal') } },
    now: () => new Date('2026-11-10T12:00:00.000Z'),
  })
}

describe('the update support beside another profile\'s home process', () => {
  it('refuses a copy, a rollback, a prepare and a rollback\'s report, naming the other profile\'s home process', async () => {
    const other = await otherHomeProcess('work')
    const support = await ownSupport()
    const named = { code: 'CHATS_RUNNING', message: expect.stringContaining(`the home process of the profile work (process ${String(other.pid)}) uses the chat data; wait for it to end, or stop it with delorun stop --profile work, then try again`) as string }

    await expect(support.copies.plan(false)).rejects.toMatchObject(named)
    await expect(support.copies.save(v('1.0.0'), v('1.1.0'))).rejects.toMatchObject(named)
    await expect(support.copies.rollback(RECORD, STEPS)).rejects.toMatchObject(named)
    await expect(support.store.prepare(undefined, () => {}, () => {})).rejects.toMatchObject(named)
    await expect(support.store.reportRollback(v('1.0.0'))).rejects.toMatchObject(named)
  }, 30_000)

  it('does not count a registration whose process has exited', async () => {
    const other = await otherHomeProcess('work')
    other.stdin!.end()
    await new Promise(resolve => other.once('exit', resolve))
    // The exit's release is skipped, as a killed process skips it.
    writeFileSync(join(home, 'run', DATA_USERS_DIRECTORY, String(other.pid)), JSON.stringify({ mode: 'shared', command: 'start', profile: 'work' }))

    await expect((await ownSupport()).copies.plan(false)).resolves.toBeUndefined()
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual([String(process.pid)])
  }, 30_000)

  it.skipIf(readProcessStart(process.pid) === undefined)('does not count a registration whose process id another process now has, as after a reboot', async () => {
    const reused = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    children.push(reused)
    const stale = (readProcessStart(reused.pid!) ?? readProcessStart(process.pid)!).replace(/\d+$/u, digits => String(Number(digits) + 1))
    mkdirSync(join(home, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(home, 'run', DATA_USERS_DIRECTORY, String(reused.pid)), JSON.stringify({ mode: 'shared', command: 'start', profile: 'work', processStart: stale }))

    await expect((await ownSupport()).copies.plan(false)).resolves.toBeUndefined()
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual([String(process.pid)])
  })

  it('passes a failure to read the registrations through unchanged', async () => {
    const support = await ownSupport()
    releases.splice(0).forEach((release) => { release() })
    rmSync(join(home, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(home, 'run', DATA_USERS_DIRECTORY), '')
    await expect(support.store.prepare(undefined, () => {}, () => {})).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('does not count its own registration', async () => {
    const support = await ownSupport()
    expect(readdirSync(join(home, 'run', DATA_USERS_DIRECTORY))).toEqual([String(process.pid)])
    await expect(support.copies.plan(false)).resolves.toBeUndefined()
    await expect(support.copies.save(v('1.0.0'), v('1.1.0'))).resolves.toBeUndefined()
  })
})
