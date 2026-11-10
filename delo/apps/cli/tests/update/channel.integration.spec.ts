/**
 * The release channel of a Delo home (`delo/apps/cli/src/update/channel.ts`): which runtime platforms Delo names, the
 * channel over the roots the launcher ships, and the launcher's lines it writes for each install step. Nothing here
 * reaches the network; the channel is only constructed.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ensureHomeTree } from '@delo/home'
import { LauncherChannel } from '@delo/install'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { homeReleaseChannel, installLines, runtimePlatformOf } from '../../src/update/channel.ts'

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
  it('returns the launcher\'s channel, walking from the roots the launcher ships', async () => {
    const home = await emptyHome()

    expect(homeReleaseChannel(home, 'darwin-arm64', 'stable', [Buffer.from('{"root":1}\n')], () => {})).toBeInstanceOf(LauncherChannel)
  })
})

describe('installLines', () => {
  it('writes the launcher\'s lines for each step, both lines of a log check that did not run', () => {
    const written: string[] = []
    const write = installLines((text) => { written.push(text) })
    const version = brandString<SemanticVersion>('1.1.0')

    write({ step: 'resolved', channel: 'stable', version })
    write({ step: 'log-checked', version, state: 'unchecked', detail: 'the log did not answer' })

    expect(written).toEqual([
      'Resolving the release: the stable channel names 1.1.0.\n',
      'Checking the release log: not checked (the log did not answer).\n',
      'Warning: Release 1.1.0 has not been checked against the release log; Delo checks it at the next connection.\n',
    ])
  })
})
