/**
 * The install path's refusals, as a launcher meets them: a release file the download rule does not allow, a manifest
 * whose bytes are not the ones the timestamp signs, an archive whose bytes are not the ones the manifest signs, a
 * release log that contradicts the release, and a release the channel does not offer. Each refuses with its contract
 * C1 or C18 code, and none of them installs anything. A release log that cannot be reached or is stale does not
 * refuse: the install warns through its progress events and records that the check did not run.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_METADATA_ORIGIN } from '@delorun/contract-release-manifest'
import { LOCAL_RELEASE_BUILDER } from '@delorun/release-formats/sign/schemas'
import { Downloader } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { LauncherChannel, MAX_ROOT_ROTATIONS, RELEASE_SOURCE, type LauncherChannelOptions, type ReleaseSource } from '../src/channel.ts'
import { leafHash, treeRoot } from '@delorun/release-formats/log/merkle'
import { checkpointBody, signatureLine } from '@delorun/release-formats/log/note'
import { LogUnreachableError } from '@delorun/release-verify/online'
import { readCheckState } from '@delorun/release-verify/state'
import type { InstallProgress } from '../src/progress.ts'
import { envelope, fixtureKeys, fixtureRelease, LOG_ORIGIN, logService, WITNESS_NAME, nextRoot, NOW, releasePaths, sha256, standIn, unreachableLog, VERSION, type Fixture, type StandIn } from './support.ts'

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
 * A temporary Delorun home a channel records under.
 * @returns its path.
 */
async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'delorun-install-channel-'))
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
  const parent = await mkdtemp(join(tmpdir(), 'delorun-install-staging-'))
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
    // The chain the walk covered is kept beside the root it ended at, so a start can prove a root newer than the ones
    // its launcher ships descends from one of them.
    expect(await readdir(join(home, 'trust', 'roots'))).toEqual(['1.root.json'])
    expect(await readFile(join(home, 'trust', 'roots', '1.root.json'))).toEqual(Buffer.from(fixture.roots[0]!))
  })
})

describe('a release a local release build signed', () => {
  /**
   * A channel over contract C2's production publication whose every request a map of paths answers, so the channel
   * fetches as a production launcher does without reaching a network.
   * @param fixture - the release the publication serves.
   * @returns the channel.
   */
  async function production(fixture: Fixture): Promise<LauncherChannel> {
    const files = releasePaths(fixture)
    const served: typeof globalThis.fetch = async (input) => {
      const bytes = files.get(new URL(input instanceof Request ? input.url : String(input)).pathname)
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200 })
    }
    const source: ReleaseSource = { metadata: RELEASE_METADATA_ORIGIN, files: (version, name) => `${RELEASE_METADATA_ORIGIN}/releases/${version}/${name}` }
    return new LauncherChannel({
      home: await scratchHome(),
      platform: fixture.platform,
      roots: fixture.roots,
      channel: 'stable',
      log: logService(fixture.checkpoint),
      source,
      downloader: new Downloader({ fetch: served, hosts: { scheme: 'https:', hosts: [new URL(RELEASE_METADATA_ORIGIN).hostname], maxRedirects: 0 } }),
      now: () => NOW * 1000,
    })
  }

  it('c02-production-refuses-local-release: is refused by a channel that fetches from the production publication', async () => {
    const fixture = await fixtureRelease({ builder: LOCAL_RELEASE_BUILDER })
    const error = await refusal((await production(fixture)).resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
    await refusal((await production(fixture)).newest(), 'INSTALL_VERIFY_FAILED')
  })

  it('is installed from a channel of its own, and a production channel installs a release the holder rebuilt', async () => {
    const local = await fixtureRelease({ builder: LOCAL_RELEASE_BUILDER })
    expect(String((await (await harness(local)).channel.resolve()).version)).toBe(VERSION)
    expect(String((await (await production(await fixtureRelease())).resolve()).version)).toBe(VERSION)
  })
})

describe('a release without this computer\'s platform', () => {
  it('refuses before the log check and any download, naming the platform and the platforms the release lists', async () => {
    const fixture = await fixtureRelease({ released: ['linux-x64', 'linux-arm64', 'win32-x64'] })
    const steps: string[] = []
    const { channel } = await harness(fixture, { platform: 'darwin-arm64', progress: (event) => { steps.push(event.step) } })
    const error = await refusal(channel.resolve(), 'PLATFORM_NOT_RELEASED')
    expect(error.detail).toBe('darwin-arm64 is not in this release, which publishes a runtime for linux-x64, linux-arm64, win32-x64 only')
    expect(error.source).toBe(VERSION)
    expect(steps).not.toContain('log-checked')
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

  it('stops an archive longer than the manifest’s length as it arrives, holding the download to the signed length', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    const archive = server.files.get(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`)!
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`, Buffer.concat([archive, Buffer.from('extra')]))
    const release = await channel.resolve()
    const error = await refusal(channel.fill(release, await staging()), 'DOWNLOAD_FAILED')
    expect(error.detail).toContain(`above its limit of ${String(archive.byteLength)}`)
  })

  it('refuses an archive shorter than the manifest’s length, naming both lengths', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    const archive = server.files.get(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`)!
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`, archive.subarray(0, archive.byteLength - 1))
    const error = await refusal(channel.fill(await channel.resolve(), await staging()), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain(`has ${String(archive.byteLength - 1)} bytes; the manifest lists ${String(archive.byteLength)}`)
  })

  it('holds the manifest and the file list to the lengths the signed files give them', async () => {
    const fixture = await fixtureRelease()
    const { channel, server } = await harness(fixture)
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}.manifest.json`, Buffer.concat([fixture.manifestBytes, Buffer.from(' ')]))
    const manifestError = await refusal(channel.resolve(), 'DOWNLOAD_FAILED')
    expect(manifestError.detail).toContain(`above its limit of ${String(fixture.manifestBytes.byteLength)}`)
    const other = await harness(fixture)
    other.server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.files.json`, Buffer.concat([fixture.filesBytes, Buffer.from(' ')]))
    const filesError = await refusal(other.channel.fill(await other.channel.resolve(), await staging()), 'DOWNLOAD_FAILED')
    expect(filesError.detail).toContain(`above its limit of ${String(fixture.filesBytes.byteLength)}`)
  })

  it('removes the download directories an earlier run left under staging before it downloads', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture)
    const directory = await staging()
    const left = join(dirname(directory), '.download-abandoned')
    await mkdir(left)
    await writeFile(join(left, 'delorun.tar.gz'), 'half')
    await channel.fill(await channel.resolve(), directory)
    expect((await readdir(dirname(directory))).filter(name => name.startsWith('.download-'))).toEqual([])
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
  it('c18-store-install-missing-bundle-fails: refuses a release that publishes no bundle, and records nothing', async () => {
    const fixture = await fixtureRelease()
    const { channel, home, server } = await harness(fixture)
    server.files.delete(`/releases/${VERSION}/delorun-${VERSION}.manifest.log.json`)
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('publishes no release-log bundle')
    expect(await readdir(join(home, 'trust'))).not.toContain('release-log.json')
  })

  it('continues on the signature when the log cannot be reached, and records that the check did not run', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    const { channel, home } = await harness(fixture, { log: unreachableLog(), progress: event => events.push(event) })
    const release = await channel.resolve()
    expect(events.filter(event => event.step === 'log-checked')).toEqual([
      { step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the release log gave no checkpoint (the log refused the connection)' },
    ])
    await channel.fill(release, await staging())
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await channel.recordInstalled(release)
    // The release-verify package reads the record the install wrote, so the start check continues from it.
    const entry = { release: VERSION, state: 'unchecked', detail: 'the release log gave no checkpoint (the log refused the connection)', lastAttempt: NOW, uncheckedSince: NOW }
    expect(readCheckState(await readFile(join(home, 'trust', 'release-log.json'))).get(VERSION)).toEqual(entry)
    const state = JSON.parse(await readFile(join(home, 'trust', 'release-log.json'), 'utf8')) as { schema: string, releases: Record<string, unknown> }
    expect(state).toEqual({ schema: 'delorun.release-log-state/1', releases: { [VERSION]: entry } })
    await expect(readFile(join(home, 'trust', 'checkpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues when the log gives no consistency proof, naming that as the reason', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    const { channel } = await harness(fixture, {
      log: { latestCheckpoint: () => Promise.resolve(fixture.checkpoint), consistencyProof: () => Promise.reject(new LogUnreachableError('the log answered 503')) },
      progress: event => events.push(event),
    })
    await channel.resolve()
    expect(events.find(event => event.step === 'log-checked')).toEqual({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the log\'s consistency proof could not be read (the log answered 503)' })
  })

  it('continues when the log’s newest witnessed checkpoint is stale, naming its age', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    // The fixture's checkpoint was cosigned a minute before NOW; two days later it is 48 hours old, and the timestamp,
    // which lives three days, still verifies.
    const { channel } = await harness(fixture, { now: () => (NOW + 2 * 24 * 3600) * 1000, progress: event => events.push(event) })
    await channel.resolve()
    expect(events.find(event => event.step === 'log-checked')).toEqual({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the newest witness cosignature is 172860 seconds old, over the 86400-second limit' })
  })

  it('continues and records unchecked when the log’s latest checkpoint has no witness cosignature', async () => {
    const fixture = await fixtureRelease()
    const body = checkpointBody(LOG_ORIGIN, 1, treeRoot([...fixture.leaves]))
    const events: InstallProgress[] = []
    const { channel, home } = await harness(fixture, { log: logService(`${body}\n${signatureLine(LOG_ORIGIN, fixture.keys.log, body)}`), progress: event => events.push(event) })
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    await channel.recordInstalled(release)
    expect(events.find(event => event.step === 'log-checked')).toEqual({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the latest checkpoint has 0 of the 1 witness cosignatures a check needs' })
    const state = JSON.parse(await readFile(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
  })

  it('refuses, and records nothing, when a witness’s cosignature is present and invalid', async () => {
    const fixture = await fixtureRelease()
    const body = checkpointBody(LOG_ORIGIN, 1, treeRoot([...fixture.leaves]))
    const other = checkpointBody(LOG_ORIGIN, 2, treeRoot([...fixture.leaves, leafHash(Buffer.from('second'))]))
    const forged = `${body}\n${signatureLine(LOG_ORIGIN, fixture.keys.log, body)}${signatureLine(WITNESS_NAME, fixture.keys.witness, other, NOW - 60)}`
    const { channel, home } = await harness(fixture, { log: logService(forged) })
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain(`the cosignature of witness ${WITNESS_NAME} does not verify`)
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records a passing check as verified', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    await channel.recordInstalled(release)
    const state = JSON.parse(await readFile(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, unknown> }
    expect(state.releases[VERSION]).toEqual({ release: VERSION, state: 'verified', lastAttempt: NOW })
  })

  it('keeps the check state of another release when it records this one', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'trust', 'release-log.json'), `${JSON.stringify({ schema: 'delorun.release-log-state/1', releases: { '0.0.9': { release: '0.0.9', state: 'verified', lastAttempt: 1 } } })}\n`, { mode: 0o600 })
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    await channel.recordInstalled(release)
    const state = JSON.parse(await readFile(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, unknown> }
    expect(Object.keys(state.releases)).toEqual(['0.0.9', VERSION])
  })

  it('replaces a check state that does not read, and refuses one other users can read', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'trust', 'release-log.json'), 'not json', { mode: 0o600 })
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    await channel.recordInstalled(release)
    expect(readCheckState(await readFile(join(home, 'trust', 'release-log.json'))).get(VERSION)?.state).toBe('verified')
    await chmod(join(home, 'trust', 'release-log.json'), 0o644)
    await refusal(channel.recordInstalled(release), 'TRUST_STATE_INVALID')
  })

  it('records nothing for a release it never resolved, and nothing for a release whose fill refused', async () => {
    const fixture = await fixtureRelease()
    const { channel, home, server } = await harness(fixture)
    await refusal(channel.recordInstalled({ version: brandString<RuntimeVersion>(VERSION), root: fixture.rootMetadata }), 'INSTALL_VERIFY_FAILED')
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`, Buffer.from('not the archive'))
    await refusal(channel.fill(await channel.resolve(), await staging()), 'INSTALL_VERIFY_FAILED')
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports each step it finishes, in order, with the archive’s size', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    const { channel } = await harness(fixture, { progress: event => events.push(event) })
    await channel.fill(await channel.resolve(), await staging())
    const name = `delorun-${VERSION}-${fixture.platform}.tar.gz`
    expect(events.filter(event => event.step !== 'download-bytes' && event.step !== 'unpack-files')).toEqual([
      { step: 'resolving', channel: 'stable' },
      { step: 'resolved', channel: 'stable', version: VERSION },
      { step: 'signature-checked', version: VERSION, rootVersion: 1 },
      { step: 'log-checked', version: VERSION, state: 'verified' },
      { step: 'downloading', name, bytes: fixture.archive.byteLength },
      { step: 'downloaded', name, bytes: fixture.archive.byteLength },
      { step: 'download-verified', name },
      { step: 'unpacking', files: expect.any(Number) as number },
    ])
  })

  it('reports the bytes of the archive and the files written, ending on the full count, and names the hash check only after the bytes arrived', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    const { channel } = await harness(fixture, { progress: event => events.push(event) })
    await channel.fill(await channel.resolve(), await staging())
    const bytes = events.filter(event => event.step === 'download-bytes')
    expect(bytes.at(-1)).toMatchObject({ received: fixture.archive.byteLength, total: fixture.archive.byteLength })
    const files = events.filter(event => event.step === 'unpack-files')
    const unpacking = events.find(event => event.step === 'unpacking')
    expect(files.at(-1)).toMatchObject({ written: (unpacking as { files: number }).files, total: (unpacking as { files: number }).files })
    const order = events.map(event => event.step)
    expect(order.indexOf('downloaded')).toBeGreaterThan(order.lastIndexOf('download-bytes'))
    expect(order.indexOf('download-verified')).toBeGreaterThan(order.indexOf('downloaded'))
    expect(order.indexOf('unpacking')).toBeGreaterThan(order.indexOf('download-verified'))
  })

  it('reports no more than ten counts a second, and always the last one', async () => {
    const fixture = await fixtureRelease()
    const still: InstallProgress[] = []
    // A clock that never moves: only the first count and the last of each kind pass the limit.
    const first = await harness(fixture, { now: () => NOW * 1000, progress: event => still.push(event) })
    await first.channel.fill(await first.channel.resolve(), await staging())
    expect(still.filter(event => event.step === 'download-bytes').length).toBeLessThanOrEqual(2)
    expect(still.filter(event => event.step === 'unpack-files').length).toBeLessThanOrEqual(2)
    expect(still.filter(event => event.step === 'unpack-files').at(-1)).toMatchObject({ written: 3, total: 3 })
    // A clock that moves a second at each reading: every count passes.
    const moving: InstallProgress[] = []
    let time = NOW * 1000
    const second = await harness(fixture, { now: () => (time += 1000), progress: event => moving.push(event) })
    await second.channel.fill(await second.channel.resolve(), await staging())
    const unpacking = moving.find(event => event.step === 'unpacking') as { files: number }
    expect(moving.filter(event => event.step === 'unpack-files')).toHaveLength(unpacking.files)
  })

  it('reports nothing about the log and installs nothing when the log contradicts the release', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    // The log's signed checkpoint, with a consistency proof that does not hold.
    const { channel, home } = await harness(fixture, { log: logService(fixture.checkpoint, [Buffer.alloc(32, 7)]), progress: event => events.push(event) })
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('consistency-proof-invalid')
    expect(events.map(event => event.step)).toEqual(['resolving', 'resolved', 'signature-checked'])
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues unchecked when the log answers with something that is not its signed checkpoint, such as a proxy\'s page', async () => {
    const fixture = await fixtureRelease()
    const events: InstallProgress[] = []
    const { channel } = await harness(fixture, { log: logService('not a signed checkpoint\n'), progress: event => events.push(event) })
    await channel.resolve()
    expect(events.find(event => event.step === 'log-checked')).toMatchObject({ step: 'log-checked', state: 'unchecked' })
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

describe('the channel’s defaults', () => {
  it('fetches every file from the release host, with the version’s GitHub release and the spare host as mirrors', async () => {
    expect(RELEASE_SOURCE.metadata).toBe('https://releases.delorun.com')
    expect(RELEASE_SOURCE.files('0.1.0' as never, 'delorun-0.1.0.manifest.json')).toBe('https://releases.delorun.com/releases/download/v0.1.0/delorun-0.1.0.manifest.json')
    expect(RELEASE_SOURCE.mirrors?.map(mirror => mirror.files?.('0.1.0' as never, 'a'))).toEqual(['https://github.com/twickas/delorun/releases/download/v0.1.0/a', 'https://releases.delo.run/releases/download/v0.1.0/a'])
    const fixture = await fixtureRelease()
    const channel = new LauncherChannel({ home: await scratchHome(), platform: fixture.platform, roots: fixture.roots, channel: 'stable', log: logService(fixture.checkpoint) })
    expect(channel).toBeInstanceOf(LauncherChannel)
  })
})

describe('the log transport', () => {
  it('is made for the root being trusted when the options give a function', async () => {
    const fixture = await fixtureRelease()
    const roots: string[] = []
    const { channel } = await harness(fixture, {
      log: (root) => {
        roots.push(root.log.origin)
        return logService(fixture.checkpoint)
      },
    })
    await channel.resolve()
    expect(roots).toEqual([LOG_ORIGIN])
  })
})

describe('a home that has installed before', () => {
  it('reads the checkpoint an earlier install stored in the earlier format, and replaces it with a notice when the log cannot prove it', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'trust', 'checkpoint.json'), `${JSON.stringify({ treeSize: 9, rootHash: 'ab'.repeat(32) })}\n`, { mode: 0o600 })
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    await channel.recordInstalled(release)
    // No refusal and no manual removal: the verified checkpoint replaced the earlier record, and the state says so.
    expect(JSON.parse(await readFile(join(home, 'trust', 'checkpoint.json'), 'utf8'))).toMatchObject({ schema: 'delorun.release-log-checkpoint/1', treeSize: 1 })
    const state = readCheckState(await readFile(join(home, 'trust', 'release-log.json'))).get(VERSION)
    expect(state?.state).toBe('verified')
    expect(state?.notices).toEqual(['the checkpoint an earlier install stored, tree size 9, could not be proved against the log\'s latest checkpoint, so it sets no floor and is replaced'])
  })

  it('refuses the install when a release-log record under trust/ is one other users can read', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'trust', 'checkpoint.json'), '{}', { mode: 0o644 })
    await chmod(join(home, 'trust', 'checkpoint.json'), 0o644)
    await refusal(channel.resolve(), 'TRUST_STATE_INVALID')
  })

  it('refuses the install when the verified checkpoint cannot be written under trust/', async () => {
    const fixture = await fixtureRelease()
    let home = ''
    const log = logService(fixture.checkpoint)
    const harnessed = await harness(fixture, {
      log: {
        latestCheckpoint: async (signal) => {
          // The roots and timestamp are stored by now; the directory then refuses the checkpoint.
          await chmod(join(home, 'trust'), 0o500)
          return log.latestCheckpoint(signal)
        },
        consistencyProof: log.consistencyProof,
      },
    })
    home = harnessed.home
    try {
      const error = await refusal(harnessed.channel.resolve(), 'TRUST_STATE_INVALID')
      expect(error.source).toBe(join(home, 'trust'))
    } finally {
      await chmod(join(home, 'trust'), 0o700)
    }
  })

  it('refuses the install when this client\'s own release-log check fails, and records nothing', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture, { log: { latestCheckpoint: () => Promise.reject(new TypeError('a defect')), consistencyProof: () => Promise.resolve([]) } })
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('failed in this client')
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds a later timestamp to the stored one and proves the log from the stored checkpoint', async () => {
    const fixture = await fixtureRelease()
    const { channel, home, server } = await harness(fixture)
    await channel.resolve()
    const again = new LauncherChannel({
      home,
      platform: fixture.platform,
      roots: fixture.roots,
      channel: 'stable',
      log: logService(fixture.checkpoint),
      source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` },
      downloader: new Downloader({ hosts: LOOPBACK }),
      now: () => NOW * 1000,
    })
    expect(String((await again.resolve()).version)).toBe(VERSION)
    expect(JSON.parse(await readFile(join(home, 'trust', 'checkpoint.json'), 'utf8'))).toMatchObject({ schema: 'delorun.release-log-checkpoint/1', origin: LOG_ORIGIN, rootHash: fixture.bundle.inclusion.rootHash, treeSize: 1, checkpoint: fixture.checkpoint })
  })
})

describe('a root the launcher does not ship yet', () => {
  it('walks to the root the timestamp names, fetching each later root file, and keeps the chain', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const timestamp = envelope({ ...fixture.timestamp, root: { version: 2, sha256: sha256(second) } }, [fixture.keys.timestamp])
    const { channel, server, home } = await harness(fixture)
    server.files.set('/timestamp.json', timestamp)
    server.files.set('/root/2.root.json', second)
    await channel.resolve()
    expect(server.requests).toContain('/root/2.root.json')
    expect(await readdir(join(home, 'trust', 'roots'))).toEqual(['1.root.json', '2.root.json'])
  })

  it('starts the walk at the root the home adopted, so a timestamp signed under an older root cannot move the home back', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const forward = envelope({ ...fixture.timestamp, root: { version: 2, sha256: sha256(second) } }, [fixture.keys.timestamp])
    const { channel, server, home } = await harness(fixture)
    server.files.set('/timestamp.json', forward)
    server.files.set('/root/2.root.json', second)
    await channel.resolve()
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(second)
    server.requests.length = 0
    // The same timestamp again: the home trusts root 2, so it asks for no root file.
    await channel.resolve()
    expect(server.requests).not.toContain('/root/2.root.json')
    // The compromised root 1 signs a timestamp that names root 1.
    server.files.set('/timestamp.json', fixture.timestampBytes)
    const error = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('older than root 2, which this home trusts; a root never moves backwards')
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(second)
  })

  it('walks from the shipped roots when the stored root is not one they lead to', async () => {
    const fixture = await fixtureRelease()
    const { channel, server, home } = await harness(fixture)
    await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'trust', 'root.json'), 'not a root', { mode: 0o600 })
    expect(String((await channel.resolve()).version)).toBe(VERSION)
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(Buffer.from(fixture.roots[0]!))
    expect(server.requests).not.toContain('/root/2.root.json')
  })

  it('stops, rather than walk from the shipped roots, when the chain beside the stored root cannot be read', async () => {
    const fixture = await fixtureRelease()
    const { channel, home } = await harness(fixture)
    await channel.resolve()
    await rm(join(home, 'trust', 'roots'), { recursive: true })
    await writeFile(join(home, 'trust', 'roots'), 'in the way')
    await refusal(channel.resolve(), 'TRUST_STATE_INVALID')
  })

  it('refuses a timestamp that names a root many versions ahead before it asks for any root file', async () => {
    const fixture = await fixtureRelease()
    const far = envelope({ ...fixture.timestamp, root: { version: 1 + MAX_ROOT_ROTATIONS + 1, sha256: sha256(Buffer.from('x')) } }, [fixture.keys.timestamp])
    const { channel, server } = await harness(fixture)
    server.files.set('/timestamp.json', far)
    const error = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain(`${String(MAX_ROOT_ROTATIONS + 1)} versions past root 1, which this home trusts; an install walks at most ${String(MAX_ROOT_ROTATIONS)}`)
    expect(server.requests.filter(path => path.startsWith('/root/'))).toEqual([])
  })

  it('verifies each root as it arrives, and asks for no root past one that does not verify', async () => {
    const fixture = await fixtureRelease()
    const stranger = fixtureKeys()
    const forged = nextRoot(fixture.rootMetadata, fixture.keys, [stranger.root])
    const far = envelope({ ...fixture.timestamp, root: { version: 5, sha256: sha256(forged) } }, [fixture.keys.timestamp])
    const { channel, server } = await harness(fixture)
    server.files.set('/timestamp.json', far)
    server.files.set('/root/2.root.json', forged)
    const error = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.source).toContain('/root/2.root.json')
    expect(error.detail).toContain('root 2 does not follow root 1')
    expect(server.requests.filter(path => path.startsWith('/root/'))).toEqual(['/root/2.root.json'])
  })

  it('refuses a timestamp that names a root older than the one the launcher ships', async () => {
    const fixture = await fixtureRelease()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const { channel } = await harness(fixture, { roots: [second] })
    const error = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('older than root 2')
  })
})

describe('the production origins and their mirrors', () => {
  type Serve = (host: string, path: string) => Response | undefined

  /**
   * A channel over the production source whose fetch answers per host.
   * @param fixture - the release.
   * @param serve - answers for a host and path, or `undefined` to fail the connection.
   * @returns the channel, the progress events and the hosts asked, in order.
   */
  async function mirrored(fixture: Fixture, serve: Serve): Promise<{ readonly channel: LauncherChannel, readonly events: InstallProgress[], readonly asked: string[] }> {
    const events: InstallProgress[] = []
    const asked: string[] = []
    const fetched: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      asked.push(url.hostname)
      const response = serve(url.hostname, url.pathname)
      if (response === undefined) throw new TypeError('fetch failed')
      return response
    }
    const channel = new LauncherChannel({
      home: await scratchHome(),
      platform: fixture.platform,
      roots: fixture.roots,
      channel: 'stable',
      log: logService(fixture.checkpoint),
      downloader: new Downloader({ fetch: fetched }),
      now: () => NOW * 1000,
      progress: event => events.push(event),
    })
    return { channel, events, asked }
  }

  /** The release's files by path, as `releases.delorun.com` lays them out. */
  function published(fixture: Fixture): Map<string, Buffer> {
    return new Map([...releasePaths(fixture)].map(([path, bytes]) => [path.replace(/^\/releases\/([^/]+)\//u, '/releases/download/v$1/'), bytes]))
  }

  const ok = (bytes: Buffer): Response => new Response(new Uint8Array(bytes), { status: 200 })

  it('installs from the mirrors when the primary host is down, and says which origin served what', async () => {
    const fixture = await fixtureRelease()
    const files = published(fixture)
    const { channel, events, asked } = await mirrored(fixture, (host, path) => {
      if (host === 'releases.delorun.com') return undefined
      const bytes = files.get(path.replace('/twickas/delorun', ''))
      return bytes === undefined ? new Response(null, { status: 404 }) : ok(bytes)
    })
    const release = await channel.resolve()
    await channel.fill(release, await staging())
    expect(asked).toContain('releases.delo.run')
    expect(events).toContainEqual(expect.objectContaining({ step: 'origin-skipped', name: 'timestamp.json', failed: 'releases.delorun.com', served: 'releases.delo.run' }))
    expect(events).toContainEqual(expect.objectContaining({ step: 'origin-skipped', failed: 'releases.delorun.com', served: 'github.com' }))
  })

  it('refuses a mirror that serves tampered bytes after the primary failed', async () => {
    const fixture = await fixtureRelease()
    const files = published(fixture)
    const archive = `/releases/download/v${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`
    const { channel } = await mirrored(fixture, (host, path) => {
      if (host === 'releases.delorun.com') return path === archive ? new Response(null, { status: 503 }) : ok(files.get(path)!)
      const bytes = files.get(path.replace('/twickas/delorun', ''))!
      return ok(path.endsWith(archive) ? Buffer.from(bytes).fill(1) : bytes)
    })
    const release = await channel.resolve()
    await refusal(channel.fill(release, await staging()), 'INSTALL_VERIFY_FAILED')
  })

  it('retries a file whose bytes fail verification on the next origin, and uses it only when those bytes verify', async () => {
    const fixture = await fixtureRelease()
    const files = published(fixture)
    const archive = `/releases/download/v${VERSION}/delorun-${VERSION}-${fixture.platform}.tar.gz`
    const { channel, events } = await mirrored(fixture, (host, path) => {
      const bytes = files.get(path.replace('/twickas/delorun', ''))!
      return ok(host === 'releases.delorun.com' && path === archive ? Buffer.from(bytes).fill(1) : bytes)
    })
    await channel.fill(await channel.resolve(), await staging())
    expect(events).toContainEqual(expect.objectContaining({ step: 'origin-skipped', failed: 'releases.delorun.com', served: 'github.com' }))
  })

  it('refuses a redirect to a host outside the allowlist without asking a mirror', async () => {
    const fixture = await fixtureRelease()
    const { channel, asked } = await mirrored(fixture, host => (host === 'releases.delorun.com'
      ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/timestamp.json' } })
      : undefined))
    await refusal(channel.resolve(), 'DOWNLOAD_REFUSED')
    expect(asked).toEqual(['releases.delorun.com'])
  })
})
