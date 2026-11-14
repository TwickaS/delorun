/**
 * A release version the runtime store cannot hold as a directory name is refused before any release file is read, even
 * when it verifies: the store's version pattern is the authority on what may name a directory under `runtimes/`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Downloader } from '../src/download.ts'
import { isInstallError } from '../src/errors.ts'
import { fixtureRelease, logService, NOW, releasePaths, standIn, type StandIn } from './support.ts'

vi.mock('@delorun/runtime-store', () => ({ parseRuntimeVersion: () => undefined }))

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.map(step => step()))
  cleanup = []
})

describe('a version the store cannot hold', () => {
  it('refuses the release as invalid metadata and asks for nothing more', async () => {
    const { LauncherChannel } = await import('../src/channel.ts')
    const fixture = await fixtureRelease()
    const home = await mkdtemp(join(tmpdir(), 'delorun-install-version-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const server: StandIn = await standIn(releasePaths(fixture))
    cleanup.push(() => server.close())
    const channel = new LauncherChannel({
      home,
      platform: fixture.platform,
      roots: fixture.roots,
      channel: 'stable',
      log: logService(fixture.checkpoint),
      source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` },
      downloader: new Downloader({ hosts: { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 } }),
      now: () => NOW * 1000,
    })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'RELEASE_METADATA_INVALID')).toBe(true)
    expect(server.requests.filter(path => path.includes('manifest'))).toEqual([])
  })
})
