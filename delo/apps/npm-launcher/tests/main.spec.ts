/**
 * The launcher's main function with a real runtime store and channel against a stand-in release server: a first run
 * installs and prints each step, an unreachable log warns and records, a later run starts without the network, and
 * every refusal before the install writes nothing. The release is the install path's own fixture.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchCommand } from '@delo/runtime-store'
import { main, stderrLogger, type LauncherContext } from '../src/bin.ts'
import { platformOf } from '../src/platform.ts'
import { fixtureRelease, NOW, releasePaths, standIn, VERSION, type Fixture, type StandIn } from '../../install/tests/support.ts'

let directories: string[] = []
let servers: StandIn[] = []

beforeEach(() => {
  // The fixture release is signed for January 2027, so the clock reads its day; timers keep running.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW * 1000 })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.map(server => server.close()))
  servers = []
  for (const directory of directories) {
    // An installed runtime is read-only (contract C1).
    execFileSync('chmod', ['-R', 'u+rwX', directory])
    await rm(directory, { recursive: true, force: true })
  }
  directories = []
})

/** One invocation's surroundings. */
interface Surroundings {
  readonly home: string
  readonly package: string
  readonly stderr: string[]
  readonly stdout: string[]
  readonly started: LaunchCommand[]
  readonly fixture: Fixture
  readonly server: StandIn
  context(change?: Partial<LauncherContext>): LauncherContext
}

/**
 * A home, a package directory shipping the fixture's root, and a server for the fixture release in the layout GitHub
 * Releases gives.
 * @param options - whether the package ships its root.
 * @returns the surroundings.
 */
async function surroundings(options: { readonly roots?: boolean } = {}): Promise<Surroundings> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-launcher-main-'))
  directories.push(directory)
  const fixture = await fixtureRelease({ platform: platformOf(process.platform, process.arch) })
  const served = new Map<string, Buffer>()
  for (const [path, bytes] of releasePaths(fixture)) served.set(path.replace(`/releases/${VERSION}/`, `/releases/download/v${VERSION}/`), bytes)
  const server = await standIn(served)
  servers.push(server)
  const packageDirectory = join(directory, 'package')
  await mkdir(join(packageDirectory, 'roots'), { recursive: true })
  if (options.roots !== false) await writeFile(join(packageDirectory, 'roots', '1.root.json'), fixture.roots[0]!)
  const stderr: string[] = []
  const stdout: string[] = []
  const started: LaunchCommand[] = []
  return {
    home: join(directory, 'home'),
    package: packageDirectory,
    stderr,
    stdout,
    started,
    fixture,
    server,
    context: change => ({
      env: { DELO_HOME: join(directory, 'home') },
      output: { stdout: text => void stdout.push(text), stderr: text => void stderr.push(text) },
      packageDirectory,
      constants: { channelOrigin: server.origin, logOrigin: 'http://127.0.0.1:1' },
      spawn: (command) => { started.push(command); return Promise.resolve(0) },
      ...change,
    }),
  }
}

describe('the launcher’s main function', () => {
  it('installs the channel’s release, prints each step and the log warning, records the check, and starts the runtime', async () => {
    const world = await surroundings()
    expect(await main([], world.context())).toBe(0)
    expect(world.stderr.join('').split('\n').filter(Boolean)).toEqual([
      `Resolving the release: the stable channel names ${VERSION}.`,
      `Checking the signature: ${VERSION} is signed under release root 1.`,
      expect.stringMatching(/^Checking the release log: not checked \(the release log did not answer: .+\)\.$/u),
      `Warning: Release ${VERSION} has not been checked against the release log; Delo checks it at the next connection.`,
      expect.stringMatching(new RegExp(`^Downloading delorun-${VERSION.replaceAll('.', '\\.')}-${platformOf(process.platform, process.arch)}\\.tar\\.gz \\(\\d+ kB\\)\\.$`, 'u')),
      `Installing release ${VERSION}.`,
    ])
    expect(world.started).toHaveLength(1)
    expect(world.started[0]!.command).toBe(join(world.home, 'runtimes', VERSION, 'node', 'bin', 'node'))
    const state = JSON.parse(await readFile(join(world.home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
  })

  it('starts the installed runtime on a later run, with no network and no install lines', async () => {
    const world = await surroundings()
    await main([], world.context())
    world.stderr.length = 0
    expect(await main(['status'], world.context({ constants: { channelOrigin: 'http://127.0.0.1:1', logOrigin: 'http://127.0.0.1:1' } }))).toBe(0)
    expect(world.stderr).toEqual([])
    expect(world.started.at(-1)!.args.at(-1)).toBe('status')
  })

  it('starts the runtime it installed with a real process, and returns the runtime’s own status', async () => {
    const world = await surroundings()
    // The fixture's Node is a script that exits 0.
    expect(await main([], world.context({ spawn: undefined }))).toBe(0)
    expect(world.started).toEqual([])
    expect(world.stderr.join('')).toContain(`Installing release ${VERSION}.`)
  })

  it('trusts the roots of its own package when it is given no other directory, and its own package ships none in the source tree', async () => {
    const world = await surroundings()
    expect(await main([], world.context({ packageDirectory: undefined }))).toBe(1)
    expect(world.stderr.join('')).toContain('This launcher cannot verify any release')
  })

  it('prints the usage text for --help, and starts and installs nothing', async () => {
    const world = await surroundings()
    expect(await main(['--help'], world.context())).toBe(0)
    expect(world.stdout.join('')).toContain('Usage: delorun')
    expect(world.server.requests).toEqual([])
  })

  it('exits 2 with the usage text for a command line it cannot read', async () => {
    const world = await surroundings()
    expect(await main(['--profile'], world.context())).toBe(2)
    expect(await main(['--release', 'not-a-version'], world.context())).toBe(2)
    expect(world.stderr.join('')).toContain('--release names not-a-version, which is not a Delo release version')
    expect(world.stderr.join('')).toContain('Usage: delorun')
    expect(await readdir(join(world.home, '..')).then(names => names.includes('home'))).toBe(false)
  })

  it('refuses every install, naming the missing root, when the package ships none', async () => {
    const world = await surroundings({ roots: false })
    expect(await main([], world.context())).toBe(1)
    expect(world.stderr.join('')).toContain('This launcher cannot verify any release')
    expect(world.started).toEqual([])
    expect(world.server.requests).toEqual([])
  })

  it('refuses a build origin that breaks the rule, before it asks anything', async () => {
    const world = await surroundings()
    expect(await main([], world.context({ constants: { channelOrigin: 'http://channel.example.test' } }))).toBe(1)
    expect(world.stderr.join('')).toContain('must use https, or http on this machine')
    expect(world.started).toEqual([])
  })

  it('names a machine it publishes no runtime for', async () => {
    const world = await surroundings()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('plan9' as NodeJS.Platform)
    expect(await main([], world.context())).toBe(2)
    expect(world.stderr.join('')).toContain('Delo publishes a runtime for')
    platform.mockRestore()
  })

  it('reads a --release given as --release=<version> and refuses it when a runtime is already installed', async () => {
    const world = await surroundings()
    await main([], world.context())
    world.stderr.length = 0
    expect(await main([`--release=${VERSION}`], world.context())).toBe(1)
    expect(world.stderr.join('')).toContain(`--release ${VERSION} asks for release ${VERSION}`)
  })

  it('writes to the process’s own streams when it is given no output', async () => {
    const written: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((text: string | Uint8Array) => { written.push(String(text)); return true })
    expect(await main(['--help'])).toBe(0)
    stdout.mockRestore()
    expect(written.join('')).toContain('Usage: delorun')
    const failure: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { failure.push(String(text)); return true })
    expect(await main(['--profile'])).toBe(2)
    stderr.mockRestore()
    expect(failure.join('')).toContain('--profile needs a profile name')
  })
})

describe('the logger an early failure is reported through', () => {
  it('writes errors and warnings to standard error as lines, and drops information and debugging', () => {
    const lines: string[] = []
    const logger = stderrLogger({ stdout: () => undefined, stderr: text => void lines.push(text) })
    logger.error('one')
    logger.warn('two')
    logger.info('three')
    logger.debug('four')
    expect(lines).toEqual(['one\n', 'two\n'])
  })
})
