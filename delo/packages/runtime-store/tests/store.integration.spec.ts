import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VERIFICATION_MODES } from '@delo/contract-verification-checks'
import { readPointerFile, renameWithRetry } from '../src/pointer.ts'
import { acquireStoreLock } from '../src/lock.ts'
import { isStoreError, RuntimeStoreError, SUPPORTED, type LauncherSupport } from '../src/index.ts'
import { closureFiles, fixtureHome, makeWritable, PLATFORM, releaseFiles, rootFile, snapshotTree, throwawayKeys, version, writeClosure, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')
const V3 = version('0.3.0')

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

/**
 * Expect a promise to reject with a store error of a code.
 * @param promise - the operation.
 * @param code - the expected code.
 * @returns the error.
 */
async function refusal(promise: Promise<unknown>, code: RuntimeStoreError['code']): Promise<RuntimeStoreError> {
  const error: unknown = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(RuntimeStoreError)
  expect((error as RuntimeStoreError).code, (error as Error).message).toBe(code)
  return error as RuntimeStoreError
}

function runtimes(): string {
  return join(fixture.home, 'runtimes')
}

/**
 * Fake timers that also reach `node:timers/promises`' `setTimeout`, which Vitest's fake timers leave real: the
 * builtin's export waits on the faked global `setTimeout`, and its ESM bindings are synced to it.
 * @returns restores the builtin's export and real timers.
 */
function fakeTimersWithPromises(): () => void {
  const builtin = createRequire(import.meta.url)('node:timers/promises') as { setTimeout: (delay?: number, value?: unknown) => Promise<unknown> }
  const real = builtin.setTimeout
  vi.useFakeTimers()
  builtin.setTimeout = async (delay, value) => new Promise((resolve) => { setTimeout(resolve, delay, value) })
  syncBuiltinESMExports()
  return () => {
    builtin.setTimeout = real
    syncBuiltinESMExports()
    vi.useRealTimers()
  }
}

function launch(launcher: LauncherSupport = SUPPORTED, mode: (typeof VERIFICATION_MODES)[number] = 'warn') {
  return fixture.store.prepareLaunch({ launcher, root: fixture.root, mode, fullCheckDays: 7, profile: 'default', args: ['status'] })
}

/** A home with 0.1.0 installed as `previous` and 0.2.0 as `current`. */
async function twoVersions(): Promise<void> {
  await fixture.install(V1)
  await fixture.install(V2)
  await fixture.store.switchTo(V1, V2)
}

describe('install', () => {
  it('installs a verified closure read-only and makes the first install current', async () => {
    await fixture.install(V1)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    expect(readFileSync(join(runtimes(), 'store.json'), 'utf8')).toBe('{"layout":1}\n')
    expect(readFileSync(join(runtimes(), 'current'), 'utf8')).toBe('0.1.0\n')
    const installation = join(runtimes(), V1)
    expect(lstatSync(installation).mode & 0o777).toBe(0o555)
    expect(lstatSync(join(installation, 'node/bin/node')).mode & 0o777).toBe(0o555)
    expect(lstatSync(join(installation, 'app/package.json')).mode & 0o777).toBe(0o444)
    expect(lstatSync(join(installation, 'app')).mode & 0o777).toBe(0o555)
    for (const name of [`delorun-${V1}.manifest.json`, `delorun-${V1}-${PLATFORM}.files.json`, `delorun-${V1}.manifest.log.json`]) expect(existsSync(join(runtimes(), name))).toBe(true)
    expect(readdirSync(join(fixture.home, 'staging'))).toEqual([])
  })

  it('leaves current unchanged when a later version installs', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
  })

  /**
   * Install a closure whose staged tree or release files the case spoils, and require that nothing lands.
   * @param spoil - changes the staged directory or the release files.
   */
  async function refusedInstall(spoil: (directory: string, files: ReturnType<typeof releaseFiles>) => ReturnType<typeof releaseFiles>): Promise<void> {
    const before = snapshotTree(runtimes())
    await refusal(fixture.store.install({
      version: V2,
      root: fixture.root,
      fill: async (directory) => {
        const files = closureFiles(V2)
        writeClosure(directory, files)
        return Promise.resolve(spoil(directory, releaseFiles(fixture.keys.targets, V2, files)))
      },
    }), 'INSTALL_VERIFY_FAILED')
    expect(existsSync(join(runtimes(), V2))).toBe(false)
    expect(readdirSync(join(fixture.home, 'staging'))).toEqual([])
    expect(snapshotTree(runtimes())).toEqual(before)
  }

  it('refuses a manifest signed by a key outside the targets role before anything lands', async () => {
    await fixture.install(V1)
    const outsider = throwawayKeys().targets
    await refusedInstall(() => releaseFiles(outsider, V2, closureFiles(V2)))
  })

  it('seals the staged tree before it hashes it, so no writable window sits between the digest and the installed modes', async () => {
    const files = closureFiles(V1)
    await fixture.store.install({
      version: V1,
      root: fixture.root,
      fill: async (directory) => {
        writeClosure(directory, files)
        // The fill step leaves one file write-only: hashing it before the installed modes are set fails on the read,
        // so only a seal that runs first reaches the bytes the signed list names.
        chmodSync(join(directory, 'app/package.json'), 0o200)
        return Promise.resolve(releaseFiles(fixture.keys.targets, V1, files))
      },
    })
    expect(lstatSync(join(runtimes(), V1, 'app/package.json')).mode & 0o777).toBe(0o444)
  })

  it('refuses a staged file whose bytes differ from the file list', async () => {
    await fixture.install(V1)
    await refusedInstall((directory, files) => {
      writeFileSync(join(directory, 'app/package.json'), '{"name":"changed"}\n')
      return files
    })
  })

  it('refuses an extra staged file and a symbolic link', async () => {
    await fixture.install(V1)
    await refusedInstall((directory, files) => {
      writeFileSync(join(directory, 'app/extra.js'), 'extra\n')
      return files
    })
    await refusedInstall((directory, files) => {
      symlinkSync('/etc/passwd', join(directory, 'app/link'))
      return files
    })
  })

  it('refuses a file list for another release', async () => {
    await fixture.install(V1)
    await refusedInstall((_directory, files) => ({ ...files, manifest: releaseFiles(fixture.keys.targets, V3, closureFiles(V2)).manifest }))
  })
})

describe('pointers', () => {
  it.each([
    ['missing', () => { rmSync(join(runtimes(), 'current')) }],
    ['empty', () => { writeFileSync(join(runtimes(), 'current'), '') }],
    ['without its newline', () => { writeFileSync(join(runtimes(), 'current'), '0.1.0') }],
    ['oversized', () => { writeFileSync(join(runtimes(), 'current'), `${'1'.repeat(70)}\n`) }],
    ['not a version', () => { writeFileSync(join(runtimes(), 'current'), '../etc\n') }],
    ['naming a version that is not installed', () => { writeFileSync(join(runtimes(), 'current'), '9.9.9\n') }],
    ['a symbolic link', () => { rmSync(join(runtimes(), 'current')); symlinkSync(join(runtimes(), 'previous'), join(runtimes(), 'current')) }],
  ])('reads a current pointer that is %s as NO_ACTIVE_RUNTIME', async (_case, spoil) => {
    await fixture.install(V1)
    writeFileSync(join(runtimes(), 'previous'), '0.1.0\n')
    spoil()
    await refusal(fixture.store.pointers(), 'NO_ACTIVE_RUNTIME')
    await refusal(launch(), 'NO_ACTIVE_RUNTIME')
  })
})

describe('switching and retention', () => {
  it('writes previous with the old version and current with the new one', async () => {
    await twoVersions()
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
    expect(readFileSync(join(runtimes(), 'previous'), 'utf8')).toBe('0.1.0\n')
    expect(lstatSync(join(runtimes(), 'current')).mode & 0o777).toBe(0o600)
  })

  it('refuses a switch from a version current does not name, or to one that is not installed', async () => {
    await twoVersions()
    await refusal(fixture.store.switchTo(V1, V2), 'POINTER_CHANGED')
    await refusal(fixture.store.switchTo(V2, V3), 'NOT_INSTALLED')
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
  })

  it('retains the previous version and removes every other version, staging directory and temporary file', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    await fixture.install(V3)
    await fixture.store.switchTo(V2, V3)
    mkdirSync(join(fixture.home, 'staging', '0123456789abcdef'))
    writeFileSync(join(runtimes(), 'current.tmp-0123456789abcdef'), '0.1.0\n')
    writeFileSync(join(runtimes(), 'unrelated.txt'), 'left alone\n')
    const result = await fixture.store.retain()
    expect(result.failed).toEqual([])
    expect(readdirSync(runtimes()).sort()).toEqual([
      '0.2.0', '0.3.0', 'current',
      'delorun-0.2.0-linux-x64.files.json', 'delorun-0.2.0.manifest.json', 'delorun-0.2.0.manifest.log.json',
      'delorun-0.3.0-linux-x64.files.json', 'delorun-0.3.0.manifest.json', 'delorun-0.3.0.manifest.log.json',
      'previous', 'store.json', 'unrelated.txt',
    ])
    expect(readdirSync(join(fixture.home, 'staging'))).toEqual([])
    expect(await fixture.store.pointers()).toEqual({ current: V3, previous: V2 })
    await expect(fixture.store.checkRuntime(V2, fixture.root)).resolves.toMatchObject({ version: V2 })
  })

  it('removes nothing when current cannot be read', async () => {
    await twoVersions()
    writeFileSync(join(runtimes(), 'current'), 'garbage\n')
    const before = snapshotTree(runtimes())
    await refusal(fixture.store.retain(), 'NO_ACTIVE_RUNTIME')
    expect(snapshotTree(runtimes())).toEqual(before)
  })
})

describe('rollback', () => {
  /**
   * Every entry of the home outside `runtimes/`.
   * @returns the snapshot.
   */
  function outsideRuntimes(): Record<string, string> {
    return Object.fromEntries(Object.entries(snapshotTree(fixture.home)).filter(([path]) => path !== 'runtimes' && !path.startsWith('runtimes/')))
  }

  it('switches back to the previous version and changes no file outside runtimes/', async () => {
    await twoVersions()
    mkdirSync(join(fixture.home, 'profiles/default'), { recursive: true })
    writeFileSync(join(fixture.home, 'profiles/default/cordis.patch.yml'), 'plugins: {}\n')
    writeFileSync(join(fixture.home, 'trust/root.json'), rootFile(fixture.keys).bytes, { mode: 0o600 })
    const before = outsideRuntimes()
    await fixture.store.switchTo(V2, V1)
    expect(await fixture.store.pointers()).toEqual({ current: V1, previous: V2 })
    await fixture.store.retain()
    expect(outsideRuntimes()).toEqual(before)
    await expect(launch()).resolves.toMatchObject({ version: V1 })
  })

  it('restores both pointers, removing a previous that was absent', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    const before = await fixture.store.pointers()
    await fixture.store.switchTo(V1, V2)
    const outside = outsideRuntimes()
    await fixture.store.restore(before)
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    expect(existsSync(join(runtimes(), 'previous'))).toBe(false)
    expect(outsideRuntimes()).toEqual(outside)
  })

})

describe('the start check', () => {
  /**
   * Change an installed file of the current version, as a person or process with their access could.
   * @param change - the change, given the installation's directory.
   */
  function tamper(change: (installation: string) => void): void {
    const installation = join(runtimes(), V2)
    makeWritable(installation)
    change(installation)
  }

  it.each(VERIFICATION_MODES)('stops the launch on one changed byte in %s mode and offers reinstall and rollback', async (mode) => {
    await twoVersions()
    tamper((installation) => {
      const path = join(installation, 'app/node_modules/@delo/cli/src/bin.js')
      const bytes = readFileSync(path)
      bytes[0] = bytes[0]! ^ 0x01
      rmSync(path)
      writeFileSync(path, bytes)
    })
    const error = await refusal(launch(SUPPORTED, mode), 'RUNTIME_CHANGED')
    expect(error.message).toContain('app/node_modules/@delo/cli/src/bin.js (sha256)')
    expect(error.message).toContain(`verification mode ${mode}`)
    expect(error.remedies).toEqual(['reinstall', 'rollback'])
  })

  it.each([
    ['an extra file', (installation: string) => { writeFileSync(join(installation, 'app/extra.js'), 'extra\n') }, 'app/extra.js (extra)'],
    ['a missing file', (installation: string) => { rmSync(join(installation, 'node/LICENSE')) }, 'node/LICENSE (missing)'],
    ['a file replaced by a symbolic link', (installation: string) => {
      const path = join(installation, 'app/package.json')
      renameSync(path, join(installation, 'moved.json'))
      symlinkSync(join(installation, 'moved.json'), path)
    }, 'app/package.json (not-regular)'],
    ['a file of another length', (installation: string) => { writeFileSync(join(installation, 'node/LICENSE'), 'licence, longer\n') }, 'node/LICENSE (length)'],
  ])('stops the launch on %s', async (_case, change, problem) => {
    await twoVersions()
    tamper(change)
    const error = await refusal(launch(), 'RUNTIME_CHANGED')
    expect(error.message).toContain(problem)
  })

  it('stops the launch when the stored file list or manifest does not verify', async () => {
    await twoVersions()
    const listPath = join(runtimes(), `delorun-${V2}-${PLATFORM}.files.json`)
    makeWritable(runtimes())
    const list = readFileSync(listPath, 'utf8')
    rmSync(listPath)
    writeFileSync(listPath, list.replace('"0644"', '"0755"'))
    await refusal(launch(), 'RUNTIME_CHANGED')
  })

  it('stops the launch when the root revokes the key that signed the runtime', async () => {
    await twoVersions()
    const { metadata: revoking } = rootFile(fixture.keys, 'revoked', throwawayKeys().targets)
    await refusal(fixture.store.prepareLaunch({ launcher: SUPPORTED, root: revoking, mode: 'warn', fullCheckDays: 7, profile: 'default', args: [] }), 'RUNTIME_CHANGED')
    await refusal(fixture.store.checkRuntime(V2, revoking), 'RUNTIME_CHANGED')
  })

  it('launches an intact current with launch protocol 1', async () => {
    await twoVersions()
    const plan = await launch()
    expect(plan).toEqual({
      version: V2,
      check: expect.objectContaining({ hashed: expect.any(Number), files: expect.any(Number) }),
      command: join(runtimes(), V2, 'node/bin/node'),
      args: [join(runtimes(), V2, 'app/node_modules/@delo/cli/src/bin.js'), 'status'],
      env: { DSH_HOME: fixture.home, DELO_HOME: fixture.home, DELO_PROFILE: 'default' },
    })
  })
})

describe('launcher and store compatibility', () => {
  it('leaves current and previous byte-identical under a newer launcher, which still runs current', async () => {
    await twoVersions()
    await fixture.install(V3)
    const before = snapshotTree(runtimes())
    const newer: LauncherSupport = { storeLayouts: [1, 2], launchProtocols: [1, 2] }
    await expect(launch(newer)).resolves.toMatchObject({ version: V2 })
    expect(snapshotTree(runtimes())).toEqual(before)
  })

  it('stops an older launcher on a newer store layout, offers a launcher update and writes nothing', async () => {
    await twoVersions()
    makeWritable(runtimes())
    rmSync(join(runtimes(), 'store.json'))
    writeFileSync(join(runtimes(), 'store.json'), '{"layout":2}\n')
    const before = snapshotTree(runtimes())
    const error = await refusal(launch(SUPPORTED), 'RUNTIME_INCOMPATIBLE')
    expect(error.message).toContain('layout 2')
    expect(error.remedies).toEqual(['launcher-update'])
    expect(snapshotTree(runtimes())).toEqual(before)
  })

  it('stops a launcher whose protocols are all newer than the runtime and offers the update flow', async () => {
    await twoVersions()
    const before = snapshotTree(runtimes())
    const error = await refusal(launch({ storeLayouts: [1], launchProtocols: [2] }), 'RUNTIME_INCOMPATIBLE')
    expect(error.message).toContain('launch protocol 1')
    expect(error.remedies).toEqual(['update'])
    expect(snapshotTree(runtimes())).toEqual(before)
  })

  it('stops a runtime that lacks the launch protocol entry file', async () => {
    const files = closureFiles(V1)
    delete files['app/node_modules/@delo/cli/src/bin.js']
    await fixture.install(V1, files)
    await refusal(launch(), 'RUNTIME_INCOMPATIBLE')
  })
})

describe('store.lock', () => {
  it('waits for a live holder and stops with STORE_BUSY', async () => {
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    try {
      writeFileSync(join(runtimes(), 'store.lock'), JSON.stringify({ v: 1, pid: holder.pid, id: 'a'.repeat(32) }))
      const started = Date.now()
      const error = await refusal(acquireStoreLock(join(runtimes(), 'store.lock'), 300), 'STORE_BUSY')
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
      expect(error.message).toContain(String(holder.pid))
    } finally {
      holder.kill('SIGKILL')
    }
  })

  it('replaces a lock whose process no longer exists', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', timeout: 30_000 })
    expect(dead.status, `signal ${String(dead.signal)}: ${dead.stderr}`).toBe(0)
    writeFileSync(join(runtimes(), 'store.lock'), JSON.stringify({ v: 1, pid: Number(dead.stdout.trim()), id: 'b'.repeat(32) }))
    const lock = await acquireStoreLock(join(runtimes(), 'store.lock'), 300)
    expect(JSON.parse(readFileSync(join(runtimes(), 'store.lock'), 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
    expect(existsSync(join(runtimes(), 'store.lock'))).toBe(false)
  })

  it('refuses a lock file that is not a record', async () => {
    writeFileSync(join(runtimes(), 'store.lock'), 'not json')
    await expect(acquireStoreLock(join(runtimes(), 'store.lock'), 300)).rejects.toThrow('is not a store lock record')
  })
})

describe('pointer replacement', () => {
  it('retries a busy Windows rename and then succeeds', async () => {
    let calls = 0
    await renameWithRetry('a', 'b', 'win32', () => {
      calls += 1
      return calls < 3 ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : Promise.resolve()
    })
    expect(calls).toBe(3)
  })

  it('gives up on a Windows rename after 2,000 ms, and never retries elsewhere', async () => {
    const busy = () => Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' }))
    const restore = fakeTimersWithPromises()
    try {
      const started = Date.now()
      const attempts: number[] = []
      let settled = false
      const given = renameWithRetry('a', 'b', 'win32', () => { attempts.push(Date.now() - started); return busy() }).catch((error: unknown) => { settled = true; return error })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await given).toMatchObject({ message: 'busy' })
      expect(attempts.length).toBeGreaterThan(2)
      expect([attempts[0], attempts.at(-1)]).toEqual([0, 2_000])
    } finally {
      restore()
    }
    let calls = 0
    await expect(renameWithRetry('a', 'b', 'linux', () => { calls += 1; return busy() })).rejects.toThrow('busy')
    expect(calls).toBe(1)
  })

  it('reads a pointer that is a directory or a FIFO as malformed without blocking', async () => {
    mkdirSync(join(runtimes(), 'current'))
    expect(await readPointerFile(join(runtimes(), 'current'))).toBe('malformed')
    rmSync(join(runtimes(), 'current'), { recursive: true })
    execFileSync('mkfifo', [join(runtimes(), 'current')], { timeout: 30_000 })
    expect(await readPointerFile(join(runtimes(), 'current'))).toBe('malformed')
  })

  it('reports isStoreError by code', () => {
    const error = new RuntimeStoreError('STORE_BUSY', '/x', 'busy')
    expect(isStoreError(error, 'STORE_BUSY')).toBe(true)
    expect(isStoreError(error, 'NO_PREVIOUS')).toBe(false)
  })
})
