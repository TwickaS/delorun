/**
 * The release channel of a Delo home (`delo/apps/cli/src/update/channel.ts`): which runtime platforms Delo names, and
 * that a channel exists only when the home stores a verified release root, either as a walked chain under
 * `trust/roots/` or as `trust/root.json`. Nothing here reaches the network; the channel is only constructed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DELO_HOME_ENTRIES, TRUST_ROOTS_DIRECTORY } from '@delo/contract-home-layout'
import { ensureHomeTree, writeProtectedFile } from '@delo/home'
import { LauncherChannel, writeTrustedRoot } from '@delo/install'
import { homeReleaseChannel, runtimePlatformOf } from '../../src/update/channel.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** @returns a Delo home with its tree and no stored root. */
async function emptyHome(): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dch-')))
  directories.push(base)
  const home = join(base, 'home')
  await ensureHomeTree(home, 'default')
  return home
}

describe('runtimePlatformOf', () => {
  it('names the platform of every operating system and architecture Delo publishes a runtime for', () => {
    expect(runtimePlatformOf('linux', 'x64')).toBe('linux-x64')
    expect(runtimePlatformOf('linux', 'arm64')).toBe('linux-arm64')
    expect(runtimePlatformOf('darwin', 'arm64')).toBe('darwin-arm64')
    expect(runtimePlatformOf('darwin', 'x64')).toBe('darwin-x64')
    expect(runtimePlatformOf('win32', 'x64')).toBe('win32-x64')
  })

  it('refuses a machine Delo publishes no runtime for, naming it', () => {
    expect(() => runtimePlatformOf('freebsd', 'x64')).toThrow('Delo publishes no runtime for freebsd-x64')
    expect(() => runtimePlatformOf('win32', 'arm64')).toThrow('Delo publishes no runtime for win32-arm64')
  })
})

describe('homeReleaseChannel', () => {
  it('refuses a home that stores no verified release root, telling the person to reinstall', async () => {
    const home = await emptyHome()

    await expect(homeReleaseChannel(home, 'linux-x64', 'stable')).rejects.toThrow('this home stores no verified release root, so no update can be verified; reinstall Delo with its launcher')
  })

  it('returns the launcher\'s channel anchored on the root the home stores', async () => {
    const home = await emptyHome()
    await writeTrustedRoot(home, Buffer.from('{"root":"stored"}\n'))

    expect(await homeReleaseChannel(home, 'linux-x64', 'stable')).toBeInstanceOf(LauncherChannel)
  })

  it('returns the launcher\'s channel for a home that stores a walked root chain and no single root', async () => {
    const home = await emptyHome()
    const roots = join(home, DELO_HOME_ENTRIES.trust, TRUST_ROOTS_DIRECTORY)
    mkdirSync(roots, { mode: 0o700 })
    await writeProtectedFile(join(roots, '1.root.json'), Buffer.from('{"root":1}\n'))
    await writeProtectedFile(join(roots, '2.root.json'), Buffer.from('{"root":2}\n'))

    expect(await homeReleaseChannel(home, 'darwin-arm64', 'stable')).toBeInstanceOf(LauncherChannel)
  })
})
