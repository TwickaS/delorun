/**
 * A local release: one signed release in a directory laid out as a channel, from a closure the build wrote, a stand-in
 * log and throwaway keys. The channel verifies as a client verifies it, the same commit builds under two versions
 * with the timestamp moving to the second, and every refusal leaves the channel serving what it served before.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_REPOSITORY_URL, type RuntimePlatform } from '@delorun/contract-release-manifest'
import type { BuildRequest } from '../../src/build-closure.ts'
import type { ClosureFiles } from '../../src/closure/archive-closure.ts'
import { main, upstreamVersion } from '../../src/local-release.ts'
import { buildLocalRelease, copyClosureFiles, LOCAL_BUILDER, PRODUCTION_REFUSAL, releaseDirectory, type LocalReleaseRequest } from '../../src/local/release.ts'
import { PRODUCTION_KEYS_PATH, PRODUCTION_KEYS_SCHEMA, readProductionKeys, readProductionKeysFile, type ProductionKeys } from '../../src/local/production-keys.ts'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { verifySignedManifest, trustRootChain, verifyFileList, verifyPacks, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { readBundle, verifyBundle } from '@delorun/release-formats/log/bundle'
import { entryKeyId } from '@delorun/release-formats/log/entry-keys'
import { checkPacksBundle } from '@delorun/release-verify/bundle'
import { buildPackArchive } from '@delorun/release-formats/packs/archive'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { verifyChannel } from '../../scripts/cut-rc.ts'
import { REPO, scratch } from '../support.ts'
import { listedEntryKey, rootFile } from '../sign/fixture.ts'
import { fixtureClosure, keyFile, serveLog, trust, type Trust } from './support.ts'

const COMMIT = 'a'.repeat(40)

/** The registry the repository commits, which lists no production material yet. */
const COMMITTED_REGISTRY = readProductionKeysFile(join(REPO, PRODUCTION_KEYS_PATH))

/**
 * A production-keys registry file's bytes.
 * @param roots - the listed roots.
 * @param keyids - the listed key ids.
 * @returns the file.
 */
function registryFile(roots: ReadonlyArray<{ readonly version: number, readonly sha256: string }>, keyids: readonly string[]): Buffer {
  return Buffer.from(`${JSON.stringify({ schema: PRODUCTION_KEYS_SCHEMA, roots, keyids }, undefined, 2)}\n`)
}

/**
 * A registry that lists the given key ids as production keys.
 * @param keyids - the key ids.
 * @returns the registry.
 */
function listing(...keyids: string[]): ProductionKeys {
  return readProductionKeys(registryFile([], keyids))
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A request to build a version into a channel.
 * @param directory - a scratch directory holding the channel and the signer's state.
 * @param trusted - the keys and log.
 * @param version - the release version.
 * @param test - the running test.
 * @param change - fields to replace.
 * @returns the request.
 */
async function request(test: Parameters<typeof scratch>[0], directory: string, trusted: Trust, version: string, change: Partial<LocalReleaseRequest> = {}): Promise<LocalReleaseRequest> {
  const log = await serveLog(test, trusted)
  return {
    commit: COMMIT,
    version,
    dsh: '0.2.2-rc.1',
    security: false,
    summary: 'A local fixture release.',
    channel: join(directory, 'channel'),
    roots: [trusted.root],
    targetsKey: trusted.keys.targets,
    timestampKey: trusted.keys.timestamp,
    productionKeys: COMMITTED_REGISTRY,
    platforms: ['linux-x64'],
    state: join(directory, 'state.json'),
    log: log.endpoints,
    logAttempts: 1,
    logWait: () => Promise.resolve(),
    closures: fixtureClosure(test, version),
    // The fixture closure's `node/bin/node` names this process's Node, which may lie under the real user's home.
    builder: { home: '/home/no-such-builder', username: 'no-such-builder' },
    now: new Date(),
    ...change,
  }
}

describe('a local release', () => {
  it('refuses, before signing anything, a closure that names the building user\'s home directory, and signs it with a warning naming the file when told to allow that', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    // The fixture's `node/bin/node` wrapper names this process's Node, so its folder is a home directory the archive holds.
    const builder = { home: dirname(process.execPath), username: 'no-such-builder' }
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { builder }))).rejects.toThrow(/1 file of the release name the builder's own paths[^]*delorun-0\.1\.0-linux-x64\.tar\.gz!node\/bin\/node: the building user's home directory/u)
    expect(existsSync(join(directory, 'channel', 'timestamp.json'))).toBe(false)
    expect(existsSync(releaseDirectory(join(directory, 'channel'), '0.1.0'))).toBe(false)
    const warnings: string[] = []
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { builder, allowBuilderPaths: true, warn: line => warnings.push(line) }))).resolves.toMatchObject({ manifestName: 'delorun-0.1.0.manifest.json' })
    expect(warnings).toEqual([expect.stringMatching(/^warning: .*delorun-0\.1\.0-linux-x64\.tar\.gz!node\/bin\/node: the building user's home directory/u)])
  })

  it('writes a channel a client verifies: the signed manifest, its file list, its log bundle and the timestamp that names it', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const built = await buildLocalRelease(await request(test, directory, trusted, '0.1.0'))
    const channel = join(directory, 'channel')
    const files = readdirSync(releaseDirectory(channel, '0.1.0')).sort()
    expect(files).toEqual([
      'delorun-0.1.0-linux-x64.files.json',
      'delorun-0.1.0-linux-x64.tar.gz',
      'delorun-0.1.0.manifest.entry.json',
      'delorun-0.1.0.manifest.json',
      'delorun-0.1.0.manifest.log.json',
    ])
    expect(readdirSync(channel).sort()).toEqual(['releases', 'root', 'timestamp.json'])
    expect(statSync(releaseDirectory(channel, '0.1.0')).mode & 0o777).toBe(0o755)
    expect(readdirSync(join(channel, 'root'))).toEqual(['1.root.json'])
    const now = Math.floor(Date.now() / 1000)
    const root = trustRootChain([readFileSync(join(channel, 'root', '1.root.json'))], now).at(-1)!
    const timestamp = verifyTimestamp(root, readFileSync(join(channel, 'timestamp.json')), now)
    const manifestBytes = readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0.manifest.json'))
    const manifest = verifySignedManifest(root.metadata, manifestBytes)
    expect(timestamp.channels.stable).toMatchObject({ release: '0.1.0', manifest: { name: built.manifestName } })
    expect(timestamp.channels.beta.release).toBe('0.1.0')
    expect(manifest).toMatchObject({ version: '0.1.0', dsh: '0.2.2-rc.1', channel: 'stable', source: { repository: RELEASE_REPOSITORY_URL, tag: 'v0.1.0', commit: COMMIT }, rebuild: { builders: [{ name: LOCAL_BUILDER, ci: false }] }, security: false, summary: 'A local fixture release.' })
    const list = verifyFileList(root.metadata, manifest, 'linux-x64', readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0-linux-x64.files.json')))
    expect(list.files.map(file => file.path)).toEqual(['app/node_modules/@delorun/cli/package.json', 'app/node_modules/@delorun/cli/src/bin.js', 'node/bin/node'])
    const archive = readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0-linux-x64.tar.gz'))
    expect(manifest.runtime['linux-x64']?.archive).toEqual({ name: 'delorun-0.1.0-linux-x64.tar.gz', length: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex') })
    const bundle = readBundle(readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0.manifest.log.json')))
    expect(verifyBundle(root.metadata, manifestBytes, '0.1.0', bundle).treeSize).toBe(1)
    expect(built.timestampVersion).toBe(1)
  })

  it('lists only its own platform, and names the other files it does not build as zero-length placeholders', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0'))
    const manifest = readEnvelope('manifest', readFileSync(join(releaseDirectory(join(directory, 'channel'), '0.1.0'), 'delorun-0.1.0.manifest.json'))).signed
    expect(Object.keys(manifest.runtime)).toEqual(['linux-x64'])
    expect(manifest.runtime['linux-x64']?.archive.length).toBeGreaterThan(0)
    expect(manifest.sbom.length).toBe(0)
    expect(manifest.npm).toEqual([])
  })

  it('signs each platform it is given, and its manifest lists exactly those', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const platforms: RuntimePlatform[] = ['linux-x64', 'linux-arm64', 'win32-x64']
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0', { platforms, closures: fixtureClosure(test, '0.1.0', { platforms }) }))
    const release = releaseDirectory(join(directory, 'channel'), '0.1.0')
    const now = Math.floor(Date.now() / 1000)
    const root = trustRootChain([trusted.root], now).at(-1)!
    const manifest = verifySignedManifest(root.metadata, readFileSync(join(release, 'delorun-0.1.0.manifest.json')))
    expect(Object.keys(manifest.runtime).sort()).toEqual([...platforms].sort())
    for (const platform of platforms) {
      expect(verifyFileList(root.metadata, manifest, platform, readFileSync(join(release, `delorun-0.1.0-${platform}.files.json`))).platform).toBe(platform)
    }
    expect(manifest.runtime['win32-x64']?.archive.name).toBe('delorun-0.1.0-win32-x64.zip')
  })

  it('refuses an empty or repeated platform list, before building anything', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    let built = false
    const closures = (): Promise<void> => { built = true; return Promise.resolve() }
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { platforms: [], closures }))).rejects.toThrow('a local release names each of its platforms once, not []')
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { platforms: ['linux-x64', 'linux-x64'], closures }))).rejects.toThrow('names each of its platforms once')
    expect(built).toBe(false)
  })

  it('refuses a platform whose files the closure build did not write', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { platforms: ['linux-x64', 'linux-arm64'] }))).rejects.toThrow('delorun-0.1.0-linux-arm64.files.json')
    expect(existsSync(join(directory, 'channel', 'timestamp.json'))).toBe(false)
  })

  it('builds the same commit under two versions, and the timestamp moves to the second while the first stays served', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0'))
    const second = await buildLocalRelease(await request(test, directory, trusted, '0.2.0'))
    const channel = join(directory, 'channel')
    expect(second.timestampVersion).toBe(2)
    expect(readdirSync(join(channel, 'releases', 'download')).sort()).toEqual(['v0.1.0', 'v0.2.0'])
    const now = Math.floor(Date.now() / 1000)
    const root = trustRootChain([trusted.root], now).at(-1)!
    expect(verifyTimestamp(root, readFileSync(join(channel, 'timestamp.json')), now).channels.stable.release).toBe('0.2.0')
    const manifest = readEnvelope('manifest', readFileSync(join(releaseDirectory(channel, '0.2.0'), 'delorun-0.2.0.manifest.json'))).signed
    expect(manifest.source.commit).toBe(COMMIT)
    const stamped = readFileSync(join(releaseDirectory(channel, '0.2.0'), 'delorun-0.2.0-linux-x64.files.json'), 'utf8')
    expect(stamped).not.toBe(readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0-linux-x64.files.json'), 'utf8'))
  })

  it('never replaces a version already in the channel', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0'))
    const before = readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8')
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0'))).rejects.toThrow('a local release never replaces a version already in the channel')
    expect(readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8')).toBe(before)
  })

  it('refuses a version below the one the channel serves, and leaves the channel as it was', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await buildLocalRelease(await request(test, directory, trusted, '0.2.0'))
    const before = readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8')
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0'))).rejects.toThrow('would move back from 0.2.0 to 0.1.0')
    expect(readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8')).toBe(before)
    expect(existsSync(releaseDirectory(join(directory, 'channel'), '0.1.0'))).toBe(false)
    expect(readdirSync(join(directory, 'channel', 'releases', 'download'))).toEqual(['v0.2.0'])
  })

  it('refuses a targets key the root does not list as active, before building anything', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const other = trust()
    let built = false
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { targetsKey: other.keys.targets, closures: () => { built = true; return Promise.resolve() } })))
      .rejects.toThrow('is not the active targets key of root 1')
    expect(built).toBe(false)
  })

  it('signs release notes into the manifest as a file reference the client checks, and writes the notes beside the other files', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const notes = Buffer.from('Delorun 0.1.0\n\nStudio\n- A change.\n')
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0', { notes }))
    const channel = join(directory, 'channel')
    const root = trustRootChain([readFileSync(join(channel, 'root', '1.root.json'))], Math.floor(Date.now() / 1000)).at(-1)!
    const manifest = verifySignedManifest(root.metadata, readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0.manifest.json')))
    expect(manifest.notes).toEqual({ name: 'delorun-0.1.0.notes.txt', length: notes.byteLength, sha256: createHash('sha256').update(notes).digest('hex') })
    expect(readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0.notes.txt'))).toEqual(notes)
  })

  it('refuses notes a client would refuse, before building anything', async (test) => {
    for (const notes of [Buffer.from('Right-to-left \u202Eoverride'), Buffer.alloc(0), Buffer.alloc(65_537, 'a')]) {
      const directory = scratch(test)
      let built = false
      await expect(buildLocalRelease(await request(test, directory, trust(), '0.1.0', { notes, closures: () => { built = true; return Promise.resolve() } })))
        .rejects.toThrow('the release notes are not valid')
      expect(built).toBe(false)
      expect(existsSync(join(directory, 'channel'))).toBe(false)
    }
  })

  it('refuses a summary that is not one plain line, before building anything', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    let built = false
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { summary: 'Two\nlines', closures: () => { built = true; return Promise.resolve() } })))
      .rejects.toThrow('the summary "Two\\nlines" is not a release summary: 1 to 200 characters on one line')
    expect(built).toBe(false)
    expect(existsSync(join(directory, 'channel'))).toBe(false)
  })

  it('local-release-refuses-production-root: refuses a root file whose SHA-256 the production-keys registry lists, before building or writing anything', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    let built = false
    const digest = createHash('sha256').update(trusted.root).digest('hex')
    const productionKeys = readProductionKeys(registryFile([{ version: 1, sha256: digest }], []))
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { productionKeys, closures: () => { built = true; return Promise.resolve() } })))
      .rejects.toThrow(`${PRODUCTION_REFUSAL}: root file 1 is a production root (SHA-256 ${digest})`)
    expect(built).toBe(false)
    expect(existsSync(join(directory, 'channel'))).toBe(false)
    expect(existsSync(join(directory, 'state.json'))).toBe(false)
  })

  it('local-release-refuses-production-keys: refuses a targets or timestamp key, and a root listing a key in any role, that the registry lists', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    let built = false
    const closures = (): Promise<void> => { built = true; return Promise.resolve() }
    const id = (key: Parameters<typeof publicKeyEntry>[0]): string => publicKeyEntry(key).keyid
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { productionKeys: listing(id(trusted.keys.targets)), closures })))
      .rejects.toThrow(`${PRODUCTION_REFUSAL}: the targets key ${id(trusted.keys.targets)} is a production key`)
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { productionKeys: listing(id(trusted.keys.timestamp)), closures })))
      .rejects.toThrow(`${PRODUCTION_REFUSAL}: the timestamp key ${id(trusted.keys.timestamp)} is a production key`)
    for (const role of ['root', 'catalogue'] as const) {
      await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { productionKeys: listing(id(trusted.keys[role])), closures })))
        .rejects.toThrow(`${PRODUCTION_REFUSAL}: root 1 lists the production key ${id(trusted.keys[role])} in roles.${role}`)
    }
    expect(built).toBe(false)
    expect(existsSync(join(directory, 'channel'))).toBe(false)
  })

  it('local-release-refuses-production-log-entry-key: refuses an ECDSA log-entry key the registry lists, and a root listing it in logEntryKeys', async (test) => {
    const directory = scratch(test)
    let built = false
    const closures = (): Promise<void> => { built = true; return Promise.resolve() }
    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const keyid = entryKeyId(ecdsa)
    const trusted = trust()
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { productionKeys: listing(keyid), logEntryKeys: [{ keyDetails: 'PKIX_ECDSA_P256_SHA_256', key: ecdsa }], closures })))
      .rejects.toThrow(`${PRODUCTION_REFUSAL}: the PKIX_ECDSA_P256_SHA_256 log-entry key ${keyid} is a production key`)
    const listingRoot = rootFile(trusted.keys, { log: { origin: trusted.log.origin, vkey: trusted.log.vkey }, witnesses: { keys: [{ name: trusted.witness.name, vkey: trusted.witness.vkey }], threshold: 1 }, logEntryKeys: [listedEntryKey('PKIX_ECDSA_P256_SHA_256', ecdsa), listedEntryKey('PKIX_ED25519_PH', trusted.keys.targets)] })
    await expect(buildLocalRelease(await request(test, directory, { ...trusted, root: listingRoot.bytes }, '0.1.0', { productionKeys: listing(keyid), closures })))
      .rejects.toThrow(`${PRODUCTION_REFUSAL}: root 1 lists the production key ${keyid} in logEntryKeys[0]`)
    expect(built).toBe(false)
    expect(existsSync(join(directory, 'channel'))).toBe(false)
  })

  it('refuses a closure build that wrote the file list of another version', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { closures: async (target) => {
      await fixtureClosure(test, '0.3.0')(target)
      const { renameSync } = await import('node:fs')
      renameSync(join(target, 'delorun-0.3.0-linux-x64.files.json'), join(target, 'delorun-0.1.0-linux-x64.files.json'))
      renameSync(join(target, 'delorun-0.3.0-linux-x64.tar.gz'), join(target, 'delorun-0.1.0-linux-x64.tar.gz'))
    } }))).rejects.toThrow('is the file list of 0.3.0 linux-x64, not of 0.1.0 linux-x64')
    expect(existsSync(join(directory, 'channel', 'timestamp.json'))).toBe(false)
  })

  it('leaves no building directory behind when the log gives no witnessed checkpoint', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const stranger = trust()
    const log = await serveLog(test, { ...trusted, witness: stranger.witness })
    await expect(buildLocalRelease(await request(test, directory, trusted, '0.1.0', { log: log.endpoints }))).rejects.toThrow('after 1 attempts; the release is not published')
    expect(readdirSync(join(directory, 'channel', 'releases', 'download'))).toEqual([])
    expect(existsSync(join(directory, 'channel', 'timestamp.json'))).toBe(false)
  })
})

describe('the production-keys registry', () => {
  it('reads the committed registry, which lists no production root or key yet', () => {
    expect(COMMITTED_REGISTRY.rootDigests.size).toBe(0)
    expect(COMMITTED_REGISTRY.keyids.size).toBe(0)
  })

  it('reads the listed root digests and key ids', () => {
    const registry = readProductionKeys(registryFile([{ version: 1, sha256: 'a'.repeat(64) }, { version: 2, sha256: 'b'.repeat(64) }], ['c'.repeat(64)]))
    expect([...registry.rootDigests]).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect([...registry.keyids]).toEqual(['c'.repeat(64)])
  })

  it('refuses a registry with another schema, an unknown field, a malformed value, a repeated entry or a repeated JSON key', () => {
    const root = { version: 1, sha256: 'a'.repeat(64) }
    expect(() => readProductionKeys(Buffer.from(JSON.stringify({ schema: 'delorun.production-keys/2', roots: [], keyids: [] })))).toThrow('the production-keys registry does not read')
    expect(() => readProductionKeys(Buffer.from(JSON.stringify({ schema: PRODUCTION_KEYS_SCHEMA, roots: [], keyids: [], note: 'x' })))).toThrow('the production-keys registry does not read')
    expect(() => readProductionKeys(Buffer.from(JSON.stringify({ schema: PRODUCTION_KEYS_SCHEMA, roots: [{ ...root, expires: 'never' }], keyids: [] })))).toThrow('the production-keys registry does not read')
    expect(() => readProductionKeys(registryFile([], ['A'.repeat(64)]))).toThrow('the production-keys registry does not read')
    expect(() => readProductionKeys(registryFile([{ version: 0, sha256: 'a'.repeat(64) }], []))).toThrow('the production-keys registry does not read')
    expect(() => readProductionKeys(registryFile([], ['c'.repeat(64), 'c'.repeat(64)]))).toThrow(`lists the key id ${'c'.repeat(64)} twice`)
    expect(() => readProductionKeys(registryFile([root, { version: 2, sha256: root.sha256 }], []))).toThrow(`lists the root digest ${root.sha256} twice`)
    expect(() => readProductionKeys(registryFile([root, { version: 1, sha256: 'b'.repeat(64) }], []))).toThrow('lists the root version 1 twice')
    expect(() => readProductionKeys(Buffer.from(`{"schema":"${PRODUCTION_KEYS_SCHEMA}","roots":[],"keyids":[],"keyids":[]}`))).toThrow()
    expect(() => readProductionKeys(Buffer.alloc(64 * 1024 + 1, 0x20))).toThrow('above its limit')
  })
})

describe('copying a closure build’s files', () => {
  it('copies the Linux x64 archive and file list into the directory it is given', async (test) => {
    const source = scratch(test)
    await fixtureClosure(test, '0.1.0')(source)
    const target = scratch(test)
    await copyClosureFiles(source, '0.1.0', ['linux-x64'], target)
    expect(readdirSync(target).sort()).toEqual(['delorun-0.1.0-linux-x64.files.json', 'delorun-0.1.0-linux-x64.tar.gz'])
  })

  it('names the build command when a file is missing', async (test) => {
    const source = scratch(test)
    mkdirSync(join(source, 'empty'))
    await expect(copyClosureFiles(source, '0.1.0', ['linux-x64'], scratch(test))).rejects.toThrow('build it with build-closure.ts --version 0.1.0 --platform linux-x64')
    await fixtureClosure(test, '0.1.0')(source)
    await expect(copyClosureFiles(source, '0.1.0', ['linux-x64', 'win32-x64'], scratch(test))).rejects.toThrow('delorun-0.1.0-win32-x64.zip does not exist; build it with build-closure.ts --version 0.1.0 --platform win32-x64')
  })
})

describe('the local-release command', () => {
  /**
   * The command line for a release built into a scratch directory.
   * @param test - the running test.
   * @param version - the release version.
   * @param extra - arguments to add.
   * @returns the directory and the arguments.
   */
  async function command(test: Parameters<typeof scratch>[0], version: string, extra: readonly string[]): Promise<{ readonly directory: string, readonly args: readonly string[] }> {
    const directory = scratch(test)
    const trusted = trust()
    const log = await serveLog(test, trusted)
    writeKey(directory, trusted)
    const args = ['--version', version, '--summary', 'A local fixture release.', '--out', join(directory, 'channel'), '--root', join(directory, 'root.json'), '--targets-key', join(directory, 'targets.pem'), '--timestamp-key', join(directory, 'timestamp.pem'), '--state', join(directory, 'state.json'), '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, '--allow-builder-paths', ...extra]
    return { directory, args }
  }

  it('builds a release from a commit with the closure files it is given', async (test) => {
    const closures = scratch(test)
    await fixtureClosure(test, '0.1.0')(closures)
    const { directory, args } = await command(test, '0.1.0', ['--closures-from', closures])
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await main(args)).toBe(0)
    expect(out).toHaveBeenCalledWith(expect.stringContaining('local-release: signed delorun-0.1.0.manifest.json for linux-x64'))
    const manifest = readEnvelope('manifest', readFileSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0', 'delorun-0.1.0.manifest.json'))).signed
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(manifest.dsh).toMatch(/^\d+\.\d+\.\d+/u)
    expect(manifest).toMatchObject({ security: false, summary: 'A local fixture release.' })
  })

  it('signs the release platforms --platform names, and refuses a platform the release does not carry', async (test) => {
    const platforms: RuntimePlatform[] = ['linux-x64', 'linux-arm64']
    const closures = scratch(test)
    await fixtureClosure(test, '0.1.0', { platforms })(closures)
    const { directory, args } = await command(test, '0.1.0', ['--closures-from', closures, '--platform', 'linux-x64', '--platform', 'linux-arm64'])
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await main(args)).toBe(0)
    expect(out).toHaveBeenCalledWith(expect.stringContaining('for linux-x64, linux-arm64 in'))
    const manifest = readEnvelope('manifest', readFileSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0', 'delorun-0.1.0.manifest.json'))).signed
    expect(Object.keys(manifest.runtime).sort()).toEqual([...platforms].sort())
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const darwin = await command(test, '0.1.0', ['--closures-from', closures, '--platform', 'darwin-arm64'])
    expect(await main(darwin.args)).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('local-release: --platform darwin-arm64 is not a release platform; closure.json lists linux-x64, linux-arm64')
    expect(await main([...darwin.args.slice(0, -1), 'plan9'])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('--platform plan9 is not a release platform'))
  })

  it('marks the release as a security fix with --security', async (test) => {
    const closures = scratch(test)
    await fixtureClosure(test, '0.1.0')(closures)
    const { directory, args } = await command(test, '0.1.0', ['--closures-from', closures, '--security'])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await main(args)).toBe(0)
    const manifest = readEnvelope('manifest', readFileSync(join(directory, 'channel', 'releases', 'download', 'v0.1.0', 'delorun-0.1.0.manifest.json'))).signed
    expect(manifest).toMatchObject({ security: true, summary: 'A local fixture release.' })
  })

  it('builds the Linux x64 closure of the commit when it is given no closure files, and keeps only the two release files', async (test) => {
    const { directory, args } = await command(test, '0.3.0', [])
    const asked: BuildRequest[] = []
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const build = async (_repository: string, request: BuildRequest): Promise<Map<RuntimePlatform, ClosureFiles>> => {
      asked.push(request)
      await fixtureClosure(test, request.version)(request.out)
      return new Map()
    }
    expect(await main(args, build)).toBe(0)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ version: '0.3.0', platforms: ['linux-x64'], writePins: false })
    expect(asked[0]!.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(readdirSync(join(directory, 'channel', 'releases', 'download', 'v0.3.0')).sort()).toEqual([
      'delorun-0.3.0-linux-x64.files.json',
      'delorun-0.3.0-linux-x64.tar.gz',
      'delorun-0.3.0.manifest.entry.json',
      'delorun-0.3.0.manifest.json',
      'delorun-0.3.0.manifest.log.json',
    ])
  })

  it('waits the poll interval it is given between asks for a witnessed checkpoint', async (test) => {
    const closures = scratch(test)
    await fixtureClosure(test, '0.1.0')(closures)
    const directory = scratch(test)
    const trusted = trust()
    const log = await serveLog(test, trusted, { uncosignedPolls: 2 })
    writeKey(directory, trusted)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const args = ['--version', '0.1.0', '--summary', 'A local fixture release.', '--out', join(directory, 'channel'), '--root', join(directory, 'root.json'), '--targets-key', join(directory, 'targets.pem'), '--timestamp-key', join(directory, 'timestamp.pem'), '--state', join(directory, 'state.json'), '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, '--closures-from', closures, '--allow-builder-paths']
    expect(await main([...args, '--log-poll-seconds', '0'])).toBe(0)
  })

  it('passes the artifact source to the closure build, and refuses one it does not know', async (test) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { args } = await command(test, '0.4.0', ['--artifacts', 'existing'])
    const asked: BuildRequest[] = []
    expect(await main(args, async (_repository, request) => {
      asked.push(request)
      await fixtureClosure(test, request.version)(request.out)
      return new Map()
    })).toBe(0)
    expect(asked[0]!.artifacts).toBe('existing')
    const wrong = await command(test, '0.4.0', ['--artifacts', 'cached'])
    expect(await main(wrong.args)).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('local-release: --artifacts is build or existing, not cached')
  })

  it('refuses a poll interval that is not a number of seconds', async (test) => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { args } = await command(test, '0.1.0', ['--closures-from', scratch(test), '--log-poll-seconds', 'soon'])
    expect(await main(args)).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('local-release: --log-poll-seconds soon is not a number of seconds')
    expect(await main([...args.slice(0, -2), '--log-poll-seconds=-1'])).toBe(1)
  })

  it('refuses a root that the production-keys registry it is given lists, and reads the committed registry by default', async (test) => {
    const closures = scratch(test)
    await fixtureClosure(test, '0.1.0')(closures)
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { directory, args } = await command(test, '0.1.0', ['--closures-from', closures])
    const digest = createHash('sha256').update(readFileSync(join(directory, 'root.json'))).digest('hex')
    writeFileSync(join(directory, 'production-keys.json'), registryFile([{ version: 1, sha256: digest }], []))
    expect(await main([...args, '--production-keys', join(directory, 'production-keys.json')])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(`local-release: ${PRODUCTION_REFUSAL}: root file 1 is a production root (SHA-256 ${digest})`)
    expect(existsSync(join(directory, 'channel'))).toBe(false)
    writeFileSync(join(directory, 'production-keys.json'), '{"schema":"delorun.production-keys/1"}')
    expect(await main([...args, '--production-keys', join(directory, 'production-keys.json')])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('local-release: the production-keys registry does not read'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await main(args)).toBe(0)
  })

  it('refuses a call that names too little, a version that is not one, and a failed build, with exit status 1', async (test) => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await main(['--version', '0.1.0'])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('local-release: pass --version, --summary, --out, --root'))
    const { args } = await command(test, 'not-a-version', ['--closures-from', scratch(test)])
    expect(await main(args)).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('local-release:'))
    const named = await command(test, '0.1.0', [])
    expect(await main(named.args, () => Promise.reject(new Error('pnpm exited with 1')))).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('local-release: pnpm exited with 1')
    const plain = await command(test, '0.1.0', [])
    expect(await main(plain.args, () => Promise.reject('plain text'))).toBe(1)
    expect(failure).toHaveBeenLastCalledWith('local-release: plain text')
    expect(existsSync(join(named.directory, 'channel', 'timestamp.json'))).toBe(false)
  })

  it('reads the upstream release a commit is based on from its ledger, and refuses a ledger that names no dsh tag', (test) => {
    const repository = scratch(test)
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, timeout: 30_000 }).trim()
    git('init', '-q', '-b', 'main')
    mkdirSync(join(repository, 'delorun'))
    writeFileSync(join(repository, 'delorun', 'upstream-patches.json'), JSON.stringify({ upstream: { ref: 'dsh-v0.2.2-rc.1' } }))
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    expect(upstreamVersion(repository, git('rev-parse', 'HEAD'))).toBe('0.2.2-rc.1')
    writeFileSync(join(repository, 'delorun', 'upstream-patches.json'), JSON.stringify({ upstream: { ref: 'main' } }))
    git('commit', '-q', '-am', 'two')
    expect(() => upstreamVersion(repository, 'HEAD')).toThrow('names upstream ref "main", which is not a dsh-v<version> tag')
    writeFileSync(join(repository, 'delorun', 'upstream-patches.json'), JSON.stringify({}))
    git('commit', '-q', '-am', 'three')
    expect(() => upstreamVersion(repository, 'HEAD')).toThrow('names upstream ref "", which is not')
  })
})

/**
 * Write the root and the two key files the command line names.
 * @param directory - where to write them.
 * @param trusted - the keys.
 */
function writeKey(directory: string, trusted: Trust): void {
  keyFile(directory, 'targets.pem', trusted.keys.targets)
  keyFile(directory, 'timestamp.pem', trusted.keys.timestamp)
  writeFileSync(join(directory, 'root.json'), trusted.root)
}

describe('a local release with plugin packs', () => {
  /**
   * A closure build directory as `build-closure.ts` leaves it: the runtime files, and the unsigned packs file with its one archive.
   * @param test - the running test.
   * @param version - the release version.
   * @param archive - whether the pack archive the packs file names is written.
   * @returns the directory.
   */
  async function closureWithPacks(test: Parameters<typeof scratch>[0], version: string, archive = true): Promise<string> {
    const source = scratch(test)
    await fixtureClosure(test, version)(source)
    const name = `delorun-${version}-pack-demo.any.tar.gz`
    const built = await buildPackArchive(name, [{ path: 'package.json', mode: '0644', data: Buffer.from('{}') }], 1_800_000_000)
    const draft = { schema: 'delorun.release-packs/1', version, manifest: '0'.repeat(64), packs: [{ name: 'demo', version: '1.0.0', experimental: false, variants: { any: { ...built.variant, external: [], peers: [] } } }] }
    writeFileSync(join(source, `delorun-${version}.packs.json`), `${JSON.stringify({ signed: draft, signatures: [] }, undefined, 2)}\n`)
    if (archive) writeFileSync(join(source, name), built.bytes)
    return source
  }

  it('publishes the signed packs file, its archive, its log entry request and its log bundle, and the channel verifies them', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const source = await closureWithPacks(test, '0.1.0')
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0', { closures: target => copyClosureFiles(source, '0.1.0', ['linux-x64'], target) }))
    const channel = join(directory, 'channel')
    const release = releaseDirectory(channel, '0.1.0')
    expect(readdirSync(release).sort()).toEqual([
      'delorun-0.1.0-linux-x64.files.json',
      'delorun-0.1.0-linux-x64.tar.gz',
      'delorun-0.1.0-pack-demo.any.tar.gz',
      'delorun-0.1.0.manifest.entry.json',
      'delorun-0.1.0.manifest.json',
      'delorun-0.1.0.manifest.log.json',
      'delorun-0.1.0.packs.entry.json',
      'delorun-0.1.0.packs.json',
      'delorun-0.1.0.packs.log.json',
    ])
    const root = trustRootChain([trusted.root], Math.floor(Date.now() / 1000)).at(-1)!
    const manifestBytes = readFileSync(join(release, 'delorun-0.1.0.manifest.json'))
    const packsBytes = readFileSync(join(release, 'delorun-0.1.0.packs.json'))
    expect(verifyPacks(root.metadata, manifestBytes, packsBytes).packs.map(pack => pack.name)).toEqual(['demo'])
    const bundle = readBundle(readFileSync(join(release, 'delorun-0.1.0.packs.log.json')))
    expect(bundle.manifest.name).toBe('delorun-0.1.0.packs.json')
    expect(verifyBundle(root.metadata, packsBytes, '0.1.0', bundle, 'packs').treeSize).toBe(2)
    // The client's own check, which the launcher runs on the stored packs file and bundle, accepts what was published.
    expect(checkPacksBundle(root.metadata, '0.1.0', packsBytes, readFileSync(join(release, 'delorun-0.1.0.packs.log.json')))).toMatchObject({ ok: true })
    expect(verifyChannel(channel, '0.1.0', Math.floor(Date.now() / 1000)).packs).toBe(1)
  })

  it('does not accept the packs bundle as the manifest\'s, nor the manifest\'s as the packs file\'s', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const source = await closureWithPacks(test, '0.1.0')
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0', { closures: target => copyClosureFiles(source, '0.1.0', ['linux-x64'], target) }))
    const release = releaseDirectory(join(directory, 'channel'), '0.1.0')
    const root = trustRootChain([trusted.root], Math.floor(Date.now() / 1000)).at(-1)!
    const manifestBytes = readFileSync(join(release, 'delorun-0.1.0.manifest.json'))
    const packsBytes = readFileSync(join(release, 'delorun-0.1.0.packs.json'))
    expect(() => verifyBundle(root.metadata, manifestBytes, '0.1.0', readBundle(readFileSync(join(release, 'delorun-0.1.0.packs.log.json'))))).toThrow(/manifest file/u)
    expect(() => verifyBundle(root.metadata, packsBytes, '0.1.0', readBundle(readFileSync(join(release, 'delorun-0.1.0.manifest.log.json'))), 'packs')).toThrow(/packs file/u)
  })

  it('refuses to copy a packs file whose archive is missing, and copies nothing about packs when there is no packs file', async (test) => {
    const without = await closureWithPacks(test, '0.1.0', false)
    await expect(copyClosureFiles(without, '0.1.0', ['linux-x64'], scratch(test))).rejects.toThrow('delorun-0.1.0-pack-demo.any.tar.gz, which does not exist')
    const plain = scratch(test)
    await fixtureClosure(test, '0.1.0')(plain)
    const target = scratch(test)
    await copyClosureFiles(plain, '0.1.0', ['linux-x64'], target)
    expect(readdirSync(target).filter(name => name.includes('packs') || name.includes('-pack-'))).toEqual([])
  })

  it('fails the channel check when the packs bundle is missing or a pack archive changed', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    const source = await closureWithPacks(test, '0.1.0')
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0', { closures: target => copyClosureFiles(source, '0.1.0', ['linux-x64'], target) }))
    const channel = join(directory, 'channel')
    const release = releaseDirectory(channel, '0.1.0')
    const now = Math.floor(Date.now() / 1000)
    const archive = join(release, 'delorun-0.1.0-pack-demo.any.tar.gz')
    const original = readFileSync(archive)
    writeFileSync(archive, Buffer.concat([original, Buffer.from('x')]))
    expect(() => verifyChannel(channel, '0.1.0', now)).toThrow('does not match the signed packs file')
    writeFileSync(archive, original)
    const bundlePath = join(release, 'delorun-0.1.0.packs.log.json')
    const bundle = readFileSync(bundlePath)
    rmSync(bundlePath)
    expect(() => verifyChannel(channel, '0.1.0', now)).toThrow('has no delorun-0.1.0.packs.log.json')
    writeFileSync(bundlePath, bundle)
    expect(verifyChannel(channel, '0.1.0', now).packs).toBe(1)
  })

  it('stays as it was for a closure with no packs file: no packs file, no packs bundle', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await buildLocalRelease(await request(test, directory, trusted, '0.1.0'))
    const channel = join(directory, 'channel')
    expect(readdirSync(releaseDirectory(channel, '0.1.0')).filter(name => name.includes('packs'))).toEqual([])
    expect(verifyChannel(channel, '0.1.0', Math.floor(Date.now() / 1000)).packs).toBe(0)
  })
})
