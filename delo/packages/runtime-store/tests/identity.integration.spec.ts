/**
 * The start check's identity record (contract C2, design `delo/docs/design/start-check.md`): what a start compares
 * instead of hashing, every way the record falls back to the full hash, the documented limit of a forged record, the
 * full hash `delorun verify` and the schedule always run, and an install that hashes each file once, as it writes it.
 * A spec that needs a settled record moves `Date` past the racy window, because a change time cannot be set back.
 */
import { type BigIntStats, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, writeSync, chmodSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { acquireStoreLock } from '../src/lock.ts'
import { identityOf, installedFileMode, resolveFullCheckDays, RuntimeStoreError, SUPPORTED, type FilledRelease } from '../src/index.ts'
import { IDENTITY_SCHEMA, readIdentityRecord, trustedFileSystem } from '../src/identity.ts'
import { describeProblems, examineTree } from '../src/tree.ts'
import { closureFiles, fixtureHome, PLATFORM, releaseFiles, version, writeClosure, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const TARGET = 'app/node_modules/@delo/cli/src/bin.js'
const DAY_MS = 86_400_000

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fixture.remove()
})

/** The record's JSON fields, as a spec edits them. */
type RecordJson = Record<string, unknown> & { files: (string | null)[], fullCheckAt: number, capturedAt: number }

function installation(): string {
  return join(fixture.home, 'runtimes', V1)
}

function recordPath(): string {
  return join(fixture.home, 'trust', 'runtime-files', `delorun-${V1}-${PLATFORM}.json`)
}

function readRecord(): RecordJson {
  return JSON.parse(readFileSync(recordPath(), 'utf8')) as RecordJson
}

function writeRecord(record: unknown, text = `${JSON.stringify(record)}\n`): void {
  rmSync(recordPath(), { force: true })
  writeFileSync(recordPath(), text, { mode: 0o600 })
}

/** The list's index of a path, from the stored file list. */
function indexOf(path: string): number {
  const list = JSON.parse(readFileSync(join(fixture.home, 'runtimes', `delorun-${V1}-${PLATFORM}.files.json`), 'utf8')) as { signed: { files: Array<{ path: string }> } }
  return list.signed.files.findIndex(file => file.path === path)
}

function file(path: string): string {
  return join(installation(), ...path.split('/'))
}

/** Move `Date` by an offset, which then keeps advancing with real time, as a clock does; timers stay real. */
function advance(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(Date.now() + ms)
}

function launch(fullCheckDays = 7) {
  return fixture.store.prepareLaunch({ launcher: SUPPORTED, root: fixture.root, mode: 'enforce', fullCheckDays, profile: 'default', args: [] })
}

async function refusal(promise: Promise<unknown>): Promise<RuntimeStoreError> {
  const error: unknown = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(RuntimeStoreError)
  expect((error as RuntimeStoreError).code).toBe('RUNTIME_CHANGED')
  return error as RuntimeStoreError
}

/**
 * Install 0.1.0 with whole-second times on the target file, then let the racy window pass and run the full check, so
 * the record vouches for every file.
 */
async function settledInstall(): Promise<void> {
  await fixture.install(V1)
  utimesSync(file(TARGET), 1_700_000_000, 1_700_000_000)
  advance(3_000)
  await fixture.store.checkRuntime(V1, fixture.root)
  expect(readRecord().files.every(entry => entry !== null)).toBe(true)
  // `Date` moved, so the record counts as settled; let the kernel's clock move past the recorded change times too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
}

/**
 * Rewrite a file's bytes in place with the same length, then restore its mode and its whole-second times, so only its
 * change time differs.
 * @param path - the list path.
 */
function changeInPlace(path: string): void {
  const target = file(path)
  const before = lstatSync(target)
  chmodSync(target, 0o644)
  const descriptor = openSync(target, 'r+')
  writeSync(descriptor, Buffer.from('X'), 0, 1, 0)
  closeSync(descriptor)
  chmodSync(target, before.mode & 0o777)
  utimesSync(target, 1_700_000_000, 1_700_000_000)
  const after = lstatSync(target, { bigint: true })
  expect([after.ino, after.size, after.mode, after.mtimeNs]).toEqual([BigInt(before.ino), BigInt(before.size), BigInt(before.mode), 1_700_000_000_000_000_000n])
}

/** Change the target in place and write a record whose entry vouches for its new identity, as a forger would. */
function forgeRecord(): RecordJson {
  changeInPlace(TARGET)
  const record = readRecord()
  record.files[indexOf(TARGET)] = identityOf(lstatSync(file(TARGET), { bigint: true }))
  writeRecord(record)
  return record
}

/**
 * Replace `node:fs/promises`' `statfs` for the spec.
 * @param replacement - the replacement.
 */
function replaceStatfs(replacement: (path: string) => Promise<{ readonly type: number }>): void {
  const builtin = createRequire(import.meta.url)('node:fs/promises') as { statfs: unknown }
  const real = builtin.statfs
  builtin.statfs = replacement
  syncBuiltinESMExports()
  onTestFinished(() => {
    builtin.statfs = real
    syncBuiltinESMExports()
  })
}

/**
 * Replace `node:fs`'s `lstatSync` for the spec.
 * @param replacement - the replacement, given the real function.
 */
function replaceLstat(replacement: (real: typeof lstatSync) => typeof lstatSync): void {
  const builtin = createRequire(import.meta.url)('node:fs') as { lstatSync: typeof lstatSync }
  const real = builtin.lstatSync
  builtin.lstatSync = replacement(real)
  syncBuiltinESMExports()
  onTestFinished(() => {
    builtin.lstatSync = real
    syncBuiltinESMExports()
  })
}

describe('a start with a settled record', () => {
  it('hashes nothing and leaves the record when every identity matches', async () => {
    await settledInstall()
    const before = lstatSync(recordPath(), { bigint: true })
    await expect(launch()).resolves.toMatchObject({ version: V1 })
    expect(lstatSync(recordPath(), { bigint: true }).ino).toBe(before.ino)
    expect(lstatSync(recordPath()).mode & 0o777).toBe(0o600)
  })

  it('c02-start-catches-in-place-change: a changed byte with size, mode and modification time restored stops the start', async () => {
    await settledInstall()
    const record = readFileSync(recordPath())
    changeInPlace(TARGET)
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
    expect(readFileSync(recordPath())).toEqual(record)
  })

  it('c02-start-catches-renamed-replacement: a file renamed over the original with its size, mode and times stops the start', async () => {
    await settledInstall()
    const original = lstatSync(file(TARGET))
    const parent = join(installation(), 'app/node_modules/@delo/cli/src')
    chmodSync(parent, 0o755)
    const replacement = join(parent, 'replacement')
    writeFileSync(replacement, `X${readFileSync(file(TARGET), 'utf8').slice(1)}`, { mode: original.mode & 0o777 })
    utimesSync(replacement, 1_700_000_000, 1_700_000_000)
    renameSync(replacement, file(TARGET))
    chmodSync(parent, 0o555)
    const now = lstatSync(file(TARGET))
    expect([now.size, now.mode, now.mtimeMs]).toEqual([original.size, original.mode, original.mtimeMs])
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
  })

  it.each([
    ['an extra file', () => { chmodSync(join(installation(), 'app'), 0o755); writeFileSync(join(installation(), 'app/extra.js'), 'extra\n') }, 'app/extra.js (extra)'],
    ['a missing file', () => { chmodSync(join(installation(), 'node'), 0o755); rmSync(file('node/LICENSE')) }, 'node/LICENSE (missing)'],
    ['a symbolic link in place of a file', () => {
      chmodSync(join(installation(), 'app'), 0o755)
      renameSync(file('app/package.json'), join(installation(), 'app/moved.json'))
      symlinkSync('moved.json', file('app/package.json'))
    }, 'app/package.json (not-regular)'],
  ])('stops the start on %s', async (_case, change, problem) => {
    await settledInstall()
    change()
    expect((await refusal(launch())).message).toContain(problem)
  })

  it('re-hashes a file whose mode changed, and a passing re-hash records its new identity, keeping the full pass time', async () => {
    await settledInstall()
    const before = readRecord()
    chmodSync(file('node/LICENSE'), 0o555)
    advance(3_000)
    await expect(launch()).resolves.toMatchObject({ version: V1 })
    const after = readRecord()
    expect(after.files[indexOf('node/LICENSE')]).toBe(identityOf(lstatSync(file('node/LICENSE'), { bigint: true })))
    expect(after.fullCheckAt).toBe(before.fullCheckAt)
    expect(after.capturedAt).toBeGreaterThan(before.capturedAt)
  })

  it('re-hashes a file that reports another device than the installation, whose identity otherwise matches', async () => {
    await settledInstall()
    forgeRecord()
    const target = file(TARGET)
    replaceLstat(real => ((path: string, options?: object) => {
      const stats = real(path, options as { bigint: true })
      return path === target && typeof stats.dev === 'bigint' ? Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as BigIntStats, stats, { dev: stats.dev + 1n }) : stats
    }) as typeof lstatSync)
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
  })

  it('re-hashes a racy entry, whose change time is within 2 s of the capture, until a capture leaves it behind', async () => {
    await settledInstall()
    const record = forgeRecord()
    record.capturedAt = Number(lstatSync(file(TARGET), { bigint: true }).ctimeNs / 1_000_000n) + 1_000
    writeRecord(record)
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
  })

  it('logs a store.lock it cannot take for another reason than a holder at warn, and starts', async () => {
    await settledInstall()
    chmodSync(file('node/LICENSE'), 0o555)
    const runtimes = join(fixture.home, 'runtimes')
    chmodSync(runtimes, 0o500)
    try {
      await expect(launch()).resolves.toMatchObject({ version: V1 })
    } finally {
      chmodSync(runtimes, 0o700)
    }
    expect(fixture.logger.records.some(entry => entry.level === 'warn' && entry.msg.includes('could not take store.lock'))).toBe(true)
    expect(fixture.logger.records.some(entry => entry.level === 'info')).toBe(false)
  })

  it('refuses with RUNTIME_CHANGED when the installation vanishes while the start binds its record', async () => {
    await settledInstall()
    const away = join(fixture.home, 'staging', 'away')
    replaceStatfs(async () => {
      chmodSync(installation(), 0o700)
      renameSync(installation(), away)
      return Promise.resolve({ type: 0xEF53 })
    })
    try {
      expect((await refusal(launch())).message).toContain('cannot be checked')
    } finally {
      renameSync(away, installation())
    }
  })

  it('leaves the record unwritten while another operation holds store.lock', async () => {
    await settledInstall()
    chmodSync(file('node/LICENSE'), 0o555)
    const before = readFileSync(recordPath())
    const lock = await acquireStoreLock(join(fixture.home, 'runtimes', 'store.lock'), 0)
    try {
      await expect(launch()).resolves.toMatchObject({ version: V1 })
    } finally {
      await lock.release()
    }
    expect(readFileSync(recordPath())).toEqual(before)
    expect(fixture.logger.records.some(entry => entry.level === 'info' && entry.msg.includes('store.lock'))).toBe(true)
  })

  it.each<[string, string]>([
    ['whose directory refuses the write', 'runtime-files'],
    ['whose directory cannot be created', '.'],
  ])('logs a record %s, and starts', async (_case, locked) => {
    await settledInstall()
    chmodSync(file('node/LICENSE'), 0o555)
    if (locked === '.') rmSync(join(fixture.home, 'trust', 'runtime-files'), { recursive: true })
    const directory = join(fixture.home, 'trust', locked)
    chmodSync(directory, 0o500)
    try {
      await expect(launch()).resolves.toMatchObject({ version: V1 })
    } finally {
      chmodSync(directory, 0o700)
    }
    expect(fixture.logger.records.some(entry => entry.level === 'warn' && entry.msg.includes('could not record'))).toBe(true)
  })
})

describe('the documented limit and the full hash', () => {
  it('c02-start-record-forgery-out-of-scope: a record rewritten to a changed file\'s identity lets the start pass', async () => {
    await settledInstall()
    forgeRecord()
    await expect(launch()).resolves.toMatchObject({ version: V1 })
  })

  it('c02-verify-always-hashes: the full check hashes every file even when every identity matches the record', async () => {
    await settledInstall()
    forgeRecord()
    expect((await refusal(fixture.store.checkRuntime(V1, fixture.root))).message).toContain(`${TARGET} (sha256)`)
  })

  it('the full check on request leaves a record that holds every identity it read, and writes a missing or rebound one', async () => {
    await settledInstall()
    const before = lstatSync(recordPath(), { bigint: true })
    await fixture.store.checkRuntime(V1, fixture.root)
    expect(lstatSync(recordPath(), { bigint: true }).ino).toBe(before.ino)
    const record = readRecord()
    record['rootInode'] = '1'
    writeRecord(record)
    await fixture.store.checkRuntime(V1, fixture.root)
    expect(readRecord()['rootInode']).not.toBe('1')
    rmSync(recordPath())
    await fixture.store.checkRuntime(V1, fixture.root)
    expect(existsSync(recordPath())).toBe(true)
  })

  it.each([
    ['older than the interval', (record: RecordJson) => { record.fullCheckAt = Date.now() - 8 * DAY_MS }, 7],
    ['later than the clock', (record: RecordJson) => { record.fullCheckAt = Date.now() + DAY_MS }, 7],
    ['any age, with an interval of 0', () => undefined, 0],
    ['recent, with a capture time later than the clock', (record: RecordJson) => { record.fullCheckAt = Date.now() - 1_000; record.capturedAt = Date.now() + DAY_MS }, 7],
  ])('c02-start-periodic-full-hash: a last full pass %s makes the start hash every file', async (_case, change, days) => {
    await settledInstall()
    const record = forgeRecord()
    change(record)
    writeRecord(record)
    expect((await refusal(launch(days))).message).toContain(`${TARGET} (sha256)`)
  })

  it('keeps the record while the last full pass is within the interval', async () => {
    await settledInstall()
    const record = forgeRecord()
    record.fullCheckAt = Date.now() - 8 * DAY_MS
    writeRecord(record)
    await expect(launch(30)).resolves.toMatchObject({ version: V1 })
  })

  it('c02-start-missing-record-hashes-every-file: without a record, a changed file stops the start', async () => {
    await settledInstall()
    rmSync(recordPath())
    changeInPlace(TARGET)
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
    expect(existsSync(recordPath())).toBe(false)
  })

  it('a missing record makes the start hash every file and write a new record', async () => {
    await settledInstall()
    rmSync(recordPath())
    advance(DAY_MS)
    await expect(launch()).resolves.toMatchObject({ version: V1 })
    expect(readRecord().fullCheckAt).toBeGreaterThanOrEqual(Date.now() - 1_000)
  })

  it.each<[string, (record: RecordJson) => string | undefined]>([
    ['truncated', record => JSON.stringify(record).slice(0, 100)],
    ['not JSON', () => 'not json\n'],
    ['not an object', () => '[]\n'],
    ['null', () => 'null\n'],
    ['of another schema', (record) => { record['schema'] = 'delo.runtime-identity/2'; return undefined }],
    ['with an extra field', (record) => { record['extra'] = 1; return undefined }],
    ['of another version', (record) => { record['version'] = '0.2.0'; return undefined }],
    ['of another platform', (record) => { record['platform'] = 'darwin-arm64'; return undefined }],
    ['of another file list', (record) => { record['fileList'] = '0'.repeat(64); return undefined }],
    ['of another manifest', (record) => { record['manifest'] = '0'.repeat(64); return undefined }],
    ['of another installation root', (record) => { record['rootInode'] = '1'; return undefined }],
    ['of another file system', (record) => { record['fileSystem'] = 0x6969; return undefined }],
    ['with one entry too few', (record) => { record.files.pop(); return undefined }],
    ['with a version that is not text', (record) => { record['version'] = 1; return undefined }],
    ['with a platform that is not text', (record) => { record['platform'] = 1; return undefined }],
    ['with a file list digest that is not one', (record) => { record['fileList'] = 'abc'; return undefined }],
    ['with a manifest digest that is not one', (record) => { record['manifest'] = 1; return undefined }],
    ['with a root inode that is not a number', (record) => { record['rootInode'] = 'x'; return undefined }],
    ['with a root inode that is not text', (record) => { record['rootInode'] = 1; return undefined }],
    ['with a file system that is not a whole number', (record) => { record['fileSystem'] = -1; return undefined }],
    ['with a capture time that is not a number', (record) => { Reflect.set(record, 'capturedAt', '1'); return undefined }],
    ['with a full pass time that is not whole', (record) => { record['fullCheckAt'] = 1.5; return undefined }],
    ['with files that are not a list', (record) => { Reflect.set(record, 'files', {}); return undefined }],
    ['with an entry that is not an identity', (record) => { record.files[0] = 'not an identity'; return undefined }],
  ])('c02-start-missing-record-hashes-every-file: a record %s makes the start hash every file', async (_case, spoil) => {
    await settledInstall()
    const record = forgeRecord()
    const text = spoil(record)
    writeRecord(record, text)
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
  })

  it.each<[string, () => void]>([
    ['a symbolic link', () => { renameSync(recordPath(), `${recordPath()}.real`); symlinkSync(`${recordPath()}.real`, recordPath()) }],
    ['readable by others', () => { chmodSync(recordPath(), 0o644) }],
    ['a directory', () => { rmSync(recordPath()); mkdirSync(recordPath()) }],
    ['larger than its limit', () => { chmodSync(recordPath(), 0o600); truncateSync(recordPath(), 64 * 1024 * 1024 + 1) }],
    ['owned by another user', () => { vi.spyOn(process, 'getuid').mockReturnValue(statSync(recordPath()).uid + 1) }],
  ])('c02-start-missing-record-hashes-every-file: a record that is %s makes the start hash every file', async (_case, spoil) => {
    await settledInstall()
    forgeRecord()
    spoil()
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
  })
})

describe('the start check on request, which an update runs on the running runtime and its target', () => {
  it('c02-update-start-check-catches-in-place-change: a changed byte with size, mode and modification time restored is refused', async () => {
    await settledInstall()
    changeInPlace(TARGET)
    expect((await refusal(fixture.store.startCheckRuntime(V1, fixture.root, 7))).message).toContain(`${TARGET} (sha256)`)
  })

  it('compares identities as a launch does: a forged record passes, the documented limit, while the full check refuses', async () => {
    await settledInstall()
    forgeRecord()
    await expect(fixture.store.startCheckRuntime(V1, fixture.root, 7)).resolves.toMatchObject({ version: V1 })
    await refusal(fixture.store.checkRuntime(V1, fixture.root))
  })

  it.each([
    ['no record', () => { rmSync(recordPath()) }, 7],
    ['a last full pass older than the interval', () => {
      const record = readRecord()
      record.fullCheckAt = Date.now() - 8 * DAY_MS
      writeRecord(record)
    }, 7],
    ['an interval of 0', () => undefined, 0],
  ])('hashes every file with %s, as a launch does', async (_case, change, days) => {
    await settledInstall()
    forgeRecord()
    change()
    expect((await refusal(fixture.store.startCheckRuntime(V1, fixture.root, days))).message).toContain(`${TARGET} (sha256)`)
  })

  it('shares an earlier check of the version in one scope, but a full check never shares a start check', async () => {
    await settledInstall()
    forgeRecord()
    await fixture.store.shareChecks(async () => {
      await expect(fixture.store.startCheckRuntime(V1, fixture.root, 7)).resolves.toMatchObject({ version: V1 })
      expect((await refusal(fixture.store.checkRuntime(V1, fixture.root))).message).toContain(`${TARGET} (sha256)`)
    })
  })

  it('shares an earlier full check in one scope, and checks again in a later scope', async () => {
    await settledInstall()
    await fixture.store.shareChecks(async () => {
      await fixture.store.checkRuntime(V1, fixture.root)
      changeInPlace(TARGET)
      await expect(fixture.store.startCheckRuntime(V1, fixture.root, 7)).resolves.toMatchObject({ version: V1 })
    })
    await fixture.store.shareChecks(async () => {
      expect((await refusal(fixture.store.startCheckRuntime(V1, fixture.root, 7))).message).toContain(`${TARGET} (sha256)`)
    })
  })
})

describe('file systems whose change times are not trusted', () => {
  it.each<[string, () => void]>([
    ['NFS', () => { replaceStatfs(() => Promise.resolve({ type: 0x6969 })) }],
    ['a file system that cannot be named', () => { replaceStatfs(() => Promise.reject(new Error('statfs failed'))) }],
    ['macOS', () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
      onTestFinished(() => { Object.defineProperty(process, 'platform', platform) })
    }],
  ])('%s makes the start hash every file and write no record', async (_case, untrusted) => {
    await settledInstall()
    forgeRecord()
    untrusted()
    expect((await refusal(launch())).message).toContain(`${TARGET} (sha256)`)
    expect(await trustedFileSystem(installation())).toBeUndefined()
  })

  it('an install, a start and a retention on such a file system write and need no record', async () => {
    replaceStatfs(() => Promise.resolve({ type: 0x6969 }))
    await fixture.install(V1)
    await expect(launch()).resolves.toMatchObject({ version: V1 })
    expect(existsSync(join(fixture.home, 'trust', 'runtime-files'))).toBe(false)
    await expect(fixture.store.retain()).resolves.toEqual({ removed: [], failed: [] })
  })

  it('an unprivileged process cannot set a change time back on each trusted file system this machine has', async () => {
    const candidates = [tmpdir(), '/dev/shm']
    let tried = 0
    for (const directory of candidates) {
      if (!existsSync(directory) || await trustedFileSystem(directory) === undefined) continue
      tried++
      const path = join(directory, `delo-ctime-${String(process.pid)}`)
      writeFileSync(path, 'before\n')
      try {
        const before = lstatSync(path, { bigint: true })
        await new Promise(resolve => setTimeout(resolve, 20))
        writeFileSync(path, 'after!\n')
        utimesSync(path, Number(before.atimeNs / 1_000_000n) / 1000, Number(before.mtimeNs / 1_000_000n) / 1000)
        expect(lstatSync(path, { bigint: true }).ctimeNs).toBeGreaterThan(before.ctimeNs)
      } finally {
        rmSync(path, { force: true })
      }
    }
    expect(tried).toBeGreaterThan(0)
  })
})

describe('a hash whose file changes while it is read', () => {
  it('records no identity for it, so the next start hashes it again', async () => {
    await fixture.install(V1)
    const probe = await open(file('node/LICENSE'))
    const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle['stat'] }
    await probe.close()
    const real = prototype.stat
    const bigintStat = real as (this: FileHandle, options: { bigint: true }) => Promise<BigIntStats>
    const calls = new WeakMap<object, number>()
    vi.spyOn(prototype, 'stat').mockImplementation(async function (this: FileHandle, options?: { bigint?: boolean }) {
      if (options?.bigint !== true) return real.call(this, options)
      const stats = await bigintStat.call(this, { bigint: true })
      const count = (calls.get(this) ?? 0) + 1
      calls.set(this, count)
      return count === 2 ? Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as BigIntStats, stats, { ctimeNs: stats.ctimeNs + 1n }) : stats
    } as FileHandle['stat'])
    advance(3_000)
    await fixture.store.checkRuntime(V1, fixture.root)
    expect(readRecord().files.every(entry => entry === null)).toBe(true)
  })
})

describe('an install that hashes each file once, as it writes it', () => {
  /**
   * A fill that writes the closure the way the launcher's extraction does: at the installed mode, reporting each file's
   * identity after its last write.
   * @param change - changes the staged directory after the identities are taken, and may replace them.
   * @returns the fill.
   */
  function stagedFill(change: (directory: string, staged: Map<string, string>) => string | undefined = () => undefined): (directory: string) => Promise<FilledRelease> {
    return async (directory) => {
      const files = closureFiles(V1)
      const identities = new Map<string, string>()
      for (const [path, entry] of Object.entries(files)) {
        const target = join(directory, ...path.split('/'))
        mkdirSync(join(target, '..'), { recursive: true })
        const handle = await open(target, 'wx', installedFileMode(entry.executable === true ? '0755' : '0644'))
        await handle.writeFile(entry.content)
        identities.set(path, identityOf(await handle.stat({ bigint: true })))
        await handle.close()
      }
      const bytes = releaseFiles(fixture.keys.targets, V1, files)
      const manifest = JSON.parse(Buffer.from(bytes.manifest).toString('utf8')) as { signed: { runtime: Record<string, { files: { sha256: string } }> } }
      const fileList = change(directory, identities) ?? manifest.signed.runtime[PLATFORM]!.files.sha256
      return { ...bytes, staged: { fileList, identities } }
    }
  }

  it('records every staged identity after the racy window, without reading the files again', async () => {
    const probe = await open(join(fixture.home, 'trust', 'root.json'))
    const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle['stat'] }
    await probe.close()
    const spy = vi.spyOn(prototype, 'stat')
    await fixture.store.install({ version: V1, root: fixture.root, fill: stagedFill() })
    const record = readRecord()
    expect(record.files.every(entry => entry !== null)).toBe(true)
    for (const entry of record.files) expect(BigInt(record.capturedAt) * 1_000_000n - BigInt(entry!.split(':').at(-1)!)).toBeGreaterThanOrEqual(2_000_000_000n)
    expect(record.fullCheckAt).toBe(record.capturedAt)
    // The staged files are confirmed by lstat; only the extraction's own handles were opened for stat.
    expect(spy.mock.calls.filter(call => (call[0] as { bigint?: boolean } | undefined)?.bigint === true)).toHaveLength(Object.keys(closureFiles(V1)).length)
  })

  it('refuses a staged file changed in a later clock step than the write its identity was reported from', async () => {
    const failure = await fixture.store.install({
      version: V1,
      root: fixture.root,
      fill: stagedFill((directory) => {
        // A change in the same kernel clock step as the write can keep the identity, the limit the design states.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        const path = join(directory, ...TARGET.split('/'))
        chmodSync(path, 0o644)
        writeFileSync(path, `X${readFileSync(path, 'utf8').slice(1)}`)
        return undefined
      }),
    }).then(() => undefined, (error: unknown) => error)
    expect((failure as RuntimeStoreError).code).toBe('INSTALL_VERIFY_FAILED')
    expect((failure as Error).message).toContain(`${TARGET} (sha256)`)
  })

  it('hashes every staged file when the identities name another file list, and a file the fill did not report', async () => {
    const failure = await fixture.store.install({
      version: V1,
      root: fixture.root,
      fill: stagedFill((directory, staged) => {
        const path = join(directory, ...TARGET.split('/'))
        chmodSync(path, 0o644)
        writeFileSync(path, 'console.log("changed")\n')
        staged.set(TARGET, identityOf(lstatSync(path, { bigint: true })))
        return '0'.repeat(64)
      }),
    }).then(() => undefined, (error: unknown) => error)
    expect((failure as RuntimeStoreError).code).toBe('INSTALL_VERIFY_FAILED')
    await fixture.store.install({ version: V1, root: fixture.root, fill: stagedFill((_directory, staged) => { staged.delete('node/LICENSE'); return undefined }) })
    expect(readRecord().files[indexOf('node/LICENSE')]).not.toBeNull()
  })

  it.each([
    ['already past', 10_000],
    ['beyond the window, under a clock set back', -10_000],
  ])('waits at most the racy window when the newest staged change time is %s', async (_case, shift) => {
    advance(shift)
    const started = performance.now()
    await fixture.store.install({ version: V1, root: fixture.root, fill: stagedFill() })
    expect(performance.now() - started).toBeLessThan(10_000)
  })
})

describe('the tree and the installation', () => {
  it('refuses a version whose installation is gone, and stops retention at a record directory it cannot list', async () => {
    await fixture.install(V1)
    chmodSync(installation(), 0o700)
    renameSync(installation(), join(fixture.home, 'staging', 'gone'))
    expect((await refusal(fixture.store.checkRuntime(V1, fixture.root))).message).toContain('cannot be checked')
    renameSync(join(fixture.home, 'staging', 'gone'), installation())
    rmSync(join(fixture.home, 'trust', 'runtime-files'), { recursive: true })
    writeFileSync(join(fixture.home, 'trust', 'runtime-files'), 'not a directory\n')
    await expect(fixture.store.retain()).rejects.toThrow(/ENOTDIR/u)
  })

  it.each<[string, (directory: string) => void]>([
    ['a listed file the fill did not write', (directory) => { rmSync(join(directory, 'node/LICENSE')) }],
    ['a staged directory it cannot read', (directory) => { chmodSync(join(directory, 'node'), 0o000) }],
  ])('refuses an install with %s', async (_case, spoil) => {
    const failure = await fixture.store.install({
      version: V1,
      root: fixture.root,
      fill: async (directory) => {
        const files = closureFiles(V1)
        writeClosure(directory, files)
        spoil(directory)
        return Promise.resolve(releaseFiles(fixture.keys.targets, V1, files))
      },
    }).then(() => undefined, (error: unknown) => error)
    expect((failure as RuntimeStoreError).code).toBe('INSTALL_VERIFY_FAILED')
    expect(existsSync(installation())).toBe(false)
  })

  it('refuses a root that is not a directory and a file list that names a path twice or leaves the root', async () => {
    await fixture.install(V1)
    const list = (await fixture.store.checkRuntime(V1, fixture.root)).files
    await expect(examineTree(recordPath(), list)).rejects.toThrow('is not a directory')
    await expect(examineTree(installation(), { ...list, files: [...list.files, list.files[0]!] })).rejects.toThrow('twice')
    await expect(examineTree(installation(), { ...list, files: [{ ...list.files[0]!, path: '../escape' }] })).rejects.toThrow('not a normalised relative path')
  })

  it('names the first ten problems in path order and counts the rest', async () => {
    await fixture.install(V1)
    const list = (await fixture.store.checkRuntime(V1, fixture.root)).files
    const missing = Array.from({ length: 12 }, (_unused, index) => ({ ...list.files[0]!, path: `missing/${String(11 - index).padStart(2, '0')}` }))
    const examined = await examineTree(installation(), { ...list, files: [...list.files, ...missing] })
    expect(examined.problems.map(problem => problem.path)).toEqual([...missing].map(entry => entry.path).sort())
    expect(describeProblems(examined.problems)).toMatch(/^missing\/00 \(missing\), .* and 2 more$/u)
  })
})

describe('the record and the interval', () => {
  it('lives outside runtimes/ at mode 0600, and retention removes it with its version', async () => {
    await fixture.install(V1)
    expect(lstatSync(recordPath()).mode & 0o777).toBe(0o600)
    expect(readRecord()['schema']).toBe(IDENTITY_SCHEMA)
    writeFileSync(`${recordPath()}.tmp-0123456789abcdef`, '', { mode: 0o600 })
    writeFileSync(join(fixture.home, 'trust', 'runtime-files', `delorun-9.9.9-${PLATFORM}.json`), '{}\n', { mode: 0o600 })
    writeFileSync(join(fixture.home, 'trust', 'runtime-files', 'unrelated.txt'), 'left alone\n')
    await fixture.store.retain()
    expect(await import('node:fs').then(fs => fs.readdirSync(join(fixture.home, 'trust', 'runtime-files')).sort())).toEqual([`delorun-${V1}-${PLATFORM}.json`, 'unrelated.txt'])
    expect(await readIdentityRecord(recordPath())).toMatchObject({ version: String(V1) })
  })

  it('resolves the interval of the full hash from the setting', () => {
    expect([undefined, '', ' ', '0', '7', '30'].map(resolveFullCheckDays)).toEqual([7, 7, 7, 0, 7, 30])
    for (const text of ['31', '-1', '1.5', '007', 'weekly']) expect(() => resolveFullCheckDays(text)).toThrow(/whole number of days from 0 to 30/u)
  })
})
