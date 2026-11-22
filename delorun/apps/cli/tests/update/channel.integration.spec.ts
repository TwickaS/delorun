/**
 * The release channel of a Delorun home (`delorun/apps/cli/src/update/channel.ts`): which runtime platforms Delorun names, the
 * channel over the roots the launcher ships, that it fetches from the origins the installing launcher recorded and from
 * nowhere an environment variable names, and the launcher's lines it writes for each install step. Nothing here
 * reaches the network: a stand-in `fetch` records the first address the channel asks for and refuses it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { ensureHomeTree, writeProtectedFile } from '@delorun/home'
import { LauncherChannel, writeChannelRecord } from '@delorun/install'
import { RELEASE_METADATA_ORIGIN } from '@delorun/contract-release-manifest'
import { homeReleaseChannel, runtimePlatformOf } from '../../src/update/channel.ts'
import { throwawayRoot } from './support.ts'

const directories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** @returns a Delorun home with its tree and no stored root. */
async function emptyHome(): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dch-')))
  directories.push(base)
  const home = join(base, 'home')
  await ensureHomeTree(home, 'default')
  return home
}

describe('runtimePlatformOf', () => {
  it('names the platform of every operating system and architecture Delorun publishes a runtime for', () => {
    expect(runtimePlatformOf('linux', 'x64')).toBe('linux-x64')
    expect(runtimePlatformOf('linux', 'arm64')).toBe('linux-arm64')
    expect(runtimePlatformOf('darwin', 'arm64')).toBe('darwin-arm64')
    expect(runtimePlatformOf('darwin', 'x64')).toBe('darwin-x64')
    expect(runtimePlatformOf('win32', 'x64')).toBe('win32-x64')
  })

  it('refuses a machine Delorun publishes no runtime for, naming it', () => {
    expect(() => runtimePlatformOf('freebsd', 'x64')).toThrow('Delorun publishes no runtime for freebsd-x64')
    expect(() => runtimePlatformOf('win32', 'arm64')).toThrow('Delorun publishes no runtime for win32-arm64')
  })
})

describe('homeReleaseChannel', () => {
  it('returns the launcher\'s channel, walking from the roots the launcher ships', async () => {
    const home = await emptyHome()

    expect(await homeReleaseChannel(home, 'darwin-arm64', 'stable', [Buffer.from('{"root":1}\n')], () => {})).toBeInstanceOf(LauncherChannel)
  })

  /**
   * The first address a channel of this home asks for when it resolves the newest release; the stand-in `fetch` refuses
   * every request, so the resolve fails after it.
   * @param home - the home.
   * @returns the address.
   */
  async function firstRequest(home: string): Promise<string> {
    const asked: string[] = []
    vi.stubGlobal('fetch', (input: string | URL) => {
      asked.push(String(input))
      return Promise.resolve(new Response('', { status: 404 }))
    })
    const channel = await homeReleaseChannel(home, 'linux-x64', 'stable', [throwawayRoot().bytes], () => {})
    await expect(channel.resolve(undefined)).rejects.toThrow()
    return asked[0]!
  }

  it('fetches from the production channel when no launcher recorded another, whatever the environment names', async () => {
    const home = await emptyHome()
    for (const name of ['DELORUN_CHANNEL_ORIGIN', 'DELORUN_RELEASE_CHANNEL', 'DELORUN_LOG_ORIGIN', 'DELORUN_JOURNEY_DEV_CHANNEL']) vi.stubEnv(name, 'http://127.0.0.1:9')

    expect(await firstRequest(home)).toBe(`${RELEASE_METADATA_ORIGIN}/timestamp.json`)
  })

  it('fetches from the origin the installing launcher recorded, and an environment variable does not move it', async () => {
    const home = await emptyHome()
    await writeChannelRecord(home, { channelOrigin: 'http://127.0.0.1:8123' })
    vi.stubEnv('DELORUN_CHANNEL_ORIGIN', 'https://releases.example')

    expect(await firstRequest(home)).toBe('http://127.0.0.1:8123/timestamp.json')
  })

  it('refuses a channel record that is not one', async () => {
    const home = await emptyHome()
    await writeProtectedFile(join(home, DELORUN_HOME_ENTRIES.trust, 'channel.json'), Buffer.from('{"v":1,"channelOrigin":"http://127.0.0.1:8123","extra":true}\n'))

    await expect(homeReleaseChannel(home, 'linux-x64', 'stable', [throwawayRoot().bytes], () => {})).rejects.toMatchObject({ code: 'TRUST_STATE_INVALID' })
  })

  it('refuses a recorded origin the launcher\'s own rule refuses', async () => {
    const home = await emptyHome()
    await writeChannelRecord(home, { channelOrigin: 'http://192.0.2.1:8123' })

    await expect(homeReleaseChannel(home, 'linux-x64', 'stable', [throwawayRoot().bytes], () => {})).rejects.toMatchObject({ code: 'TRUST_STATE_INVALID', message: expect.stringContaining('must use https, or http on this machine\'s loopback address') })
  })
})
