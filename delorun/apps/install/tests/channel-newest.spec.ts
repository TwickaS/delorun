/**
 * `LauncherChannel.newest`, the update notice's check: it verifies the channel's current release exactly as an install
 * does up to the release-log bundle, and fetches nothing more, records nothing under `trust/` and runs no online log
 * check, so it can run beside an install or an update without moving what they rely on.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_FILE_SIZE_LIMITS } from '@delorun/contract-release-manifest'
import { Downloader } from '../src/download.ts'
import { isInstallError } from '../src/errors.ts'
import { LauncherChannel, type LauncherChannelOptions } from '../src/channel.ts'
import type { ReleaseLogTransport } from '@delorun/release-verify/online'
import { envelope, fixtureRelease, logService, nextRoot, NOW, releasePaths, sha256, standIn, VERSION, type Fixture, type StandIn } from './support.ts'

/** The download rule the specs use: plain HTTP, so a stand-in server on loopback answers as a release host does. */
const LOOPBACK = { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 }

let homes: string[] = []
let servers: StandIn[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => server.close()))
  servers = []
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
  homes = []
})

/** A channel, its home, its host and how often it asked the log. */
interface Harness {
  readonly channel: LauncherChannel
  readonly home: string
  readonly server: StandIn
  readonly logCalls: () => number
}

/**
 * A channel over a fixture release served from a stand-in host.
 * @param fixture - the release.
 * @param change - what differs from the default channel.
 * @returns the harness.
 */
async function harness(fixture: Fixture, change: Partial<LauncherChannelOptions> = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'delorun-install-newest-'))
  homes.push(home)
  const server = await standIn(releasePaths(fixture))
  servers.push(server)
  let calls = 0
  const inner = logService(fixture.checkpoint)
  const log: ReleaseLogTransport = {
    latestCheckpoint: async (signal) => { calls++; return inner.latestCheckpoint(signal) },
    consistencyProof: async (first, second, signal) => { calls++; return inner.consistencyProof(first, second, signal) },
  }
  const channel = new LauncherChannel({
    home,
    platform: fixture.platform,
    roots: fixture.roots,
    channel: 'stable',
    log,
    source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` },
    downloader: new Downloader({ hosts: LOOPBACK }),
    now: () => NOW * 1000,
    ...change,
  })
  return { channel, home, server, logCalls: () => calls }
}

/**
 * The refusal a promise ends with.
 * @param step - the promise.
 * @returns the error's code.
 */
async function codeOf(step: Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await step.then(() => undefined, (failure: unknown) => failure)
  return isInstallError(error) ? error.code : undefined
}

// Each test signs a fresh fixture release, which takes seconds on a loaded machine.
describe('the channel\'s newest release', { timeout: 30_000 }, () => {
  it('update-notice-writes-no-trust-state: returns the verified manifest, fetching only the timestamp, the manifest and its bundle', async () => {
    const fixture = await fixtureRelease({ notice: { security: true, summary: 'Fixes the reach listener\'s origin check.' } })
    const { channel, home, server, logCalls } = await harness(fixture)
    const { manifest, timestamp } = await channel.newest()
    expect(timestamp).toBe(1)
    expect(String(manifest.version)).toBe(VERSION)
    expect(manifest.security).toBe(true)
    expect(manifest.summary).toBe('Fixes the reach listener\'s origin check.')
    expect(server.requests).toEqual([
      '/timestamp.json',
      `/releases/${VERSION}/delorun-${VERSION}.manifest.json`,
      `/releases/${VERSION}/delorun-${VERSION}.manifest.log.json`,
    ])
    expect(logCalls()).toBe(0)
    expect(await readdir(home)).toEqual([])
  })

  it('leaves what an install recorded under trust/ as it was', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await channel.resolve()
    const before = await readdir(join(home, 'trust'), { recursive: true })
    await channel.newest()
    expect(await readdir(join(home, 'trust'), { recursive: true })).toEqual(before)
  })

  it('walks a root the home does not trust yet without keeping it', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const { channel, home, server } = await harness(fixture)
    server.files.set('/timestamp.json', envelope({ ...fixture.timestamp, root: { version: 2, sha256: sha256(second) } }, [fixture.keys.timestamp]))
    server.files.set('/root/2.root.json', second)
    await channel.newest()
    expect(server.requests).toContain('/root/2.root.json')
    expect(await readdir(home)).toEqual([])
  })

  it('update-notice-replayed-timestamp-refused: refuses a timestamp older than the one the home stored', async () => {
    const fixture = await fixtureRelease({ timestampVersion: 2 })
    const { channel, server } = await harness(fixture)
    await channel.resolve()
    server.files.set('/timestamp.json', envelope({ ...fixture.timestamp, version: 1 }, [fixture.keys.timestamp]))
    expect(await codeOf(channel.newest())).toBe('INSTALL_VERIFY_FAILED')
  })

  it('refuses a manifest that is not the one the timestamp names', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}.manifest.json`, Buffer.from('{"signed":{}}'))
    expect(await codeOf(channel.newest())).toBe('INSTALL_VERIFY_FAILED')
  })

  it('refuses a timestamp signed by a key outside the timestamp role', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set('/timestamp.json', envelope(fixture.timestamp, [fixture.keys.targets]))
    expect(await codeOf(channel.newest())).toBe('INSTALL_VERIFY_FAILED')
  })

  it('refuses a release whose bundle\'s inclusion proof does not verify', async () => {
    const fixture = await fixtureRelease({ tamperInclusion: true })
    const { channel } = await harness(fixture)
    expect(await codeOf(channel.newest())).toBe('RELEASE_LOG_FAILED')
  })

  it('update-notice-manifest-length-capped: refuses a timestamp that states a manifest above its size limit, before fetching it', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    const pointer = { ...fixture.timestamp.channels.stable, manifest: { ...fixture.timestamp.channels.stable.manifest, length: RELEASE_FILE_SIZE_LIMITS.manifest + 1 } }
    server.files.set('/timestamp.json', envelope({ ...fixture.timestamp, channels: { stable: pointer, beta: pointer } }, [fixture.keys.timestamp]))
    expect(await codeOf(channel.newest())).toBe('INSTALL_VERIFY_FAILED')
    expect(await codeOf(channel.resolve())).toBe('INSTALL_VERIFY_FAILED')
    expect(server.requests.filter(path => path.endsWith('.manifest.json'))).toEqual([])
  })

  it('reads a manifest signed before the security mark and the summary existed', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture)
    const { manifest } = await channel.newest()
    expect(manifest.security).toBeUndefined()
    expect(manifest.summary).toBeUndefined()
  })
})
