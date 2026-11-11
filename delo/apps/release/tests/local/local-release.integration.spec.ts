/**
 * A local release: one signed release in a directory laid out as a channel, from a closure the build wrote, a stand-in
 * log and throwaway keys. The channel verifies as a client verifies it, the same commit builds under two versions
 * with the timestamp moving to the second, and every refusal leaves the channel serving what it served before.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_REPOSITORY_URL, type RuntimePlatform } from '@delo/contract-release-manifest'
import type { BuildRequest } from '../../src/build-closure.ts'
import type { ClosureFiles } from '../../src/closure/archive-closure.ts'
import { main, upstreamVersion } from '../../src/local-release.ts'
import { buildLocalRelease, copyClosureFiles, LOCAL_BUILDER, releaseDirectory, type LocalReleaseRequest } from '../../src/local/release.ts'
import { verifySignedManifest, trustRootChain, verifyFileList, verifyTimestamp } from '@delo/release-formats/sign/verify'
import { readBundle, verifyBundle } from '@delo/release-formats/log/bundle'
import { readEnvelope } from '@delo/release-formats/sign/schemas'
import { scratch } from '../support.ts'
import { fixtureClosure, keyFile, serveLog, trust, type Trust } from './support.ts'

const COMMIT = 'a'.repeat(40)

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
    channel: join(directory, 'channel'),
    roots: [trusted.root],
    targetsKey: trusted.keys.targets,
    timestampKey: trusted.keys.timestamp,
    state: join(directory, 'state.json'),
    log: log.endpoints,
    logAttempts: 1,
    logWait: () => Promise.resolve(),
    closures: fixtureClosure(test, version),
    now: new Date(),
    ...change,
  }
}

describe('a local release', () => {
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
    expect(readdirSync(join(channel, 'root'))).toEqual(['1.root.json'])
    const now = Math.floor(Date.now() / 1000)
    const root = trustRootChain([readFileSync(join(channel, 'root', '1.root.json'))], now).at(-1)!
    const timestamp = verifyTimestamp(root, readFileSync(join(channel, 'timestamp.json')), now)
    const manifestBytes = readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0.manifest.json'))
    const manifest = verifySignedManifest(root.metadata, manifestBytes)
    expect(timestamp.channels.stable).toMatchObject({ release: '0.1.0', manifest: { name: built.manifestName } })
    expect(timestamp.channels.beta.release).toBe('0.1.0')
    expect(manifest).toMatchObject({ version: '0.1.0', dsh: '0.2.2-rc.1', channel: 'stable', source: { repository: RELEASE_REPOSITORY_URL, tag: 'v0.1.0', commit: COMMIT }, rebuild: { builders: [{ name: LOCAL_BUILDER, ci: false }] } })
    const list = verifyFileList(root.metadata, manifest, 'linux-x64', readFileSync(join(releaseDirectory(channel, '0.1.0'), 'delorun-0.1.0-linux-x64.files.json')))
    expect(list.files.map(file => file.path)).toEqual(['app/node_modules/@delo/cli/package.json', 'app/node_modules/@delo/cli/src/bin.js', 'node/bin/node'])
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

describe('copying a closure build’s files', () => {
  it('copies the Linux x64 archive and file list into the directory it is given', async (test) => {
    const source = scratch(test)
    await fixtureClosure(test, '0.1.0')(source)
    const target = scratch(test)
    await copyClosureFiles(source, '0.1.0', target)
    expect(readdirSync(target).sort()).toEqual(['delorun-0.1.0-linux-x64.files.json', 'delorun-0.1.0-linux-x64.tar.gz'])
  })

  it('names the build command when a file is missing', async (test) => {
    const source = scratch(test)
    mkdirSync(join(source, 'empty'))
    await expect(copyClosureFiles(source, '0.1.0', scratch(test))).rejects.toThrow('build it with build-closure.ts --version 0.1.0 --platform linux-x64')
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
    const args = ['--version', version, '--out', join(directory, 'channel'), '--root', join(directory, 'root.json'), '--targets-key', join(directory, 'targets.pem'), '--timestamp-key', join(directory, 'timestamp.pem'), '--state', join(directory, 'state.json'), '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, ...extra]
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
    const args = ['--version', '0.1.0', '--out', join(directory, 'channel'), '--root', join(directory, 'root.json'), '--targets-key', join(directory, 'targets.pem'), '--timestamp-key', join(directory, 'timestamp.pem'), '--state', join(directory, 'state.json'), '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles, '--closures-from', closures]
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

  it('refuses a call that names too little, a version that is not one, and a failed build, with exit status 1', async (test) => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await main(['--version', '0.1.0'])).toBe(1)
    expect(failure).toHaveBeenLastCalledWith(expect.stringContaining('local-release: pass --version, --out, --root'))
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
    mkdirSync(join(repository, 'delo'))
    writeFileSync(join(repository, 'delo', 'upstream-patches.json'), JSON.stringify({ upstream: { ref: 'dsh-v0.2.2-rc.1' } }))
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    expect(upstreamVersion(repository, git('rev-parse', 'HEAD'))).toBe('0.2.2-rc.1')
    writeFileSync(join(repository, 'delo', 'upstream-patches.json'), JSON.stringify({ upstream: { ref: 'main' } }))
    git('commit', '-q', '-am', 'two')
    expect(() => upstreamVersion(repository, 'HEAD')).toThrow('names upstream ref "main", which is not a dsh-v<version> tag')
    writeFileSync(join(repository, 'delo', 'upstream-patches.json'), JSON.stringify({}))
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
