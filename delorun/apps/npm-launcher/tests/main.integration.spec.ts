/**
 * The launcher's main function with a real runtime store and channel against a stand-in release server: a first run
 * installs and prints each step, an unreachable log warns and records, a later run starts without the network, and
 * every refusal before the install writes nothing. The release is the install path's own fixture.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRuntimeVersion, StorePaths, type LaunchCommand } from '@delorun/runtime-store'
import { installedNext, main, parseCommandLine, stderrLogger, type LauncherContext } from '../src/bin.ts'
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
    execFileSync('chmod', ['-R', 'u+rwX', directory], { timeout: 30_000 })
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
  const directory = await mkdtemp(join(tmpdir(), 'delorun-launcher-main-'))
  directories.push(directory)
  const fixture = await fixtureRelease({ platform: platformOf(process.platform, process.arch) })
  const served = new Map<string, Buffer>()
  for (const [path, bytes] of releasePaths(fixture)) served.set(path.replace(`/releases/${VERSION}/`, `/releases/download/v${VERSION}/`), bytes)
  const server = await standIn(served)
  servers.push(server)
  const packageDirectory = join(directory, 'package')
  await mkdir(join(packageDirectory, 'roots'), { recursive: true })
  if (options.roots !== false) await writeFile(join(packageDirectory, 'roots', '1.root.json'), fixture.roots[0]!)
  await writeFile(join(packageDirectory, 'package.json'), `${JSON.stringify({ name: 'delorun', version: '0.4.2' })}\n`)
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
      env: { DELORUN_HOME: join(directory, 'home') },
      output: { stdout: text => void stdout.push(text), stderr: text => void stderr.push(text) },
      packageDirectory,
      constants: { channelOrigin: server.origin, logOrigin: 'http://127.0.0.1:1' },
      spawn: (command) => { started.push(command); return Promise.resolve(0) },
      ...change,
    }),
  }
}

/**
 * The lines of a plain install log, without the durations and the percentage lines, whose number depends on the timing.
 * @param stderr - what the launcher wrote to standard error.
 * @returns the lines.
 */
function checklist(stderr: string): string[] {
  return stderr.split('\n').filter(line => line !== '' && !/^ {2}\d+%/u.test(line)).map(line => line.replace(/ {2}\d+(\.\d)?s$/u, ''))
}

describe('the launcher’s main function', () => {
  it.each([
    ['win32', 'Delorun 0.4.2 runs in WSL2, not on native Windows. Nothing was downloaded. Open a WSL2 terminal and run it there: https://docs.delorun.com/guide/get-started/install#windows-through-wsl2\n'],
    ['darwin', 'Delorun 0.4.2 does not run on macOS. Nothing was downloaded. It runs on Linux (x64), and on Windows through WSL2: https://docs.delorun.com/guide/get-started/install#windows-through-wsl2\n'],
    ['linux', 'Delorun 0.4.2 does not run on Linux on ARM (arm64). Nothing was downloaded. It runs on Linux (x64), and on Windows through WSL2: https://docs.delorun.com/guide/get-started/install#windows-through-wsl2\n'],
  ])('stops on %s before it reads the channel or creates a home', async (hostPlatform, message) => {
    const world = await surroundings()
    expect(await main([], world.context({ hostPlatform, hostArch: hostPlatform === 'linux' ? 'arm64' : 'x64' }))).toBe(1)
    expect(world.stderr.join('')).toBe(message)
    expect(world.server.requests).toEqual([])
    expect(world.started).toEqual([])
    expect(await readdir(dirname(world.home))).not.toContain('home')
  })

  it.each([['linux', 'riscv64'], ['linux', 'ia32'], ['freebsd', 'x64']])('refuses %s-%s as a host with no runtime, exit 1 and no usage text', async (hostPlatform, hostArch) => {
    const world = await surroundings()
    expect(await main([], world.context({ hostPlatform, hostArch }))).toBe(1)
    expect(world.stderr.join('')).toMatch(new RegExp(`^Delorun has no runtime for ${hostPlatform}-${hostArch}; `, 'u'))
    expect(world.stderr.join('')).not.toContain('Usage:')
    expect(world.server.requests).toEqual([])
    expect(world.started).toEqual([])
  })

  it('installs the channel’s release, prints each step and the log warning, records the check, and starts the runtime', async () => {
    const world = await surroundings()
    expect(await main([], world.context())).toBe(0)
    expect(checklist(world.stderr.join(''))).toEqual([
      `✔ Found release ${VERSION} on the stable channel`,
      '✔ Signature checked (release root 1)',
      expect.stringMatching(/^! Release log not checked \(the release log gave no checkpoint \(.+\)\)$/u),
      `  Warning: Release ${VERSION} has not been checked against the release log; Delorun checks it at the next connection.`,
      `Downloading delorun-${VERSION}-${platformOf(process.platform, process.arch)}.tar.gz…`,
      expect.stringMatching(/^✔ Downloaded \d+ kB/u),
      '✔ Download matches its signed hash',
      'Unpacking the runtime…',
      expect.stringMatching(/^✔ Unpacked the runtime \(\d+ files\)$/u),
      `✔ Installed release ${VERSION}`,
      '✔ Starting Delorun',
      'Next: a few setup questions',
    ])
    expect(world.started).toHaveLength(1)
    expect(world.started[0]!.command).toBe(join(world.home, 'runtimes', VERSION, 'node', 'bin', 'node'))
    const state = JSON.parse(await readFile(join(world.home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
  })

  it('draws the install as a redrawn checklist on a terminal, without colour when NO_COLOR is set, and prints it to nothing but standard error', async () => {
    const world = await surroundings()
    const context = world.context()
    expect(await main([], { ...context, env: { ...context.env, NO_COLOR: '1' }, progressStream: { isTTY: true, columns: 80 } })).toBe(0)
    const drawn = world.stderr.join('')
    expect(drawn).toContain('\u001B[')
    expect(drawn).not.toMatch(/\u001B\[\d+m/u)
    expect(drawn).toContain('✔ Installed release')
    expect(drawn).toContain('Next: a few setup questions')
  })

  it('starts the installed runtime on a later run with no network, warning that the release log was not reached', async () => {
    const world = await surroundings()
    await main([], world.context())
    world.stderr.length = 0
    expect(await main(['status'], world.context({ constants: { channelOrigin: 'http://127.0.0.1:1', logOrigin: 'http://127.0.0.1:1' } }))).toBe(0)
    expect(world.stderr.join('')).toMatch(new RegExp(`^Release ${VERSION.replaceAll('.', '\\.')} has not been checked against the release log; Delorun checks it at the next connection\\. \\(the release log gave no checkpoint \\(.+\\)\\)\\n$`, 'u'))
    expect(world.started.at(-1)!.args.at(-1)).toBe('status')
    // The runtime is told where this launcher's shipped roots are, so delorun verify anchors on them.
    expect(world.started.at(-1)!.env.DELORUN_LAUNCHER_ROOTS).toBe(join(world.package, 'roots'))
    // The runtime is told this launcher's own version, which setup pins its install of the delorun command to.
    expect(world.started.at(-1)!.env.DELORUN_LAUNCHER_VERSION).toBe('0.4.2')
    const state = JSON.parse(await readFile(join(world.home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string, uncheckedSince?: number }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
  })

  it('stops an installed release whose stored log bundle is missing, and one whose bundle path is not a file', async () => {
    const world = await surroundings()
    await main([], world.context())
    const files = new StorePaths(world.home, platformOf(process.platform, process.arch)).releaseFiles(parseRuntimeVersion(VERSION)!)
    await rm(files.bundle)
    world.stderr.length = 0
    expect(await main(['status'], world.context())).toBe(1)
    expect(world.stderr.join('')).toContain(`Delorun did not start release ${VERSION}: the release-log bundle stored beside it is missing.`)
    expect(world.stderr.join('')).toContain(`no release-log bundle is stored at ${files.bundle}`)
    expect(world.stderr.join('')).toContain('delorun recover rollback')
    expect(world.started).toHaveLength(1)
    await mkdir(files.bundle)
    world.stderr.length = 0
    expect(await main(['status'], world.context())).toBe(1)
    expect(world.stderr).toEqual(['Delorun stopped: EISDIR: illegal operation on a directory, read\n'])
    expect(world.started).toHaveLength(1)
  })

  it('starts the runtime it installed with a real process, and returns the runtime’s own status', async () => {
    const world = await surroundings()
    // The fixture's Node is a script that exits 0.
    expect(await main([], world.context({ spawn: undefined }))).toBe(0)
    expect(world.started).toEqual([])
    expect(world.stderr.join('')).toContain(`✔ Installed release ${VERSION}`)
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
    expect(world.stderr.join('')).toContain('--release names not-a-version, which is not a Delorun release version')
    expect(world.stderr.join('')).toContain('Usage: delorun')
    for (const days of ['31', '-1', '1.5', 'weekly']) {
      expect(await main(['status'], world.context({ env: { DELORUN_HOME: world.home, DELORUN_RUNTIME_FULL_CHECK_DAYS: days } }))).toBe(2)
      expect(world.stderr.join('')).toContain(`the interval of the runtime's full check is ${JSON.stringify(days)}`)
    }
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

  it('names a machine it publishes no runtime for, as a refused host and not a wrong command line', async () => {
    const world = await surroundings()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('plan9' as NodeJS.Platform)
    try {
      expect(await main([], world.context({ hostPlatform: undefined }))).toBe(1)
    } finally {
      platform.mockRestore()
    }
    expect(world.stderr.join('')).toContain('Delorun has no runtime for')
    expect(world.stderr.join('')).not.toContain('Usage:')
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

describe('what a first install says comes next', () => {
  it('names setup for a bare delorun on a home without the CLI profile, and the studio on one that has it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delorun-next-'))
    try {
      expect(installedNext(parseCommandLine([]), home, 'default')).toBe('a few setup questions')
      await mkdir(join(home, 'profiles', 'default'), { recursive: true })
      await writeFile(join(home, 'profiles', 'default', 'package.json'), '{}')
      expect(installedNext(parseCommandLine([]), home, 'default')).toBe('opening the studio')
      expect(installedNext(parseCommandLine(['--profile', 'other']), home, 'other')).toBe('a few setup questions')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('names setup and the studio for the commands that are them, and nothing for any other command', () => {
    expect(installedNext(parseCommandLine(['setup']), '/none', 'default')).toBe('a few setup questions')
    expect(installedNext(parseCommandLine(['start']), '/none', 'default')).toBe('opening the studio')
    expect(installedNext(parseCommandLine(['--version']), '/none', 'default')).toBeUndefined()
    expect(installedNext(parseCommandLine(['status']), '/none', 'default')).toBeUndefined()
    expect(installedNext(parseCommandLine(['--foreground']), '/none', 'default')).toBe('a few setup questions')
    expect(installedNext(parseCommandLine(['--', 'setup']), '/none', 'default')).toBe('a few setup questions')
  })
})
