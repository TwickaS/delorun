/**
 * A release a person supplies (`--from`) that the channel's fresh timestamp does not confirm installs only after the
 * person agrees, and only timestamp freshness is relaxed: the targets signature, the release-log bundle, the root
 * chain and the floor still refuse, and the stored timestamp is never replaced.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReleaseLogTransport } from '@delorun/release-verify'
import { LOCAL_RELEASE_BUILDER } from '@delorun/release-formats/sign/schemas'
import { Downloader } from '../src/download.ts'
import { isInstallError } from '../src/errors.ts'
import { LauncherChannel, type UnconfirmedInstall, type UnconfirmedQuestion } from '../src/channel.ts'
import { fixtureRelease, logService, NOW, releasePaths, standIn, unreachableLog, type Fixture, type StandIn } from './support.ts'

const LOOPBACK = { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 }
const FOUR_DAYS = 4 * 24 * 3600

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.map(step => step()))
  cleanup = []
})

/** A channel over a fixture, with the files the spec keeps and a record of the questions asked. */
async function harness(fixture: Fixture, change: { readonly files?: (paths: Map<string, Buffer>) => void, readonly now?: number, readonly unconfirmed?: Partial<UnconfirmedInstall>, readonly answer?: boolean, readonly log?: 'unreachable' | ReleaseLogTransport, readonly productionRoot?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'delorun-install-unconfirmed-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const paths = releasePaths(fixture)
  change.files?.(paths)
  const server: StandIn = await standIn(paths)
  cleanup.push(() => server.close())
  const questions: UnconfirmedQuestion[] = []
  const channel = new LauncherChannel({
    home,
    platform: fixture.platform,
    roots: fixture.roots,
    channel: 'stable',
    log: change.log === 'unreachable' ? unreachableLog() : change.log ?? logService(fixture.checkpoint),
    ...change.productionRoot === undefined ? {} : { productionRoot: change.productionRoot },
    source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` },
    downloader: new Downloader({ hosts: LOOPBACK }),
    now: () => (change.now ?? NOW) * 1000,
    unconfirmed: { allow: async (question) => { questions.push(question); return change.answer ?? true }, ...change.unconfirmed },
  })
  return { channel, home, questions }
}

describe('a release the timestamp does not confirm', () => {
  it('installs an expired-timestamp release after the person agrees, and leaves the stored timestamp alone', async () => {
    const fixture = await fixtureRelease()
    const { channel, home, questions } = await harness(fixture, { now: NOW + FOUR_DAYS })
    const release = await channel.resolve()
    expect(release.version).toBe('0.1.0')
    expect(questions).toHaveLength(1)
    expect(questions[0]!.reason).toMatch(/out of date.*expired/su)
    await expect(readFile(join(home, 'trust', 'timestamp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not ask when the timestamp is fresh', async () => {
    const fixture = await fixtureRelease()
    const { channel, questions } = await harness(fixture)
    await channel.resolve()
    expect(questions).toEqual([])
  })

  it('installs from a source with no timestamp when the release is named', async () => {
    const fixture = await fixtureRelease()
    const { channel, questions } = await harness(fixture, { files: paths => paths.delete('/timestamp.json'), unconfirmed: { version: '0.1.0' as never }, log: 'unreachable' })
    await channel.resolve()
    expect(questions[0]!.reason).toMatch(/timestamp\.json/u)
  })

  it('does not install when the person declines', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { now: NOW + FOUR_DAYS, answer: false })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'RELEASE_NOT_OFFERED')).toBe(true)
    expect((error as Error).message).toMatch(/did not agree/u)
  })

  it('refuses a manifest signed by the wrong key, even after the person would agree', async () => {
    const fixture = await fixtureRelease({ manifestSigners: [(await fixtureRelease()).keys.targets] })
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'INSTALL_VERIFY_FAILED')).toBe(true)
    expect(questions).toEqual([])
  })

  it('refuses a release below the floor and does not ask', async () => {
    const fixture = await fixtureRelease()
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS, unconfirmed: { floor: '0.2.0' } })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect((error as Error).message).toMatch(/TARGET_LOWER/u)
    expect(questions).toEqual([])
  })

  it('asks about a release below the floor only when the caller allows that', async () => {
    const fixture = await fixtureRelease()
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS, unconfirmed: { floor: '0.2.0', belowFloor: true } })
    await channel.resolve()
    expect(questions[0]!.belowFloor).toBe('0.2.0')
  })

  it('names a release file the source lacks', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { now: NOW + FOUR_DAYS, files: paths => paths.delete('/releases/0.1.0/delorun-0.1.0.manifest.log.json') })
    const error = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'RELEASE_LOG_FAILED') || isInstallError(error, 'DOWNLOAD_FAILED')).toBe(true)
    expect((error as { source: string }).source).toMatch(/manifest\.log\.json/u)
  })

  it('refuses a source without a timestamp when no release is named', async () => {
    const fixture = await fixtureRelease()
    const { channel } = await harness(fixture, { files: paths => paths.delete('/timestamp.json') })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'DOWNLOAD_FAILED')).toBe(true)
  })

  it('never writes the stale timestamp even when it is newer than none', async () => {
    const fixture = await fixtureRelease({ timestampVersion: 7 })
    const { channel, home } = await harness(fixture, { now: NOW + FOUR_DAYS })
    await writeFile(join(home, 'unused'), '')
    await channel.resolve()
    await expect(readFile(join(home, 'trust', 'timestamp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('a release the timestamp does not confirm, past the checks that never relax', () => {
  it('refuses when the online release-log check fails in this client, after the person agreed', async () => {
    const fixture = await fixtureRelease()
    const log: ReleaseLogTransport = { latestCheckpoint: () => Promise.reject(new TypeError('a defect')), consistencyProof: () => Promise.resolve([]) }
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS, log })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'RELEASE_LOG_FAILED')).toBe(true)
    expect(questions).toHaveLength(1)
  })

  it('refuses a release the local release build signed when the roots are production roots, without asking', async () => {
    const fixture = await fixtureRelease({ builder: LOCAL_RELEASE_BUILDER })
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS, productionRoot: true })
    const error: unknown = await channel.resolve().then(() => undefined, (failure: unknown) => failure)
    expect(isInstallError(error, 'INSTALL_VERIFY_FAILED')).toBe(true)
    expect((error as Error).message).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
    expect(questions).toEqual([])
  })

  it('installs a release the local release build signed when the roots are not production roots', async () => {
    const fixture = await fixtureRelease({ builder: LOCAL_RELEASE_BUILDER })
    const { channel, questions } = await harness(fixture, { now: NOW + FOUR_DAYS })
    expect((await channel.resolve()).version).toBe('0.1.0')
    expect(questions).toHaveLength(1)
  })
})
