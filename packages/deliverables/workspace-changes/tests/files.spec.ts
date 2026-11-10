/** The scratch root's location and the Host's exclusive, link-refusing file operations. */
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyRegularFile, createPrivateDirectory, defaultScratchRoot, makeDirectory, writeNewFile } from '../src/files.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('defaultScratchRoot', () => {
  it('places the root in the per-user cache directory of each platform', () => {
    expect(defaultScratchRoot('linux', {}, '/home/u')).toBe('/home/u/.cache/dsh-workspace-changes')
    expect(defaultScratchRoot('linux', { XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe('/xdg/dsh-workspace-changes')
    // The XDG specification ignores a relative value.
    expect(defaultScratchRoot('freebsd', { XDG_CACHE_HOME: 'relative' }, '/home/u')).toBe('/home/u/.cache/dsh-workspace-changes')
    expect(defaultScratchRoot('darwin', { XDG_CACHE_HOME: '/xdg' }, '/Users/u')).toBe('/Users/u/Library/Caches/dsh-workspace-changes')
    expect(defaultScratchRoot('win32', { LOCALAPPDATA: '/local' }, '/home/u')).toBe('/local/dsh-workspace-changes')
    expect(defaultScratchRoot('win32', {}, '/home/u')).toBe('/home/u/AppData/Local/dsh-workspace-changes')
  })
})

describe.skipIf(process.platform === 'win32')('createPrivateDirectory', () => {
  it('creates the root and a new mode-0700 Session directory, narrowing a root others can enter', async () => {
    const base = await scratchDir('dsh-files-root-', cleanups)
    const root = join(base, 'missing', 'root')
    const first = await createPrivateDirectory(root)
    const second = await createPrivateDirectory(root)
    expect(first).not.toBe(second)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    expect((await lstat(first)).mode & 0o777).toBe(0o700)
    await chmod(root, 0o755)
    await createPrivateDirectory(root)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
  })

  it('refuses a root that is a link, not a directory, or owned by another user', async () => {
    const base = await scratchDir('dsh-files-bad-root-', cleanups)
    const target = await scratchDir('dsh-files-link-target-', cleanups)
    await symlink(target, join(base, 'link'))
    await expect(createPrivateDirectory(join(base, 'link'))).rejects.toThrow('is not a directory')
    expect(await readdir(target)).toEqual([])
    await writeFile(join(base, 'file'), 'x')
    await expect(createPrivateDirectory(join(base, 'file'))).rejects.toThrow()
    vi.spyOn(process, 'getuid').mockReturnValue(-2)
    await expect(createPrivateDirectory(join(base, 'owned'))).rejects.toThrow('belongs to another user')
  })

  it('skips the ownership check where the platform has no user ids', async () => {
    const base = await scratchDir('dsh-files-no-uid-', cleanups)
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
    cleanups.push(async () => { Object.defineProperty(process, 'getuid', getuid) })
    expect(await createPrivateDirectory(join(base, 'root'))).toContain('session-')
  })
})

describe.skipIf(process.platform === 'win32')('file operations under the private directory', () => {
  it('creates files and directories only where no entry exists, never through a link', async () => {
    const base = await scratchDir('dsh-files-exclusive-', cleanups)
    const target = await scratchDir('dsh-files-target-', cleanups)
    await symlink(join(target, 'marker.txt'), join(base, 'link'))
    await expect(writeNewFile(join(base, 'link'), Buffer.from('marker'))).rejects.toThrow('EEXIST')
    await expect(makeDirectory(join(base, 'link'))).rejects.toThrow('EEXIST')
    expect(await readdir(target)).toEqual([])
    await writeNewFile(join(base, 'new'), Buffer.from('new'))
    expect((await lstat(join(base, 'new'))).mode & 0o777).toBe(0o600)
    await expect(makeDirectory(join(base, 'new'))).rejects.toThrow('EEXIST')
  })

  it('copies a regular file, reports a missing one, and refuses a link, a named pipe, or an existing target', async () => {
    const base = await scratchDir('dsh-files-copy-', cleanups)
    await writeFile(join(base, 'source'), 'x'.repeat(3 * 1024 * 1024))
    expect(await copyRegularFile(join(base, 'source'), join(base, 'copy'))).toBe(true)
    expect(await readFile(join(base, 'copy'), 'utf8')).toBe('x'.repeat(3 * 1024 * 1024))
    expect((await lstat(join(base, 'copy'))).mode & 0o777).toBe(0o600)
    expect(await copyRegularFile(join(base, 'missing'), join(base, 'copy-missing'))).toBe(false)
    await expect(copyRegularFile(join(base, 'source'), join(base, 'copy'))).rejects.toThrow('EEXIST')
    await symlink(join(base, 'source'), join(base, 'link'))
    await expect(copyRegularFile(join(base, 'link'), join(base, 'copy-link'))).rejects.toThrow('ELOOP')
    execFileSync('mkfifo', [join(base, 'pipe')])
    await expect(copyRegularFile(join(base, 'pipe'), join(base, 'copy-pipe'))).rejects.toThrow('is not a regular file')
    await mkdir(join(base, 'dir'))
    await expect(copyRegularFile(join(base, 'dir'), join(base, 'copy-dir'))).rejects.toThrow('is not a regular file')
    expect((await readdir(base)).sort()).toEqual(['copy', 'dir', 'link', 'pipe', 'source'])
  })
})
