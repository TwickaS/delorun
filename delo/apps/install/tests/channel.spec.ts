/**
 * The install path's refusals, as a launcher meets them: a release file the download rule does not allow, a manifest
 * whose bytes are not the ones the timestamp signs, an archive whose bytes are not the ones the manifest signs, a
 * release log the machine cannot reach, and a release the channel does not offer. Each refuses with its contract C1 or
 * C18 code, and none of them installs anything.
 */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { Downloader } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { LauncherChannel, type LauncherChannelOptions, type ReleaseSource } from '../src/channel.ts'
import { fixtureRelease, logService, NOW, releasePaths, standIn, unreachableLog, VERSION, type Fixture, type StandIn } from './support.ts'

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

/**
 * A temporary Delo home a channel records under.
 * @returns its path.
 */
async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'delo-install-channel-'))
  homes.push(home)
  return home
}

/** A channel over a fixture's release, and the stand-in that serves it. */
interface Harness {
  /** The channel. */
  readonly channel: LauncherChannel
  /** The home it records under. */
  readonly home: string
  /** The stand-in serving the release. */
  readonly server: StandIn
}

/**
 * A channel that fetches a fixture release from a stand-in host.
 * @param fixture - the release.
 * @param change - what the harness changes from a channel that would install it.
 * @returns the channel and the host.
 */
async function harness(fixture: Fixture, change: Partial<LauncherChannelOptions> = {}): Promise<Harness> {
  const home = await scratchHome()
  const server = await standIn(releasePaths(fixture))
  servers.push(server)
  const source: ReleaseSource = {
    metadata: server.origin,
    files: (version, name) => `${server.origin}/releases/${version}/${name}`,
  }
  const channel = new LauncherChannel({
    home,
    platform: fixture.platform,
    roots: fixture.roots,
    channel: 'stable',
    log: logService(fixture.checkpoint),
    source,
    downloader: new Downloader({ hosts: LOOPBACK }),
    now: () => NOW * 1000,
    ...change,
  })
  return { channel, home, server }
}

/**
 * Expect an install step to refuse with a code.
 * @param step - the step.
 * @param code - the expected code.
 * @returns the refusal.
 */
async function refusal(step: Promise<unknown>, code: InstallError['code']): Promise<InstallError> {
  const error: unknown = await step.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, code), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

/**
 * The staging directory a store hands the channel: a new, empty `staging/<16 hex>/` directory at mode 0700.
 * @returns its path.
 */
async function staging(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'delo-install-staging-'))
  homes.push(parent)
  const directory = join(parent, '0123456789abcdef')
  await mkdir(directory, { mode: 0o700 })
  return directory
}

describe('a release the channel can verify', () => {
  it('names it, and installs its archive into the staging directory', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    const release = await channel.resolve()
    expect(String(release.version)).toBe(VERSION)
    const directory = await staging()
    const files = await channel.fill(release, directory)
    expect(Buffer.from(files.manifest).equals(Buffer.from(fixture.manifestBytes))).toBe(true)
    expect(await readdir(join(directory, 'node/bin'))).toEqual(['node'])
    expect(await readdir(join(home, 'trust'))).toEqual(expect.arrayContaining(['root.json', 'timestamp.json', 'checkpoint.json']))
  })
})

describe('a download the rule does not allow', () => {
  it('refuses a release file on a host contract C1 does not list', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture, {
      downloader: new Downloader(),
      source: {
        metadata: 'https://releases.example.test',
        files: () => 'https://cdn.example.test/delorun-0.1.0.tar.gz',
      },
    })
    await refusal(channel.resolve(), 'DOWNLOAD_REFUSED')
    expect(server.requests).toEqual([])
  })

  it('refuses a plain-HTTP release host under contract C1’s published rule', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { downloader: new Downloader() })
    await refusal(channel.resolve(), 'DOWNLOAD_REFUSED')
  })

  it('fails when the release host cannot be reached at all', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, {
      source: { metadata: 'http://127.0.0.1:1', files: () => 'http://127.0.0.1:1/x' },
    })
    await refusal(channel.resolve(), 'DOWNLOAD_FAILED')
  })
})

describe('an artifact that is not the one the release signs', () => {
  it('refuses a manifest whose bytes are not the digest the timestamp names', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}.manifest.json`, Buffer.from('{"signed":{}}'))
    await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
  })

  it('refuses an archive whose SHA-256 is not the manifest’s, before it is extracted', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`, Buffer.from('not the archive'))
    const release = await channel.resolve()
    const directory = await staging()
    const error = await refusal(channel.fill(release, directory), 'INSTALL_VERIFY_FAILED')
    expect(error.source).toContain('.tar.gz')
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('refuses an archive whose length differs from the manifest’s, naming both lengths', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    const archive = server.files.get(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`)!
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`, Buffer.concat([archive, Buffer.from('extra')]))
    const release = await channel.resolve()
    const error = await refusal(channel.fill(release, await staging()), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('bytes')
  })

  it('refuses a file list whose bytes are not the manifest’s', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.files.json`, Buffer.from('{"signed":{}}'))
    const release = await channel.resolve()
    await refusal(channel.fill(release, await staging()), 'INSTALL_VERIFY_FAILED')
  })

  it('refuses an install of a release it never resolved', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture)
    await refusal(channel.fill({ version: brandString<RuntimeVersion>(VERSION), root: fixture.rootMetadata }, await staging()), 'INSTALL_VERIFY_FAILED')
  })
})

describe('the release log', () => {
  it('refuses the install when the log cannot be reached, rather than installing unchecked', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { log: unreachableLog() })
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_UNCHECKED')
    expect(error.detail).toContain('could not be checked')
  })

  it('refuses the install when the checkpoint is not the log’s signature', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { log: logService('not a signed checkpoint\n') })
    await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
  })

  it('refuses the install when the bundle’s inclusion proof does not verify', async () => {
    const fixture = await fixtureRelease({ tamperInclusion: true })
    const { channel } = await harness(fixture)
    await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
  })
})

describe('a release the channel does not offer', () => {
  it('refuses a version that is not the one the fresh timestamp names', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture)
    await refusal(channel.resolve(brandString<RuntimeVersion>('9.9.9')), 'RELEASE_NOT_OFFERED')
  })

  it('refuses every release when the launcher embeds no root', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { roots: [] })
    await refusal(channel.resolve(), 'NO_TRUSTED_ROOT')
  })
})
