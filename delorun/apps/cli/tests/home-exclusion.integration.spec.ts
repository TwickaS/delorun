/**
 * The users of a home's shared stores. The exclusive use by `delorun trash`, `export` and `import`: the home lock of
 * every profile is held for the whole operation and released afterwards, whatever the operation did; a profile whose
 * home process runs, or whose lock another process holds, refuses the command before it runs and leaves no lock this
 * process took. The shared use by `delorun headless`, the registrations under `run/data-users/`, and the refusals
 * between the two and an update in progress. Each refusal spec fails when its check is removed: the operation would
 * run beside a live home process, a live user of the stores, or an update mid-copy.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DATA_USERS_DIRECTORY, type RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, ensureHomeTree, newStartId, readHomeLock, readPidNamespace, readProcessStart, runDirectory, type HolderAnswer } from '@delorun/home'
import { journalPath, updateChannelProbe, writeJournal } from '@delorun/home-process'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import {
  assertNoUpdateInProgress,
  assertSoleDataUser,
  DataInUseError,
  finishInterruptedRestore,
  homeExclusion,
  otherDataUsers,
  registerDataUser,
  registerHomeProcess,
  useHomeShared,
  withHomeExclusive,
  type HomeExclusion,
} from '../src/home-exclusion.ts'

const RUNTIME = brandString<RuntimeVersion>('0.0.0')

let home: string | undefined
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A live process that is not this one, killed after the spec.
 * @returns its process id.
 */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  children.push(child)
  return child.pid ?? 0
}

/**
 * Write an update record of one profile in a phase.
 * @param root - the home.
 * @param phase - the phase.
 */
async function updateRecord(root: string, phase: 'snapshot' | 'committed' | 'rolling-back'): Promise<void> {
  mkdirSync(runDirectory(root, 'default'), { recursive: true, mode: 0o700 })
  await writeJournal(journalPath(root, 'default'), { from: brandString<RuntimeVersion>('1.0.0'), to: brandString<RuntimeVersion>('1.1.0'), previous: undefined, startedAt: '2026-11-10T12:00:00.000Z', dataDiffers: true, copy: true, targetStarted: false }, phase)
}

/**
 * A fresh home with run directories for some profiles.
 * @param profiles - the profiles whose run directories exist.
 * @returns its path.
 */
function newHome(profiles: readonly string[] = []): string {
  home = mkdtempSync(join(tmpdir(), 'delorun-exclusive-'))
  for (const profile of profiles) mkdirSync(runDirectory(home, profile), { recursive: true, mode: 0o700 })
  return home
}

/**
 * An exclusion whose probe gives one answer.
 * @param answer - what every holder answers.
 * @returns the exclusion.
 */
function answering(answer: HolderAnswer): HomeExclusion {
  return { probe: () => async () => answer, runtime: RUNTIME }
}

/**
 * Hold one profile's lock as a home process would.
 * @param root - the home.
 * @param profile - the profile.
 * @returns the held lock.
 */
async function holdAsHomeProcess(root: string, profile: string): ReturnType<typeof acquireHomeLock> {
  return acquireHomeLock({ runDirectory: runDirectory(root, profile), runtime: RUNTIME, probe: async () => 'answered', startId: newStartId() })
}

describe('withHomeExclusive', () => {
  it('holds the lock of every profile, the given one created, for the whole operation, and releases them after', async () => {
    const root = newHome(['work', 'play'])
    const seen = await withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () =>
      ['default', 'play', 'work'].map(profile => readHomeLock(runDirectory(root, profile))?.pid), answering('answered'))

    expect(seen).toEqual([process.pid, process.pid, process.pid])
    expect(['default', 'play', 'work'].map(profile => readHomeLock(runDirectory(root, profile)))).toEqual([undefined, undefined, undefined])
  })

  it('releases every lock when the operation fails', async () => {
    const root = newHome()

    await expect(withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () => { throw new Error('the operation failed') }, answering('answered'))).rejects.toThrow('the operation failed')

    expect(readHomeLock(runDirectory(root, 'default'))).toBeUndefined()
  })

  it('refuses while a profile\'s home process runs, runs nothing, and leaves no lock it took', async () => {
    const root = newHome(['a', 'work'])
    const running = await holdAsHomeProcess(root, 'work')
    let ran = false
    try {
      const refused = await withHomeExclusive({ home: root, profile: 'a', command: 'trash', instead: 'use the studio' }, async () => { ran = true }, answering('answered')).then(() => undefined, (error: unknown) => error)

      expect(refused).toBeInstanceOf(CliError)
      expect((refused as CliError).message).toBe(`delorun trash: Delorun is running for the profile work (process ${String(process.pid)}) and uses the stores this command changes; run delorun stop --profile work first, or use the studio`)
      expect(ran).toBe(false)
      expect(readHomeLock(runDirectory(root, 'a'))).toBeUndefined()
      expect(readHomeLock(runDirectory(root, 'work'))?.startId).toBe(running.record.startId)
    } finally {
      running.release()
    }
  })

  it('refuses while another command holds a profile\'s lock without answering', async () => {
    const root = newHome(['default'])
    const other = await holdAsHomeProcess(root, 'default')
    try {
      const refused = await withHomeExclusive({ home: root, profile: 'default', command: 'import', instead: '' }, async () => undefined, answering('silent')).then(() => undefined, (error: unknown) => error)

      expect((refused as CliError).message).toBe(`delorun import: another process (process ${String(process.pid)}) holds the home lock of the profile default, such as another delorun trash, export or import; wait for it to finish, or stop it, and try again`)
    } finally {
      other.release()
    }
  })

  it('reports a lock file it cannot read, and leaves no lock it took', async () => {
    const root = newHome(['a', 'b'])
    writeFileSync(join(runDirectory(root, 'b'), 'home.lock'), 'not a lock record')

    await expect(withHomeExclusive({ home: root, profile: 'a', command: 'export', instead: '' }, async () => undefined, answering('answered'))).rejects.toThrow('is not a home lock record')

    expect(readHomeLock(runDirectory(root, 'a'))).toBeUndefined()
  })

  it('names no process when the holder left before it could be read', async () => {
    const root = newHome(['default'])
    const other = await holdAsHomeProcess(root, 'default')
    const leaving: HomeExclusion = { probe: () => async () => { other.release(); return 'answered' }, runtime: RUNTIME }

    const refused = await withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () => undefined, leaving).then(() => undefined, (error: unknown) => error)

    expect((refused as CliError).message).toBe('delorun trash: Delorun is running for the profile default and uses the stores this command changes; run delorun stop --profile default first')
  })
})

describe('the registered users of the stores', () => {
  it('lists another live user with its use, refuses beside it, and drops a dead one\'s registration', async () => {
    const root = newHome()
    expect(otherDataUsers(root)).toEqual([])
    const release = registerDataUser(root, 'shared', 'headless')
    expect(otherDataUsers(root)).toEqual([])
    expect(() => { assertSoleDataUser(root) }).not.toThrow()
    const pid = liveProcess()
    const other = registerDataUser(root, 'exclusive', 'trash', pid)
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'trash' }])
    expect(() => { assertSoleDataUser(root) }).toThrow(new DataInUseError(`process ${String(pid)} (delorun trash) uses the chat data; wait for it to end, then try again`))
    children[0]?.kill('SIGKILL')
    await new Promise(resolve => children[0]?.once('exit', resolve))
    expect(otherDataUsers(root)).toEqual([])
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([String(process.pid)])
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, 'not-a-pid'), '')
    expect(otherDataUsers(root)).toEqual([])
    other()
    release()
    release()
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual(['not-a-pid'])
  })

  it('reads a registration it cannot parse as an exclusive use by an unknown command', () => {
    const root = newHome()
    const pid = liveProcess()
    mkdirSync(join(root, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), `${String(pid)}\n`)
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'unknown' }])
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), '{"mode":"reading","command":"headless"}\n')
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'unknown' }])
  })

  it('refuses while an update or rollback is in progress or a restore is unfinished, and not after a commit', async () => {
    const root = newHome()
    await assertNoUpdateInProgress(root)
    await updateRecord(root, 'committed')
    await assertNoUpdateInProgress(root)
    await updateRecord(root, 'snapshot')
    await expect(assertNoUpdateInProgress(root)).rejects.toThrow(/is snapshot/u)
    await updateRecord(root, 'rolling-back')
    await expect(assertNoUpdateInProgress(root)).rejects.toThrow(/is rolling-back/u)
    await updateRecord(root, 'committed')
    mkdirSync(join(root, 'data-copies'), { recursive: true })
    writeFileSync(join(root, 'data-copies', 'restore.json'), '{}')
    await expect(assertNoUpdateInProgress(root)).rejects.toThrow(/restore of the chat data is unfinished/u)
  })
})

describe('useHomeShared', () => {
  it('registers beside another shared user, and the release removes the registration', async () => {
    const root = newHome()
    registerDataUser(root, 'shared', 'headless', liveProcess())
    const release = await useHomeShared(root, 'headless')
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toContain(String(process.pid))
    release()
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).not.toContain(String(process.pid))
  })

  it('refuses while an exclusive user runs, and leaves no registration behind', async () => {
    const root = newHome()
    const pid = liveProcess()
    registerDataUser(root, 'exclusive', 'import', pid)
    await expect(useHomeShared(root, 'headless')).rejects.toThrow(new CliError(EXIT.failed, `delorun headless: process ${String(pid)} (delorun import) is changing the stores this command uses; wait for it to finish, and try again`))
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([String(pid)])
  })

  it('passes an error that is not a refusal through, and leaves no registration behind', async () => {
    const root = newHome()
    await updateRecord(root, 'snapshot')
    writeFileSync(journalPath(root, 'default'), 'not a record')
    await expect(useHomeShared(root, 'headless')).rejects.not.toBeInstanceOf(CliError)
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })

  it('delorun headless refuses while an update is in progress and leaves no registration behind', async () => {
    const base = newHome()
    const root = join(base, '.delorun')
    await ensureHomeTree(root, 'default')
    await updateRecord(root, 'snapshot')
    let stderr = ''
    const code = await main(['headless', 'say hello'], { env: { ...process.env, HOME: base, DELORUN_HOME: root }, stdout: () => {}, stderr: (text) => { stderr += text } })
    expect(code).toBe(EXIT.failed)
    expect(stderr).toContain('delorun headless: an update of the profile default from Delorun 1.0.0 to Delorun 1.1.0 is snapshot')
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })
})

describe('registerHomeProcess', () => {
  it('registers this process as the profile\'s home process with its start identity, named as such to others', async () => {
    const root = newHome()
    const release = await registerHomeProcess(root, 'work')
    const path = join(root, 'run', DATA_USERS_DIRECTORY, String(process.pid))
    const processStart = readProcessStart(process.pid)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mode: 'shared', command: 'start', profile: 'work', ...processStart === undefined ? {} : { processStart }, pidNamespace: readPidNamespace() })
    expect(otherDataUsers(root, 0)).toEqual([{ pid: process.pid, mode: 'shared', command: 'start', profile: 'work' }])
    expect(() => { assertSoleDataUser(root) }).not.toThrow()
    release()
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })

  it('refuses while an exclusive user runs, and leaves no registration behind', async () => {
    const root = newHome()
    const pid = liveProcess()
    registerDataUser(root, 'exclusive', 'trash', pid)
    await expect(registerHomeProcess(root, 'default')).rejects.toThrow(new CliError(EXIT.failed, `delorun start: process ${String(pid)} (delorun trash) is changing the stores this command uses; wait for it to finish, and try again`))
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([String(pid)])
  })

  it('refuses while another profile\'s update is in progress, and not for its own profile\'s update or an unfinished restore its start completes', async () => {
    const root = newHome()
    await updateRecord(root, 'snapshot')
    mkdirSync(join(root, 'data-copies'), { recursive: true })
    writeFileSync(join(root, 'data-copies', 'restore.json'), '{}')
    ;(await registerHomeProcess(root, 'default'))()
    await expect(registerHomeProcess(root, 'work')).rejects.toThrow(new CliError(EXIT.failed, 'delorun start: an update of the profile default from Delorun 1.0.0 to Delorun 1.1.0 is snapshot; wait for it to end, or run delorun recover status'))
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })

  it.skipIf(readProcessStart(process.pid) === undefined)('does not count a registration whose process id another process now has, and removes it', () => {
    const root = newHome()
    const pid = liveProcess()
    const stale = (readProcessStart(pid) ?? readProcessStart(process.pid)!).replace(/\d+$/u, digits => String(Number(digits) + 1))
    mkdirSync(join(root, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), JSON.stringify({ mode: 'exclusive', command: 'trash', processStart: stale }))
    expect(otherDataUsers(root)).toEqual([])
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
  })

  it('counts a registration recorded in another pid namespace, though its process id is dead in this one, and keeps it', async () => {
    const root = newHome()
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise(resolve => exited.once('exit', resolve))
    const pid = exited.pid!
    mkdirSync(join(root, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), JSON.stringify({ mode: 'exclusive', command: 'trash', pidNamespace: 'pid:[1]' }))
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'trash' }])
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([String(pid)])
  })

  it('drops a registration from an earlier boot even when it records another pid namespace, and keeps one of this boot', async () => {
    const root = newHome()
    const directory = join(root, 'run', DATA_USERS_DIRECTORY)
    mkdirSync(directory, { recursive: true })
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const otherBoot = bootId === '00000000-0000-4000-8000-000000000000' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000000'
    writeFileSync(join(directory, '37721'), JSON.stringify({ mode: 'shared', command: 'start', profile: 'default', processStart: `linux:${otherBoot}:12022538`, pidNamespace: 'pid:[1]' }))
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      writeFileSync(join(directory, String(sleeper.pid)), JSON.stringify({ mode: 'shared', command: 'start', profile: 'default', processStart: `linux:${bootId}:1`, pidNamespace: 'pid:[1]' }))
      expect(otherDataUsers(root).map(user => user.pid)).toEqual([sleeper.pid])
      expect(readdirSync(directory)).toEqual([String(sleeper.pid)])
    } finally {
      sleeper.kill()
    }
  })

  it('reads a registration whose start identity is malformed as an exclusive use judged by its process id', () => {
    const root = newHome()
    const pid = liveProcess()
    mkdirSync(join(root, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), JSON.stringify({ mode: 'shared', command: 'headless', processStart: 'windows:1' }))
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'unknown' }])
  })

  it('reads a registration whose pid namespace is malformed as an exclusive use judged by its process id', () => {
    const root = newHome()
    const pid = liveProcess()
    mkdirSync(join(root, 'run', DATA_USERS_DIRECTORY), { recursive: true })
    writeFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), JSON.stringify({ mode: 'shared', command: 'headless', pidNamespace: 'pid:[x]' }))
    expect(otherDataUsers(root)).toEqual([{ pid, mode: 'exclusive', command: 'unknown' }])
  })

  it('records another process\'s start identity when it registers that process', () => {
    const root = newHome()
    const pid = liveProcess()
    registerDataUser(root, 'shared', 'headless', pid)
    const processStart = readProcessStart(pid)
    expect(JSON.parse(readFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(pid)), 'utf8'))).toEqual({ mode: 'shared', command: 'headless', ...processStart === undefined ? {} : { processStart }, pidNamespace: readPidNamespace() })
  })
})

describe('finishInterruptedRestore', () => {
  /**
   * A home whose restore of a session-data copy was interrupted, with a journal the restore cannot trust.
   * @returns the home, with this process registered as the home process of `default`.
   */
  async function interrupted(): Promise<string> {
    const root = newHome()
    mkdirSync(join(root, 'data-copies'), { recursive: true })
    writeFileSync(join(root, 'data-copies', 'restore.json'), '{}')
    await registerHomeProcess(root, 'default')
    return root
  }

  /**
   * This process's registration.
   * @param root - the home.
   * @returns the parsed registration.
   */
  function ownRegistration(root: string): unknown {
    return JSON.parse(readFileSync(join(root, 'run', DATA_USERS_DIRECTORY, String(process.pid)), 'utf8'))
  }

  it('refuses beside another profile\'s home process, leaves the restore unfinished and the registration shared', async () => {
    const root = await interrupted()
    const pid = liveProcess()
    registerDataUser(root, 'shared', 'start', pid, 'work')
    await expect(finishInterruptedRestore(root, 'default')).rejects.toThrow(new CliError(EXIT.failed, `delorun start: a restore of the chat data is unfinished and must complete before Delorun starts, and the home process of the profile work (process ${String(pid)}) uses the chat data; wait for it to end, or stop it with delorun stop --profile work, then try again`))
    expect(readFileSync(join(root, 'data-copies', 'restore.json'), 'utf8')).toBe('{}')
    expect(ownRegistration(root)).toMatchObject({ mode: 'shared', command: 'start', profile: 'default' })
  })

  it('runs the restore as the only user, then registers as the shared home process again', async () => {
    const root = await interrupted()
    // The journal cannot be trusted, so the restore itself refuses once it runs.
    await expect(finishInterruptedRestore(root, 'default')).rejects.toThrow(/DATA_RESTORE_INCONSISTENT|not a restore journal/u)
    expect(ownRegistration(root)).toMatchObject({ mode: 'shared', command: 'start', profile: 'default' })
  })

  it('only clears an interrupted copy\'s leftovers when no restore is unfinished', async () => {
    const root = newHome()
    await registerHomeProcess(root, 'default')
    const pid = liveProcess()
    registerDataUser(root, 'shared', 'start', pid, 'work')
    await expect(finishInterruptedRestore(root, 'default')).resolves.toBe(false)
    expect(ownRegistration(root)).toMatchObject({ mode: 'shared', profile: 'default' })
  })
})

describe('withHomeExclusive and the registered users', () => {
  it('registers as the exclusive user while it runs, takes no lock in the users\' directory, and removes both after', async () => {
    const root = newHome(['work'])
    registerDataUser(root, 'shared', 'headless', 2 ** 30)
    const seen = await withHomeExclusive({ home: root, profile: 'default', command: 'trash', instead: '' }, async () => ({
      users: otherDataUsers(root, 0),
      lock: readHomeLock(runDirectory(root, DATA_USERS_DIRECTORY)),
    }), answering('answered'))

    expect(seen).toEqual({ users: [{ pid: process.pid, mode: 'exclusive', command: 'trash' }], lock: undefined })
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([])
    expect(readHomeLock(runDirectory(root, 'work'))).toBeUndefined()
  })

  it('refuses while delorun headless uses the stores, runs nothing, and leaves no lock or registration', async () => {
    const root = newHome(['work'])
    const pid = liveProcess()
    registerDataUser(root, 'shared', 'headless', pid)
    let ran = false

    await expect(withHomeExclusive({ home: root, profile: 'default', command: 'export', instead: '' }, async () => { ran = true }, answering('answered'))).rejects.toThrow(new CliError(EXIT.failed, `delorun export: process ${String(pid)} (delorun headless) uses the chat data; wait for it to end, then try again`))

    expect(ran).toBe(false)
    expect(readdirSync(join(root, 'run', DATA_USERS_DIRECTORY))).toEqual([String(pid)])
    expect(readHomeLock(runDirectory(root, 'work'))).toBeUndefined()
  })

  it('refuses while an update is in progress, and passes an error that is not a refusal through', async () => {
    const root = newHome()
    await updateRecord(root, 'snapshot')
    await expect(withHomeExclusive({ home: root, profile: 'default', command: 'import', instead: '' }, async () => undefined, answering('answered'))).rejects.toThrow(new CliError(EXIT.failed, 'delorun import: an update of the profile default from Delorun 1.0.0 to Delorun 1.1.0 is snapshot; wait for it to end, or run delorun recover status'))
    writeFileSync(journalPath(root, 'default'), 'not a record')
    await expect(withHomeExclusive({ home: root, profile: 'default', command: 'import', instead: '' }, async () => undefined, answering('answered'))).rejects.not.toBeInstanceOf(CliError)
    expect(readHomeLock(runDirectory(root, 'default'))).toBeUndefined()
  })
})

describe('homeExclusion', () => {
  it('asks a holder over the update channel and records the CLI\'s version', () => {
    const exclusion = homeExclusion()

    expect(exclusion.probe).toBe(updateChannelProbe)
    expect(exclusion.runtime).toMatch(/^\d+\.\d+\.\d+/)
  })
})
