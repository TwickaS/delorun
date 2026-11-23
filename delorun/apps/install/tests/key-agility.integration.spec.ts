/**
 * The log-entry keys and logs a root lists, as a launcher meets them across a root rotation (contracts C2 and C18): a
 * root without them, as `1.root.json` is, verifies no release; a home adopts a root 2 that lists them and installs an
 * ECDSA-logged release under it; a home that adopted a root which revoked a key cannot be moved back to the root that
 * listed it; a list in a root the chain does not verify is never read; and the production allowance for a locally built
 * 0.x release holds under a root chain that holds the root file the launcher pins by its digest (L196).
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_METADATA_ORIGIN, type LogEntryKey, type RootMetadata, type SemanticVersion } from '@delorun/contract-release-manifest'
import { LOCAL_RELEASE_BUILDER } from '@delorun/release-formats/sign/schemas'
import { Downloader } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { LauncherChannel, type LauncherChannelOptions, type ReleaseSource } from '../src/channel.ts'
import { envelope, fixtureKeys, fixtureRelease, logService, nextRoot, NOW, releasePaths, sha256, standIn, VERSION, type Fixture, type FixtureKeys, type StandIn } from './support.ts'

const LOOPBACK = { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 }

const servers: StandIn[] = []
const homes: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** A throwaway ECDSA P-256 log-entry key, the same for every release of one spec. */
const ECDSA = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey

/**
 * A log-entry key as a root lists it.
 * @param keyDetails - the entry key type.
 * @param key - the private or public key.
 * @param status - its status; `active` by default.
 * @returns the entry.
 */
function listed(keyDetails: string, key: KeyObject, status: LogEntryKey['status'] = 'active'): LogEntryKey {
  return { keyDetails, public: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), status }
}

/**
 * Both entry key types, ECDSA P-256 by {@link ECDSA} first and Ed25519ph by the targets key as the alternative.
 * @param keys - the fixture keys.
 * @returns the list.
 */
function bothTypes(keys: FixtureKeys): readonly LogEntryKey[] {
  return [listed('PKIX_ECDSA_P256_SHA_256', ECDSA), listed('PKIX_ED25519_PH', keys.targets)]
}

/**
 * Root 2 after a fixture's root 1, listing both entry key types and the fixture's log.
 * @param fixture - the release.
 * @param signers - the keys that sign root 2; root 1's key by default.
 * @param entryKeys - the log-entry keys root 2 lists.
 * @returns root 2's file.
 */
function rootTwo(fixture: Fixture, signers: readonly KeyObject[] = [fixture.keys.root], entryKeys: readonly LogEntryKey[] = bothTypes(fixture.keys)): Buffer {
  return nextRoot(fixture.rootMetadata, fixture.keys, signers, next => ({ ...next, logs: [next.log], logEntryKeys: entryKeys }))
}

/** A release logged with {@link ECDSA}. */
const ECDSA_LOGGED = { entrySigner: () => ({ keyDetails: 'PKIX_ECDSA_P256_SHA_256' as const, key: ECDSA }) }

/**
 * A channel over a stand-in host serving a fixture release, with files a spec adds or replaces.
 * @param fixture - the release.
 * @param files - extra or replaced files, by path.
 * @param change - what the channel changes.
 * @returns the channel, its home and the host.
 */
async function harness(fixture: Fixture, files: ReadonlyMap<string, Buffer> = new Map(), change: Partial<LauncherChannelOptions> = {}): Promise<{ channel: LauncherChannel, home: string, server: StandIn }> {
  const home = await mkdtemp(join(tmpdir(), 'delorun-install-key-agility-'))
  homes.push(home)
  const paths = releasePaths(fixture)
  for (const [path, bytes] of files) paths.set(path, bytes)
  const server = await standIn(paths)
  servers.push(server)
  const source: ReleaseSource = { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` }
  const channel = new LauncherChannel({ home, platform: fixture.platform, roots: fixture.roots, channel: 'stable', log: logService(fixture.checkpoint), source, downloader: new Downloader({ hosts: LOOPBACK }), now: () => NOW * 1000, ...change })
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
 * The timestamp of a fixture release re-signed to name another root.
 * @param fixture - the release.
 * @param root - the root file the timestamp names.
 * @param version - the timestamp's version.
 * @returns the timestamp file.
 */
function timestampFor(fixture: Fixture, root: Buffer, version = 2): Buffer {
  const metadata = JSON.parse(root.toString('utf8')) as { signed: RootMetadata }
  return envelope({ ...fixture.timestamp, version, root: { version: metadata.signed.version, sha256: sha256(root) } }, [fixture.keys.timestamp])
}

describe('a root without logEntryKeys and logs', () => {
  it('c18-root-without-log-trust-refused: verifies no release, not even an Ed25519ph entry by its targets key', async () => {
    const fixture = await fixtureRelease({ bareRoot: true })
    const { channel, home } = await harness(fixture)
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('lists no logEntryKeys')
    await expect(readFile(join(home, 'trust', 'release-log.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('a release logged with an ECDSA P-256 key', () => {
  it('c02-rotation-adds-log-entry-key: installs once the home adopts a root 2 that lists the key, and keeps root 2', async () => {
    const fixture = await fixtureRelease({ ...ECDSA_LOGGED, bareRoot: true })
    const second = rootTwo(fixture)
    const { channel, home } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, second)], ['/root/2.root.json', second]]))
    expect(String((await channel.resolve()).version)).toBe(VERSION)
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(second)
  })

  it('installs an Ed25519ph release by the targets key, the listed alternative, under the same root 2', async () => {
    const fixture = await fixtureRelease({ bareRoot: true })
    const second = rootTwo(fixture)
    const { channel } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, second)], ['/root/2.root.json', second]]))
    expect(String((await channel.resolve()).version)).toBe(VERSION)
  })

  it('c18-listed-type-other-key-refused: is refused when its ECDSA key is not the one the root lists', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const fixture = await fixtureRelease({ entrySigner: () => ({ keyDetails: 'PKIX_ECDSA_P256_SHA_256', key: other }), bareRoot: true })
    const second = rootTwo(fixture)
    const { channel } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, second)], ['/root/2.root.json', second]]))
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('does not list')
  })

  it('is refused when root 2 retired its ECDSA key at a release below the signed manifest\'s version', async () => {
    const fixture = await fixtureRelease({ ...ECDSA_LOGGED, bareRoot: true })
    const second = rootTwo(fixture, [fixture.keys.root], [{ ...listed('PKIX_ECDSA_P256_SHA_256', ECDSA, 'retired'), lastRelease: brandString<SemanticVersion>('0.0.1') }, listed('PKIX_ED25519_PH', fixture.keys.targets)])
    const { channel } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, second)], ['/root/2.root.json', second]]))
    const error = await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    expect(error.detail).toContain('retired')
  })

  it('c02-log-entry-keys-unverified-root-refused: never reads a list in a root that the root before it did not sign', async () => {
    const fixture = await fixtureRelease({ ...ECDSA_LOGGED, bareRoot: true })
    const forged = rootTwo(fixture, [fixtureKeys().root])
    const { channel, home } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, forged)], ['/root/2.root.json', forged]]))
    const error = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain('root 2 does not follow root 1')
    await expect(readFile(join(home, 'trust', 'root.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('a type a later root removed', () => {
  it('c02-replayed-root-cannot-restore-type: stays removed when the channel replays the root that listed it', async () => {
    const fixture = await fixtureRelease()
    const ecdsa = await fixtureRelease({ keys: fixture.keys, ...ECDSA_LOGGED })
    const second = rootTwo(fixture)
    const secondMetadata = (JSON.parse(second.toString('utf8')) as { signed: RootMetadata }).signed
    const third = nextRoot(secondMetadata, fixture.keys, [fixture.keys.root], next => ({ ...next, logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256', ECDSA, 'revoked'), listed('PKIX_ED25519_PH', fixture.keys.targets)] }))
    const { channel, home, server } = await harness(fixture, new Map([['/timestamp.json', timestampFor(fixture, third, 3)], ['/root/2.root.json', second], ['/root/3.root.json', third]]))
    expect(String((await channel.resolve()).version)).toBe(VERSION)
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(third)
    // The ECDSA-logged release, offered under root 3, is refused: root 3 revoked the key.
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}.manifest.log.json`, ecdsa.bundleBytes)
    server.files.set('/timestamp.json', timestampFor(ecdsa, third, 4))
    server.files.set(`/releases/${VERSION}/delorun-${VERSION}.manifest.json`, ecdsa.manifestBytes)
    await refusal(channel.resolve(), 'RELEASE_LOG_FAILED')
    // Replayed under root 2, which listed the key, it is refused before any log check: the home trusts root 3.
    server.files.set('/timestamp.json', timestampFor(ecdsa, second, 5))
    const replayed = await refusal(channel.resolve(), 'INSTALL_VERIFY_FAILED')
    expect(replayed.detail).toContain('older than root 3, which this home trusts; a root never moves backwards')
    expect(await readFile(join(home, 'trust', 'root.json'))).toEqual(third)
  })
})

describe('a locally built 0.x release from the production channel', () => {
  /**
   * A production-source channel over a map of paths.
   * @param fixture - the release.
   * @param files - extra or replaced files, by path.
   * @param pinned - the root file the launcher pins as the preview root.
   * @returns the channel.
   */
  async function production(fixture: Fixture, files: ReadonlyMap<string, Buffer>, pinned: Buffer, shipped: readonly Uint8Array[] = fixture.roots): Promise<LauncherChannel> {
    const paths = releasePaths(fixture)
    for (const [path, bytes] of files) paths.set(path, bytes)
    const served: typeof globalThis.fetch = async (input) => {
      const bytes = paths.get(new URL(input instanceof Request ? input.url : String(input)).pathname)
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200 })
    }
    const home = await mkdtemp(join(tmpdir(), 'delorun-install-key-agility-'))
    homes.push(home)
    const source: ReleaseSource = { metadata: RELEASE_METADATA_ORIGIN, files: (version, name) => `${RELEASE_METADATA_ORIGIN}/releases/${version}/${name}` }
    return new LauncherChannel({
      home,
      platform: fixture.platform,
      roots: shipped,
      channel: 'stable',
      log: logService(fixture.checkpoint),
      source,
      previewRoots: [sha256(pinned)],
      downloader: new Downloader({ fetch: served, hosts: { scheme: 'https:', hosts: [new URL(RELEASE_METADATA_ORIGIN).hostname], maxRedirects: 0 } }),
      now: () => NOW * 1000,
    })
  }

  it('local-builder-pins-root-chain: installs under the pinned root 2 and under a root 3 that chains from it, and not under a root 2 that is another file', async () => {
    const fixture = await fixtureRelease({ builder: LOCAL_RELEASE_BUILDER, ...ECDSA_LOGGED, bareRoot: true })
    const second = rootTwo(fixture)
    const files = new Map([['/timestamp.json', timestampFor(fixture, second)], ['/root/2.root.json', second]])
    expect(String((await (await production(fixture, files, second)).resolve()).version)).toBe(VERSION)
    // A root 3 that root 2's keys sign, as a log-entry key revocation would be: a launcher shipping root 2 alone follows it.
    const secondMetadata = (JSON.parse(second.toString('utf8')) as { signed: RootMetadata }).signed
    const third = nextRoot(secondMetadata, fixture.keys, [fixture.keys.root], next => ({ ...next, logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256', ECDSA), listed('PKIX_ED25519_PH', fixture.keys.targets, 'revoked')] }))
    const later = new Map([['/timestamp.json', timestampFor(fixture, third)], ['/root/2.root.json', second], ['/root/3.root.json', third]])
    expect(String((await (await production(fixture, later, second, [second])).resolve()).version)).toBe(VERSION)
    // A root 2 that root 1 signs but that is not the pinned file: the chain never holds the pin.
    const other = rootTwo(fixture, [fixture.keys.root], [listed('PKIX_ECDSA_P256_SHA_256', ECDSA)])
    expect(sha256(other)).not.toBe(sha256(second))
    const forked = new Map([['/timestamp.json', timestampFor(fixture, other)], ['/root/2.root.json', other]])
    const error = await refusal((await production(fixture, forked, second)).resolve(), 'INSTALL_VERIFY_FAILED')
    expect(error.detail).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
  })
})
