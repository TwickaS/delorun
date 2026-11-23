/**
 * `delorun recover`: the command contract C3 offers beside the studio's update screen. The specs run it in-process
 * against a fixture home, so what they assert is what a person sees and which files changed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_USERS_DIRECTORY, type RuntimeVersion } from '@delorun/contract-home-layout'
import { journalPath, updateSocketPath, writeJournal } from '@delorun/home-process'
import { parseRuntimeVersion, RuntimeStoreError, type LaunchCommand } from '@delorun/runtime-store'
import { ensureHomeTree, writeNewStartToken } from '@delorun/home'
import type { CommandContext } from '../src/command.ts'
import { EXIT } from '../src/exit.ts'
import { DataInUseError } from '../src/home-exclusion.ts'
import { main } from '../src/main.ts'
import { rollbackOffline } from '../src/recover.ts'
import { runLauncher } from '../../npm-launcher/src/launcher.ts'
import { fixtureRelease } from '../../install/tests/support.ts'

/**
 * A release version.
 * @param text - its text.
 * @returns the version.
 */
function release(text: string): RuntimeVersion {
  const parsed = parseRuntimeVersion(text)
  if (parsed === undefined) throw new Error(`${text} is not a release version`)
  return parsed
}

const REPOSITORY = join(import.meta.dirname, '../../../..')
const HOME_PROCESS_USER = join(import.meta.dirname, 'fixtures/home-process-user.ts')

let osHome: string
let delorunHome: string

/**
 * Run `delorun` in this process against the fixture home.
 * @param args - the arguments.
 * @returns its exit code and both outputs.
 */
async function delorun(args: readonly string[]): Promise<{ code: number | undefined, stdout: string, stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    env: { ...process.env, HOME: osHome, USERPROFILE: osHome, DELORUN_HOME: delorunHome },
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr }
}

beforeEach(() => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-recover-'))
  delorunHome = join(osHome, '.delorun')
  mkdirSync(join(delorunHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(delorunHome, 'profiles', 'default', 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@delorun/bundle-local'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'), '[]\n')
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun recover', () => {
  it('reports where the profile stands and lists itself in the help', async () => {
    const help = await delorun(['--help'])
    expect(help.code).toBe(EXIT.ok)
    expect(help.stdout).toContain('recover')
    const status = await delorun(['recover'])
    expect(status.code).toBe(EXIT.ok)
    expect(status.stdout).toContain('This profile has not been through a Delorun update yet.')
    expect(status.stdout).toContain('Safe mode is off.')
  })

  it('turns safe mode on and off through the marker under the home\'s run directory', async () => {
    const started = await delorun(['recover', 'safe-mode', '--reason', 'a plugin broke the start'])
    expect(started.code).toBe(EXIT.ok)
    const marker = join(delorunHome, 'run', 'default', 'safe-mode.json')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toContain('a plugin broke the start')
    const ended = await delorun(['recover', 'exit-safe-mode'])
    expect(ended.code).toBe(EXIT.ok)
    expect(ended.stdout).toContain('Safe mode is off')
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a rollback with no recorded update, and a profile-only rollback on a profile with no history', async () => {
    const recorded = await delorun(['recover', 'rollback'])
    expect(recorded.code).toBe(EXIT.failed)
    expect(recorded.stderr).toContain('NO_UPDATE_RECORD')
    const result = await delorun(['recover', 'rollback', '--profile-only'])
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('RECOVER_REFUSED')
    expect(result.stderr).toContain('What you can do')
  })

  it('refuses a rollback whose recorded update is no longer the one `current` names, so a pointer change cannot make it a second step', async () => {
    // The record is of an update from 0.1.0 to 0.2.0, and the pointers have moved on: `current` is 0.3.0, `previous` 0.2.0.
    const path = journalPath(delorunHome, 'default')
    mkdirSync(join(delorunHome, 'run', 'default'), { recursive: true, mode: 0o700 })
    await writeJournal(path, { from: release('0.1.0'), to: release('0.2.0'), previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    for (const version of ['0.1.0', '0.2.0', '0.3.0']) mkdirSync(join(delorunHome, 'runtimes', version), { recursive: true, mode: 0o700 })
    writeFileSync(join(delorunHome, 'runtimes', 'current'), '0.3.0\n')
    writeFileSync(join(delorunHome, 'runtimes', 'previous'), '0.2.0\n')
    const journal = readFileSync(path, 'utf8')
    const result = await delorun(['recover', 'rollback'])
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('NO_UPDATE_RECORD')
    expect(readFileSync(join(delorunHome, 'runtimes', 'current'), 'utf8')).toBe('0.3.0\n')
    expect(readFileSync(join(delorunHome, 'runtimes', 'previous'), 'utf8')).toBe('0.2.0\n')
    expect(readFileSync(path, 'utf8')).toBe(journal)
  })

  it('prints what a rollback through the running home process tells the person, the chats it set aside included', async () => {
    await ensureHomeTree(delorunHome, 'default')
    await writeNewStartToken(delorunHome, 'default')
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.once('data', (chunk: string) => {
        const op = (JSON.parse(chunk.split('\n')[0]!) as { op: string }).op
        const lines = op === 'status' ? [{ ok: true, status: {} }] : [{ ok: true, phase: 'switching' }, { ok: true, outcome: 'rolled-back', lines: ['Went back from Delorun 0.3.0 to Delorun 0.1.0.', '1 chat(s) created or changed since the update are set aside in data-set-aside/0.3.0-1.'] }]
        socket.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''))
      })
    })
    await new Promise<void>((resolve) => { server.listen(updateSocketPath(delorunHome, 'default'), resolve) })
    try {
      const rolled = await delorun(['recover', 'rollback'])
      expect(rolled.code).toBe(EXIT.ok)
      expect(rolled.stdout).toBe('… switching\nWent back from Delorun 0.3.0 to Delorun 0.1.0.\n1 chat(s) created or changed since the update are set aside in data-set-aside/0.3.0-1.\nRolled back.\n')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('refuses two actions, an unknown one, a missing argument and a misplaced option as usage errors', async () => {
    for (const args of [['rollback', 'safe-mode'], ['undo'], ['restore'], ['status', '--profile-only'], ['rollback', '--reason', 'x'], ['--bogus']]) {
      const result = await delorun(['recover', ...args])
      expect(result.code).toBe(EXIT.usage)
      expect(result.stderr).toContain('Run delorun recover --help for usage.')
    }
  })

  it('lists the update record and the kept chat data in status, and removes only kept data it lists', async () => {
    mkdirSync(join(delorunHome, 'data-set-aside', '1.1.0-20261110T130000Z', 'sessions'), { recursive: true })
    writeFileSync(join(delorunHome, 'data-set-aside', '1.1.0-20261110T130000Z', 'sessions', 'chat'), 'twelve bytes')
    const status = await delorun(['recover', 'status', '--json'])
    expect(status.code).toBe(EXIT.ok)
    expect(status.stdout).toContain('No update is recorded for a rollback.')
    expect(status.stdout).toContain('Set-aside chat data: data-set-aside/1.1.0-20261110T130000Z (12 bytes)')
    const refused = await delorun(['recover', 'discard', 'sessions'])
    expect(refused.code).toBe(EXIT.failed)
    expect(refused.stderr).toContain('NOT_KEPT_DATA')
    const removed = await delorun(['recover', 'discard', 'data-set-aside/1.1.0-20261110T130000Z'])
    expect(removed.code).toBe(EXIT.ok)
    expect(existsSync(join(delorunHome, 'data-set-aside', '1.1.0-20261110T130000Z'))).toBe(false)
  })
})

describe('a rollback that reaches a root', () => {
  it('refuses with ROOT_NOT_ANCHORED, changing nothing, when no launcher named its release roots', async () => {
    const path = journalPath(delorunHome, 'default')
    mkdirSync(join(delorunHome, 'run', 'default'), { recursive: true, mode: 0o700 })
    await writeJournal(path, { from: release('0.1.0'), to: release('0.2.0'), previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    const before = readFileSync(path, 'utf8')
    let stderr = ''
    const environment: Record<string, string | undefined> = { ...process.env, HOME: osHome, USERPROFILE: osHome, DELORUN_HOME: delorunHome }
    delete environment.DELORUN_LAUNCHER_ROOTS
    const code = await main(['recover', 'rollback'], { env: environment, stdout: () => undefined, stderr: (text) => { stderr += text } })
    expect(code).toBe(EXIT.failed)
    expect(stderr).toContain('ROOT_NOT_ANCHORED')
    expect(stderr).toContain('start Delorun with its launcher')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses with GIT_UNAVAILABLE before any step when git cannot run, leaving the record and the lock untouched', async () => {
    const path = journalPath(delorunHome, 'default')
    mkdirSync(join(delorunHome, 'run', 'default'), { recursive: true, mode: 0o700 })
    await writeJournal(path, { from: release('0.1.0'), to: release('0.2.0'), previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    const before = readFileSync(path, 'utf8')
    const noGit = mkdtempSync(join(tmpdir(), 'delorun-no-git-'))
    const searchPath = process.env.PATH
    process.env.PATH = noGit
    try {
      for (const args of [['recover', 'rollback'], ['recover', 'rollback', '--profile-only']]) {
        const result = await delorun(args)
        expect(result.code).toBe(EXIT.failed)
        expect(result.stderr).toContain('GIT_UNAVAILABLE: Delorun saves and restores the profile\'s history with git, and git cannot run here: no git command is on PATH')
        expect(result.stderr).toContain('Install git, then run the same command again.')
      }
    } finally {
      process.env.PATH = searchPath
      rmSync(noGit, { recursive: true, force: true })
    }
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(join(delorunHome, 'run', 'default', 'home.lock'))).toBe(false)
  })
})

describe('a rollback with no home process running beside another profile\'s home process', () => {
  const children: ChildProcess[] = []
  const quiet: CommandContext = { env: {}, stdout: () => undefined, stderr: () => undefined }

  afterEach(async () => {
    await Promise.all(children.splice(0).map(child => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.once('exit', () => { resolve() })
      child.kill('SIGKILL')
    })))
  })

  /**
   * Start a process that registers as the home process of `work`, as `delorun start` registers one.
   * @returns the process, its exit and its standard error so far.
   */
  function otherHomeProcess(): { readonly child: ChildProcess, readonly registered: Promise<void>, readonly exited: Promise<number | null>, readonly stderr: () => string } {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', HOME_PROCESS_USER, delorunHome, 'work'], { cwd: REPOSITORY, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exited = new Promise<number | null>((resolve) => { child.once('exit', resolve) })
    const registered = new Promise<void>((resolve, reject) => {
      void exited.then((code) => { reject(new Error(`the registered process exited with ${String(code)}: ${stderr}`)) })
      createInterface({ input: child.stdout! }).once('line', () => { resolve() })
    })
    // A spec whose process is refused never awaits its registration.
    registered.catch(() => undefined)
    return { child, registered, exited, stderr: () => stderr }
  }

  /**
   * Record a committed update of `default`, which applies because no runtime is installed.
   * @returns the record's path and its text.
   */
  async function committedUpdate(): Promise<{ readonly path: string, readonly text: string }> {
    const path = journalPath(delorunHome, 'default')
    mkdirSync(join(delorunHome, 'run', 'default'), { recursive: true, mode: 0o700 })
    await writeJournal(path, { from: release('0.1.0'), to: release('0.2.0'), previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    return { path, text: readFileSync(path, 'utf8') }
  }

  /**
   * This process's registration as a user of the shared stores, when it has one.
   * @returns whether it is registered.
   */
  function registered(): boolean {
    return existsSync(join(delorunHome, 'run', DATA_USERS_DIRECTORY, String(process.pid)))
  }

  it('makes a home process that starts while it runs refuse, naming it, and releases its registration', async () => {
    const record = await committedUpdate()
    let starter: { registered: boolean, code: number | null, stderr: string } | undefined
    // The root is read between the check for other users and the `rolling-back` mark.
    const root = async (): Promise<never> => {
      const other = otherHomeProcess()
      const outcome = await Promise.race([
        other.exited.then(code => ({ registered: false, code })),
        // Its exit settles the race through `exited`.
        other.registered.then(() => ({ registered: true, code: null }), () => new Promise<never>(() => undefined)),
      ])
      starter = { ...outcome, stderr: other.stderr() }
      throw new Error('stopped before the mark')
    }
    await expect(rollbackOffline(delorunHome, 'default', false, quiet, root)).rejects.toThrow('stopped before the mark')
    expect(starter?.registered).toBe(false)
    expect(starter?.code).not.toBe(0)
    expect(starter?.stderr).toContain(`delorun start: process ${String(process.pid)} (delorun recover) is changing the stores this command uses`)
    expect(readFileSync(record.path, 'utf8')).toBe(record.text)
    expect(registered()).toBe(false)
  }, 30_000)

  it('refuses while a home process registered before it runs, before it completes an interrupted restore, and changes nothing', async () => {
    const record = await committedUpdate()
    const other = otherHomeProcess()
    await other.registered
    // A restore journal that does not read: completing it first would fail with DATA_RESTORE_INCONSISTENT instead.
    mkdirSync(join(delorunHome, 'data-copies'), { recursive: true, mode: 0o700 })
    writeFileSync(join(delorunHome, 'data-copies', 'restore.json'), '{}')
    const root = (): Promise<never> => Promise.reject(new Error('the root is not read before the refusal'))
    const refused = rollbackOffline(delorunHome, 'default', false, quiet, root)
    await expect(refused).rejects.toBeInstanceOf(DataInUseError)
    await expect(refused).rejects.toThrow(`the home process of the profile work (process ${String(other.child.pid)}) uses the chat data; wait for it to end, or stop it with delorun stop --profile work, then try again`)
    expect(readFileSync(record.path, 'utf8')).toBe(record.text)
    expect(readFileSync(join(delorunHome, 'data-copies', 'restore.json'), 'utf8')).toBe('{}')
    expect(registered()).toBe(false)
  }, 30_000)

  it('restores only the profile with --profile-only beside it, registering nothing', async () => {
    await committedUpdate()
    const other = otherHomeProcess()
    await other.registered
    const root = (): Promise<never> => Promise.reject(new Error('a profile-only rollback reads no root'))
    // The fixture profile has no history, so the profile step itself refuses.
    await expect(rollbackOffline(delorunHome, 'default', true, quiet, root)).rejects.toMatchObject({ code: 'RECOVER_REFUSED' })
    expect(registered()).toBe(false)
  }, 30_000)
})

describe('the launcher\'s rollback after the current runtime failed its start check', () => {
  it('starts the previous runtime with recover rollback, which refuses with NO_UPDATE_RECORD when no update is recorded, and the launcher exits with its status', async () => {
    const fixture = await fixtureRelease()
    mkdirSync(join(delorunHome, 'trust'), { recursive: true, mode: 0o700 })
    writeFileSync(join(delorunHome, 'trust', 'root.json'), fixture.roots[0]!, { mode: 0o600 })
    let stderr = ''
    let stdout = ''
    const status = await runLauncher({
      home: delorunHome,
      profile: 'default',
      platform: 'linux-x64',
      args: [],
      passedThrough: [],
      mode: 'enforce',
      fullCheckDays: 7,
      repairMarkGraceSeconds: 5,
      identity: { version: '0.2.0', path: join(delorunHome, 'launcher'), now: Date.now },
      roots: fixture.roots,
      logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
      channel: { resolve: () => Promise.reject(new Error('no install')), fill: () => Promise.reject(new Error('no install')) },
      store: {
        prepareLaunch: () => Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', join(delorunHome, 'runtimes', '0.2.0'), 'runtime 0.2.0 differs from its signed file list')),
        install: () => Promise.reject(new Error('no install')),
        retain: () => Promise.reject(new Error('no retention')),
        pointers: () => Promise.resolve({ current: release('0.2.0'), previous: release('0.1.0') }),
        checkRuntime: (version) => Promise.resolve({ version, manifest: fixture.manifest, files: fixture.files, manifestSha256: '0'.repeat(64) }),
        launchCommand: (_version, profile, args): LaunchCommand => ({ command: process.execPath, args: ['entry.js', ...args], env: { DELORUN_HOME: delorunHome, DELORUN_PROFILE: profile } }),
      },
      // The previous runtime's own `delorun`, run in this process with the environment launch protocol 1 sets.
      spawn: async command => (await main(command.args.slice(1), {
        env: { ...process.env, HOME: osHome, USERPROFILE: osHome, ...command.env },
        stdout: (text) => { stdout += text },
        stderr: (text) => { stderr += text },
      })) ?? EXIT.ok,
      output: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    })
    expect(status).toBe(EXIT.failed)
    expect(stderr).toContain('Delorun did not start release 0.2.0: it failed its start check. Starting release 0.1.0')
    expect(stderr).toContain('NO_UPDATE_RECORD')
    expect(stdout).toBe('')
  })
})
