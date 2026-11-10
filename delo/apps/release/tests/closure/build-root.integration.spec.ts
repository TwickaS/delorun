import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_ROOT_MARKER, BuildRootBusyError, claimBuildRoot } from '../../src/closure/build-root.ts'
import { scratch } from '../support.ts'

describe('the build root', () => {
  it('lets one build hold the fixed root and refuses a second one, naming the running holder', async (test) => {
    const root = join(scratch(test, 'delo-build-root-'), 'build')
    const first = await claimBuildRoot(root, 'fixed')
    expect(first.path).toBe(root)
    expect(existsSync(join(root, BUILD_ROOT_MARKER))).toBe(true)
    expect(readFileSync(`${root}.lock`, 'utf8')).toBe(`${String(process.pid)}\n`)
    const second = claimBuildRoot(root, 'fixed')
    await expect(second).rejects.toBeInstanceOf(BuildRootBusyError)
    await expect(second).rejects.toMatchObject({ holder: process.pid, running: true })
    expect(existsSync(join(root, BUILD_ROOT_MARKER))).toBe(true)
    await first.release()
    expect(existsSync(`${root}.lock`)).toBe(false)
    const third = await claimBuildRoot(root, 'fixed')
    await third.release()
  })

  it('refuses a lock its build left behind and says the holder has ended', async (test) => {
    const root = join(scratch(test, 'delo-build-root-'), 'build')
    writeFileSync(`${root}.lock`, '2147483646\n')
    await expect(claimBuildRoot(root, 'fixed')).rejects.toThrow('names process 2147483646, which has ended; if no build-closure runs on this computer, remove the lock and run again')
  })

  it('refuses a fixed root it did not create and gives the lock up', async (test) => {
    const root = scratch(test, 'delo-build-root-')
    await expect(claimBuildRoot(root, 'fixed')).rejects.toThrow('was not created by build-closure')
    expect(existsSync(`${root}.lock`)).toBe(false)
  })

  it('gives each build from existing artifacts a directory of its own and removes it after', async (test) => {
    const root = join(scratch(test, 'delo-build-root-'), 'build')
    const held = await claimBuildRoot(root, 'fixed')
    const [a, b] = await Promise.all([claimBuildRoot(root, 'unique'), claimBuildRoot(root, 'unique')])
    expect(a.path).not.toBe(b.path)
    for (const claimed of [a, b]) {
      expect(claimed.path.startsWith(`${root}-`)).toBe(true)
      expect(existsSync(join(claimed.path, BUILD_ROOT_MARKER))).toBe(true)
      await claimed.release()
      expect(existsSync(claimed.path)).toBe(false)
    }
    await held.release()
  })
})
