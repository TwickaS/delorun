import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { checkProtectedFile, ensureHomeTree, HomeLayoutError, readProtectedFile, resolveDeloHome, runDirectory, writeProtectedFile } from '../src/index.ts'

const POSIX = process.platform !== 'win32'

let osHome: string

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-home-')))
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * The refusal a promise rejects with.
 * @param promise - the call.
 * @returns its HomeLayoutError.
 */
async function refusal(promise: Promise<unknown>): Promise<HomeLayoutError> {
  const error: unknown = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(HomeLayoutError)
  return error as HomeLayoutError
}

/**
 * A file's permission bits.
 * @param path - the path.
 * @returns the mode's low nine bits.
 */
function mode(path: string): number {
  return lstatSync(path).mode & 0o777
}

describe('resolveDeloHome', () => {
  it('resolves ~/.delo by default and ignores an inherited DSH_HOME', async () => {
    expect(await resolveDeloHome({})).toEqual({ path: join(osHome, '.delo') })
    expect(await resolveDeloHome({ DELO_HOME: '  ', DSH_HOME: join(osHome, '.dsh') })).toEqual({ path: join(osHome, '.delo'), ignoredDshHome: join(osHome, '.dsh') })
    expect(await resolveDeloHome({ DSH_HOME: join(osHome, '.delo') })).toEqual({ path: join(osHome, '.delo') })
  })

  it('takes DELO_HOME, expanding a leading ~ and normalising the path', async () => {
    expect((await resolveDeloHome({ DELO_HOME: '~/homes/one' })).path).toBe(join(osHome, 'homes', 'one'))
    expect((await resolveDeloHome({ DELO_HOME: join(osHome, 'a', '..', 'b') })).path).toBe(join(osHome, 'b'))
  })

  it('refuses a relative home, the filesystem root and the OS home directory with HOME_INVALID', async () => {
    expect((await refusal(resolveDeloHome({ DELO_HOME: 'relative/home' }))).code).toBe('HOME_INVALID')
    expect((await refusal(resolveDeloHome({ DELO_HOME: '/' }))).code).toBe('HOME_INVALID')
    expect((await refusal(resolveDeloHome({ DELO_HOME: '~' }))).code).toBe('HOME_INVALID')
    expect((await refusal(resolveDeloHome({ DELO_HOME: `${osHome}/` }))).code).toBe('HOME_INVALID')
  })

  it('refuses upstream\'s ~/.dsh, a path inside it and a link to it with HOME_IS_DSH_HOME', async () => {
    mkdirSync(join(osHome, '.dsh'))
    expect((await refusal(resolveDeloHome({ DELO_HOME: '~/.dsh' }))).code).toBe('HOME_IS_DSH_HOME')
    expect((await refusal(resolveDeloHome({ DELO_HOME: join(osHome, '.dsh', 'delo') }))).code).toBe('HOME_IS_DSH_HOME')
    symlinkSync(join(osHome, '.dsh'), join(osHome, 'link'))
    expect((await refusal(resolveDeloHome({ DELO_HOME: join(osHome, 'link') }))).code).toBe('HOME_IS_DSH_HOME')
    expect((await resolveDeloHome({ DELO_HOME: join(osHome, '.dsh-other') })).path).toBe(join(osHome, '.dsh-other'))
  })
})

describe.runIf(POSIX)('ensureHomeTree', () => {
  it('creates the home and each of Delo\'s entries at mode 0700, whatever the umask allows', async () => {
    const home = join(osHome, '.delo')
    await ensureHomeTree(home, 'default')
    expect(mode(home)).toBe(0o700)
    for (const entry of Object.values(DELO_HOME_ENTRIES)) expect(mode(join(home, entry))).toBe(0o700)
    expect(mode(runDirectory(home, 'default'))).toBe(0o700)
  })

  it('creates the home at mode 0700 under a permissive umask', () => {
    // process.umask cannot be changed in a worker, so a child process creates the home.
    const home = join(osHome, 'umask-home')
    const script = `process.umask(0); const { ensureHomeTree } = await import(${JSON.stringify(new URL('../src/tree.ts', import.meta.url).href)}); await ensureHomeTree(${JSON.stringify(home)}, 'default')`
    execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], { cwd: join(import.meta.dirname, '../../../..'), stdio: 'pipe' })
    expect(mode(home)).toBe(0o700)
    expect(mode(join(home, 'secrets'))).toBe(0o700)
  })

  it('leaves an existing private home as it is', async () => {
    const home = join(osHome, '.delo')
    await ensureHomeTree(home, 'default')
    writeFileSync(join(home, 'secrets', 'kept'), 'x', { mode: 0o600 })
    await ensureHomeTree(home, 'default')
    expect(readFileSync(join(home, 'secrets', 'kept'), 'utf8')).toBe('x')
  })

  it('refuses a home with group or other bits with HOME_MODE and the chmod 700 fix', async () => {
    const home = join(osHome, '.delo')
    mkdirSync(home, { mode: 0o700 })
    chmodSync(home, 0o755)
    const error = await refusal(ensureHomeTree(home, 'default'))
    expect(error.code).toBe('HOME_MODE')
    expect(error.fix).toBe(`chmod 700 ${home}`)
    expect(error.message).toContain(`chmod 700 ${home}`)
  })

  it('refuses a laxer secrets/ or run/<profile>/ and a home that is a symbolic link', async () => {
    const home = join(osHome, '.delo')
    await ensureHomeTree(home, 'default')
    chmodSync(join(home, 'secrets'), 0o750)
    expect((await refusal(ensureHomeTree(home, 'default'))).fix).toBe(`chmod 700 ${join(home, 'secrets')}`)
    chmodSync(join(home, 'secrets'), 0o700)
    chmodSync(runDirectory(home, 'default'), 0o701)
    expect((await refusal(ensureHomeTree(home, 'default'))).fix).toBe(`chmod 700 ${runDirectory(home, 'default')}`)
    const linked = join(osHome, 'linked')
    symlinkSync(home, linked)
    const error = await refusal(ensureHomeTree(linked, 'default'))
    expect(error.code).toBe('HOME_MODE')
    expect(error.fix).toBeUndefined()
  })
})

describe.runIf(POSIX)('protected files', () => {
  let secrets: string

  beforeEach(async () => {
    await ensureHomeTree(join(osHome, '.delo'), 'default')
    secrets = join(osHome, '.delo', 'secrets')
  })

  it('writes a secret file at mode 0600 and reads it back', async () => {
    const path = join(secrets, 'device.key')
    await writeProtectedFile(path, 'key-bytes')
    expect(mode(path)).toBe(0o600)
    expect((await readProtectedFile(path)).toString()).toBe('key-bytes')
    await writeProtectedFile(path, 'replaced')
    expect(mode(path)).toBe(0o600)
    expect((await readProtectedFile(path)).toString()).toBe('replaced')
  })

  it('refuses a secret file with a group or other bit with SECRET_FILE_MODE and the chmod 600 fix', async () => {
    for (const laxer of [0o640, 0o604, 0o660, 0o644]) {
      const path = join(secrets, `laxer-${laxer.toString(8)}.key`)
      writeFileSync(path, 'key-bytes')
      chmodSync(path, laxer)
      const error = await refusal(readProtectedFile(path))
      expect(error.code).toBe('SECRET_FILE_MODE')
      expect(error.path).toBe(path)
      expect(error.fix).toBe(`chmod 600 ${path}`)
      expect(error.message).toContain(`chmod 600 ${path}`)
      expect(error.message).not.toContain('key-bytes')
      expect((await refusal(checkProtectedFile(path))).fix).toBe(`chmod 600 ${path}`)
    }
  })

  it('quotes a path the shell would split in the fix', async () => {
    const path = join(secrets, 'a key')
    writeFileSync(path, 'x', { mode: 0o644 })
    chmodSync(path, 0o644)
    expect((await refusal(readProtectedFile(path))).fix).toBe(`chmod 600 '${path}'`)
  })

  it('refuses a symbolic link, even to a 0600 file, and a FIFO without opening it', async () => {
    const target = join(secrets, 'target.key')
    await writeProtectedFile(target, 'x')
    const link = join(secrets, 'link.key')
    symlinkSync(target, link)
    expect((await refusal(readProtectedFile(link))).code).toBe('SECRET_FILE_MODE')
    const fifo = join(secrets, 'fifo.key')
    execFileSync('mkfifo', ['-m', '600', fifo])
    expect((await refusal(readProtectedFile(fifo))).message).toContain('not a regular file')
  })

  it('leaves no temporary file behind when a write fails', async () => {
    await expect(writeProtectedFile(join(secrets, 'missing-dir', 'x.key'), 'x')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeProtectedFile(join(secrets, 'ok.key'), 'x')
    expect(statSync(secrets).isDirectory()).toBe(true)
    expect(execFileSync('ls', ['-A', secrets], { encoding: 'utf8' }).trim().split('\n')).toEqual(['ok.key'])
  })
})
