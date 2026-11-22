/**
 * The launcher's run flow: it starts the installed runtime without asking the channel for anything, installs the
 * channel's release only when the store holds none, keeps the release's files beside the installation, and prints one
 * refusal sentence with a remedy when any install step refuses, exiting 1 with nothing installed.
 *
 * The release fixture is the install path's own (`../../install/tests/support.ts`), because a launcher's flow is the
 * install path plus the store, and a release is what both are about.
 */
import { existsSync, readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELORUN_START_CHECK_ENV, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { InstallError, installRemedies, type InstallErrorCode } from '@delorun/install'
import {
  parseRuntimeVersion,
  parseStartCheckHandoff,
  RuntimeStore,
  RuntimeStoreError,
  type ChannelRelease,
  type InstallRequest,
  type LaunchCommand,
  type LaunchPlan,
  type LaunchRequest,
  type ReleaseFileBytes,
  type RetentionResult,
  type RuntimeChannel,
  type VerifiedRuntime,
} from '@delorun/runtime-store'
import { failedStartText, fullCheckDaysFor, launcherProfile, ROLLBACK_ARGS, runLauncher, runtimeCommand, type LauncherOptions, type LauncherStartCheck, type LauncherStore } from '../src/launcher.ts'
import { LAUNCHER_EXIT, refusalFor } from '../src/refusals.ts'
import { launchEnvironment, parseCommandLine, spawnRuntime, usage } from '../src/bin.ts'
import { fixtureRelease, nextRoot, VERSION, type Fixture } from '../../install/tests/support.ts'

let directories: string[] = []

/**
 * A release version the store can hold.
 * @param text - the version's text.
 * @returns the version.
 */
function version(text: string): RuntimeVersion {
  const parsed = parseRuntimeVersion(text)
  if (parsed === undefined) throw new Error(`${text} is not a release version the store can hold`)
  return parsed
}

afterEach(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
  directories = []
})

/**
 * A temporary Delorun home, with the trusted root a start check reads when the spec asks for one.
 * @param options - the root to store, when the home holds one.
 * @returns its path.
 */
async function home(options: { readonly root?: Uint8Array } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-launcher-'))
  directories.push(directory)
  if (options.root !== undefined) {
    await mkdir(join(directory, 'trust'), { mode: 0o700 })
    await writeFile(join(directory, 'trust', TRUST_FILES.root), options.root, { mode: 0o600 })
  }
  return directory
}

/** The store operations a launch that starts or installs `current` never reaches. */
const NO_ROLLBACK: Pick<LauncherStore, 'pointers' | 'checkRuntime' | 'launchCommand'> = {
  pointers: () => Promise.reject(new Error('the launcher reads no pointers when current starts')),
  checkRuntime: () => Promise.reject(new Error('the launcher checks no other version when current starts')),
  launchCommand: () => { throw new Error('the launcher builds no other command when current starts') },
}

/** What a spec's store was asked, so a spec can assert what ran. */
interface Recorded {
  /** The launch requests, in order. */
  launches: LaunchRequest[]
  /** The install requests, in order. */
  installs: InstallRequest[]
  /** How many retention runs happened. */
  retentions: number
}

/**
 * A store that records what the launcher asks of it, and that holds a runtime only once the spec installed one.
 * @param recorded - the record to add to.
 * @param options - whether the store already holds an installed runtime.
 * @returns the store.
 */
function recordingStore(recorded: Recorded, options: { readonly installed?: boolean } = {}): LauncherStore {
  let installed = options.installed ?? false
  return {
    prepareLaunch: (request: LaunchRequest): Promise<LaunchPlan> => {
      recorded.launches.push(request)
      if (!installed) {
        return Promise.reject(new RuntimeStoreError('NO_ACTIVE_RUNTIME', '/home/.delorun/runtimes', 'no runtime is installed', ['reinstall']))
      }
      return Promise.resolve({
        command: '/home/.delorun/runtimes/0.1.0/node/bin/node',
        args: ['the-entry.js', ...request.args],
        env: { DELORUN_HOME: '/home/.delorun' },
        version: version('0.1.0'),
        check: { full: request.fullCheckDays === 0, hashed: request.fullCheckDays === 0 ? 40 : 6, files: 40, fullCheckAt: 1_700_000_000_000 },
      })
    },
    install: async (request: InstallRequest): Promise<VerifiedRuntime> => {
      recorded.installs.push(request)
      await request.fill('/home/.delorun/staging/0123456789abcdef')
      installed = true
      return { manifest: {} as VerifiedRuntime['manifest'], files: {} as VerifiedRuntime['files'], manifestSha256: '0'.repeat(64), version: request.version }
    },
    retain: (): Promise<RetentionResult> => {
      recorded.retentions++
      return Promise.resolve({ removed: [], failed: [] })
    },
    ...NO_ROLLBACK,
  }
}

/**
 * A channel that hands back a release whose fill step refuses, as the install path does.
 * @param refuse - the refusal the fill step raises.
 * @param root - the root the release verified with.
 * @returns the channel.
 */
function refusingChannel(refuse: InstallError, root: ChannelRelease['root'] = {} as ChannelRelease['root']): RuntimeChannel {
  return {
    resolve: (): Promise<ChannelRelease> => Promise.resolve({ version: version('0.1.0'), root }),
    fill: (): Promise<never> => Promise.reject(refuse),
  }
}

/**
 * A channel that verifies the fixture release, recording the trusted root under the home as `LauncherChannel` does.
 * @param home - the resolved Delorun home.
 * @param fixture - the release.
 * @returns the channel.
 */
function fixtureChannel(home: string, fixture: Awaited<ReturnType<typeof fixtureRelease>>): RuntimeChannel {
  return {
    resolve: async () => {
      await mkdir(join(home, 'trust'), { recursive: true, mode: 0o700 })
      await writeFile(join(home, 'trust', TRUST_FILES.root), fixture.roots[0]!, { mode: 0o600 })
      return { version: version(VERSION), root: fixture.rootMetadata }
    },
    fill: () => Promise.resolve({ manifest: fixture.manifestBytes, files: fixture.filesBytes, bundle: fixture.bundleBytes }),
  }
}

/**
 * Fill a staging directory with a fixture release's files, as an install's fill step does once it has verified them.
 * @param fixture - the release.
 * @param directory - the store's staging directory.
 * @returns the release files the store keeps beside the installation.
 */
async function fillFromFixture(fixture: Fixture, directory: string): Promise<ReleaseFileBytes> {
  for (const entry of fixture.entries) {
    const path = join(directory, ...entry.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, entry.data, { mode: entry.mode === '0755' ? 0o755 : 0o644 })
  }
  return { manifest: fixture.manifestBytes, files: fixture.filesBytes, bundle: fixture.bundleBytes }
}

/**
 * Give an installed tree its writable modes back, so a spec's cleanup can remove it: contract C1 installs files at
 * 0444 or 0555 and their directories at 0555.
 * @param directory - the directory to unlock, in place.
 */
async function unlock(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await chmod(path, 0o755)
      await unlock(path)
    } else {
      await chmod(path, 0o644)
    }
  }
}

/** Every entry under a home, by its path relative to the home: its type, mode, inode, size, modification time and, for a file, its bytes. */
type HomeTree = Record<string, string>

/**
 * Read every entry under a directory, so a spec can show a run changed nothing: a rewritten or renamed file changes its
 * inode or modification time even when its bytes are the same.
 * @param directory - the directory.
 * @param prefix - the relative path of `directory`, empty at the top.
 * @returns the entries.
 */
async function homeTree(directory: string, prefix = ''): Promise<HomeTree> {
  const tree: HomeTree = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const info = await lstat(path)
    const header = `${entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'} ${info.mode.toString(8)} ${info.ino} ${info.size} ${info.mtimeMs}`
    if (entry.isDirectory()) {
      tree[relative] = header
      Object.assign(tree, await homeTree(path, relative))
    } else {
      tree[relative] = entry.isFile() ? `${header} ${(await readFile(path)).toString('base64')}` : header
    }
  }
  return tree
}

/**
 * The launcher's inputs for a spec, with the parts it does not exercise defaulted.
 * @param options - the home, the store, the channel, the roots the launcher ships, and what the spec observes.
 * @returns the options.
 */
function launch(options: {
  readonly home: string
  readonly store: LauncherStore
  readonly channel: LauncherOptions['channel']
  readonly roots: readonly Uint8Array[]
  readonly target?: RuntimeVersion
  readonly spawn?: (command: LaunchCommand) => Promise<number>
  readonly stderr?: (text: string) => void
  readonly args?: readonly string[]
  readonly passedThrough?: readonly string[]
  readonly startCheck?: LauncherOptions['startCheck']
}): LauncherOptions {
  return {
    home: options.home,
    profile: 'default',
    platform: 'linux-x64',
    args: options.args ?? [],
    passedThrough: options.passedThrough ?? [],
    mode: 'enforce',
    fullCheckDays: 7,
    repairMarkGraceSeconds: 5,
    store: options.store,
    channel: options.channel,
    roots: options.roots,
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
    spawn: options.spawn ?? (() => Promise.resolve(0)),
    output: { stdout: () => undefined, stderr: options.stderr ?? (() => undefined) },
    identity: { version: '0.3.0', path: '/launcher', now: () => 1_800_000_000_000 },
    ...options.target === undefined ? {} : { target: options.target },
    ...options.startCheck === undefined ? {} : { startCheck: options.startCheck },
  }
}

describe('a run with a runtime installed', () => {
  it('starts it, and asks the channel for nothing', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    let asked = 0
    const channel: RuntimeChannel = {
      resolve: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
      fill: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
    }
    let started: LaunchCommand | undefined
    const status = await runLauncher(launch({
      home: await home({ root: fixture.roots[0]! }),
      store: recordingStore(recorded, { installed: true }),
      channel,
      roots: fixture.roots,
      spawn: (command) => {
        started = command
        return Promise.resolve(7)
      },
    }))
    expect(status).toBe(7)
    expect(started?.command).toBe('/home/.delorun/runtimes/0.1.0/node/bin/node')
    expect(recorded.launches).toHaveLength(1)
    expect(recorded.launches[0]?.fullCheckDays).toBe(7)
    expect(recorded.installs).toHaveLength(0)
    expect(asked).toBe(0)
  })

  it('hands the runtime the record of its start check, naming the launcher and the time the check began', async () => {
    const fixture = await fixtureRelease()
    let started: LaunchCommand | undefined
    await runLauncher(launch({
      home: await home({ root: fixture.roots[0]! }),
      store: recordingStore({ launches: [], installs: [], retentions: 0 }, { installed: true }),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
      spawn: (command) => { started = command; return Promise.resolve(0) },
    }))
    expect(started?.env['DELORUN_HOME']).toBe('/home/.delorun')
    expect(parseStartCheckHandoff(started?.env[DELORUN_START_CHECK_ENV])).toEqual({
      schema: 'delorun.start-check/1', release: '0.1.0', at: 1_800_000_000_000, full: false, hashed: 6, files: 40,
      fullCheckAt: 1_700_000_000_000, launcher: { version: '0.3.0', path: '/launcher' },
    })
  })

  it('hashes every runtime file before delorun verify runs, whatever the interval, and keeps the interval for other commands', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const options = {
      home: await home({ root: fixture.roots[0]! }),
      store: recordingStore(recorded, { installed: true }),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
    }
    await runLauncher(launch({ ...options, args: ['--profile', 'default', 'verify', '--json'] }))
    await runLauncher(launch({ ...options, args: ['status'] }))
    expect(recorded.launches.map(launched => launched.fullCheckDays)).toEqual([0, 7])
    expect(fullCheckDaysFor({ args: ['verify'], fullCheckDays: 30 })).toBe(0)
    expect(fullCheckDaysFor({ args: ['start'], fullCheckDays: 30 })).toBe(30)
  })
})

describe('a run with no runtime installed', () => {
  it('installs the channel’s release, retains, and then starts what it installed', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home()
    const status = await runLauncher(launch({ home: directory, store: recordingStore(recorded), channel: fixtureChannel(directory, fixture), roots: fixture.roots }))
    expect(status).toBe(0)
    expect(recorded.installs).toHaveLength(1)
    expect(String(recorded.installs[0]!.version)).toBe(VERSION)
    expect(recorded.installs[0]!.fill).toBeTypeOf('function')
    expect(recorded.retentions).toBe(1)
    expect(recorded.launches).toHaveLength(1)
  })
})

describe('a home whose stored trust cannot be read', () => {
  it('treats a stored root that does not read as a home with no runtime, and installs', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home({ root: fixture.roots[0]! })
    await chmod(join(directory, 'trust', TRUST_FILES.root), 0o644)
    // The file stays laxer than 0600 after the install, so the launch that follows the install reads no root either.
    await runLauncher(launch({ home: directory, store: recordingStore(recorded), channel: fixtureChannel(directory, fixture), roots: fixture.roots }))
    expect(recorded.installs).toHaveLength(1)
  })

  it('refuses a walked root chain that does not read, and starts nothing', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home({ root: fixture.roots[0]! })
    await writeFile(join(directory, 'trust', 'roots'), 'in the way')
    let printed = ''
    let started = false
    const status = await runLauncher(launch({
      home: directory,
      store: recordingStore(recorded, { installed: true }),
      channel: fixtureChannel(directory, fixture),
      roots: fixture.roots,
      spawn: () => { started = true; return Promise.resolve(0) },
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain('the root chain stored beside')
    expect(printed).toContain('cannot be checked')
    expect(started).toBe(false)
  })
})

describe('the record of a release’s log check', () => {
  it('is made once the store has installed the release, and not before', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home()
    const order: string[] = []
    const store = recordingStore(recorded)
    const channel = fixtureChannel(directory, fixture)
    const status = await runLauncher(launch({
      home: directory,
      store: { ...store, install: async (request) => { const result = await store.install(request); order.push('installed'); return result } },
      channel: { ...channel, recordInstalled: (release) => { order.push(`recorded ${String(release.version)}`); return Promise.resolve() } },
      roots: fixture.roots,
    }))
    expect(status).toBe(0)
    expect(order).toEqual(['installed', `recorded ${VERSION}`])
  })

  it('is not made when the store refuses the release it downloaded', async () => {
    const fixture = await fixtureRelease()
    const directory = await home()
    let recordedCalls = 0
    const store: LauncherStore = {
      prepareLaunch: () => Promise.reject(new RuntimeStoreError('NO_ACTIVE_RUNTIME', '/home/.delorun/runtimes', 'no runtime is installed')),
      install: () => Promise.reject(new RuntimeStoreError('INSTALL_VERIFY_FAILED', '/home/.delorun/staging', 'the archive is not the manifest’s', ['reinstall'])),
      retain: () => Promise.resolve({ removed: [], failed: [] }),
      ...NO_ROLLBACK,
    }
    const status = await runLauncher(launch({
      home: directory,
      store,
      channel: { ...fixtureChannel(directory, fixture), recordInstalled: () => { recordedCalls++; return Promise.resolve() } },
      roots: fixture.roots,
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(recordedCalls).toBe(0)
  })
})

describe('an install whose retention cannot finish', () => {
  it('warns that the next run retries it, and still starts the runtime', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home()
    const warnings: string[] = []
    const store: LauncherStore = { ...recordingStore(recorded), retain: () => Promise.reject(new Error('the disk is busy')) }
    let started = false
    const options = launch({ home: directory, store, channel: fixtureChannel(directory, fixture), roots: fixture.roots, spawn: () => { started = true; return Promise.resolve(0) } })
    const status = await runLauncher({ ...options, logger: { ...options.logger, warn: message => void warnings.push(message) } })
    expect(status).toBe(0)
    expect(started).toBe(true)
    expect(warnings).toEqual(['the runtime store could not finish its retention after an install; the next run retries it'])
  })
})

describe('the steps the launcher itself reports', () => {
  it('reports installing once the release’s files are in the staging directory, then installed, then starting, in that order', async () => {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const directory = await home()
    const events: string[] = []
    const channel = fixtureChannel(directory, fixture)
    const options = launch({
      home: directory,
      store: recordingStore(recorded),
      channel: { resolve: channel.resolve.bind(channel), fill: (...args) => { events.push('filled'); return channel.fill(...args) } },
      roots: fixture.roots,
    })
    await runLauncher({ ...options, report: event => events.push(event.step) })
    expect(events).toEqual(['filled', 'installing', 'installed', 'starting'])
  })

  it('reports a failure of the install before the refusal is printed', async () => {
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const events: string[] = []
    let printed = ''
    const options = launch({ home: await home(), store: recordingStore(recorded), channel: refusingChannel(new InstallError('DOWNLOAD_REFUSED', 'https://example.test/a', 'example.test is not a release host'), { version: 1 } as ChannelRelease['root']), roots: [], stderr: (text) => { events.push('printed'); printed += text } })
    await runLauncher({ ...options, report: event => events.push(event.step) })
    expect(events[0]).toBe('failed')
    expect(printed).not.toBe('')
  })
})

describe('an install step that refuses', () => {
  it('prints the sentence and a remedy, exits 1, and starts nothing', async () => {
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const refusal = new InstallError('DOWNLOAD_REFUSED', 'https://example.test/delorun-0.1.0.tar.gz', 'example.test is not a release host')
    let printed = ''
    let started = false
    const status = await runLauncher(launch({
      home: await home(),
      store: recordingStore(recorded),
      channel: refusingChannel(refusal, { version: 1 } as ChannelRelease['root']),
      roots: [],
      spawn: () => {
        started = true
        return Promise.resolve(0)
      },
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain('Delorun refused to download https://example.test/delorun-0.1.0.tar.gz')
    expect(printed).toContain('report this if it repeats')
    expect(started).toBe(false)
    expect(recorded.installs).toHaveLength(1)
  })

  it('prints the store’s own sentence when the store refuses the release it downloaded', async () => {
    let printed = ''
    const store: LauncherStore = {
      prepareLaunch: () => Promise.reject(new RuntimeStoreError('NO_ACTIVE_RUNTIME', '/home/.delorun/runtimes', 'no runtime is installed')),
      install: () => Promise.reject(new RuntimeStoreError('INSTALL_VERIFY_FAILED', '/home/.delorun/staging', 'the archive is not the manifest’s', ['reinstall'])),
      retain: () => Promise.resolve({ removed: [], failed: [] }),
      ...NO_ROLLBACK,
    }
    const status = await runLauncher(launch({
      home: await home(),
      store,
      channel: refusingChannel(new InstallError('DOWNLOAD_FAILED', 'https://example.test/x', 'the connection did not open')),
      roots: [],
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain('Delorun refused the release it downloaded')
    expect(printed).toContain('npx delorun@latest repair')
  })

  it('prints what Delorun did, why and a remedy for every install refusal the path can raise', () => {
    const codes: readonly InstallErrorCode[] = [
      'DOWNLOAD_REFUSED',
      'DOWNLOAD_FAILED',
      'INSTALL_VERIFY_FAILED',
      'ARCHIVE_REFUSED',
      'RELEASE_LOG_FAILED',
      'RELEASE_NOT_OFFERED',
      'PLATFORM_NOT_RELEASED',
      'RELEASE_METADATA_INVALID',
      'TRUST_STATE_INVALID',
      'NO_TRUSTED_ROOT',
    ]
    for (const code of codes) {
      const remedies = installRemedies(code)
      expect(remedies.length, code).toBeGreaterThan(0)
      const refusal = refusalFor(new InstallError(code, 'a release file', 'what is wrong'), { home: '/home/.delorun', profile: 'default' })
      expect(refusal.exit, code).toBe(LAUNCHER_EXIT.failed)
      expect(refusal.remedies, code).toEqual(remedies)
      expect(refusal.text.endsWith('\n'), code).toBe(true)
      expect(refusal.text, code).toContain(`Why: ${code}: what is wrong\n`)
    }
  })
})

describe('the root a start trusts', () => {
  /**
   * Store a walked root chain under a home, as an install writes it: `trust/roots/<n>.root.json` at mode 0600.
   * @param home - the Delorun home.
   * @param roots - the chain, oldest first, each with the version its name carries.
   */
  async function storeChain(home: string, roots: readonly { readonly version: number, readonly bytes: Uint8Array }[]): Promise<void> {
    await mkdir(join(home, 'trust', 'roots'), { recursive: true, mode: 0o700 })
    for (const root of roots) await writeFile(join(home, 'trust', 'roots', `${String(root.version)}.root.json`), root.bytes, { mode: 0o600 })
  }

  it('refuses a stored root newer than every shipped root when no walked chain proves it descends from one, and starts nothing', async () => {
    const shipped = await fixtureRelease()
    const second = nextRoot(shipped.rootMetadata, shipped.keys, [shipped.keys.root])
    const directory = await home({ root: second })
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    let printed = ''
    let started = false
    const status = await runLauncher(launch({
      home: directory,
      store: recordingStore(recorded, { installed: true }),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: shipped.roots,
      spawn: () => {
        started = true
        return Promise.resolve(0)
      },
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain(`the root stored at ${join(directory, 'trust', TRUST_FILES.root)} is not one this launcher trusts`)
    expect(printed).toContain('holds no root of that version')
    expect(started).toBe(false)
    expect(recorded.launches).toHaveLength(0)
  })

  it('starts the installed runtime with a stored root newer than every shipped root when the walked chain reaches it', async () => {
    const shipped = await fixtureRelease()
    const second = nextRoot(shipped.rootMetadata, shipped.keys, [shipped.keys.root])
    const directory = await home({ root: second })
    await storeChain(directory, [{ version: 1, bytes: shipped.roots[0]! }, { version: 2, bytes: second }])
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    let started: LaunchCommand | undefined
    const status = await runLauncher(launch({
      home: directory,
      store: recordingStore(recorded, { installed: true }),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: shipped.roots,
      spawn: (command) => {
        started = command
        return Promise.resolve(5)
      },
    }))
    expect(status).toBe(5)
    expect(started?.command).toBe('/home/.delorun/runtimes/0.1.0/node/bin/node')
    expect(recorded.launches).toHaveLength(1)
  })

  it('refuses a stored root of a shipped version that this launcher does not ship, and starts nothing', async () => {
    const shipped = await fixtureRelease()
    const unrelated = await fixtureRelease()
    const directory = await home({ root: unrelated.roots[0]! })
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    let printed = ''
    let started = false
    let asked = 0
    const channel: RuntimeChannel = {
      resolve: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
      fill: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
    }
    const status = await runLauncher(launch({
      home: directory,
      store: recordingStore(recorded, { installed: true }),
      channel,
      roots: shipped.roots,
      spawn: () => {
        started = true
        return Promise.resolve(0)
      },
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain(`the root stored at ${join(directory, 'trust', TRUST_FILES.root)} is not one this launcher trusts`)
    expect(printed).toContain('keys or roles differ')
    expect(started).toBe(false)
    expect(asked).toBe(0)
    expect(recorded.launches).toHaveLength(0)
    expect(recorded.installs).toHaveLength(0)
  })
})

describe('a release named with --release when a runtime is installed', () => {
  it('refuses loudly with both versions named, installs nothing and starts nothing', async () => {
    const fixture = await fixtureRelease()
    const directory = await home({ root: fixture.roots[0]! })
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    let printed = ''
    let started = false
    let asked = 0
    const channel: RuntimeChannel = {
      resolve: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
      fill: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
    }
    const status = await runLauncher(launch({
      home: directory,
      store: recordingStore(recorded, { installed: true }),
      channel,
      roots: fixture.roots,
      target: version('0.2.0'),
      spawn: () => {
        started = true
        return Promise.resolve(0)
      },
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain('Delorun did not start the installed runtime')
    expect(printed).toContain('--release 0.2.0')
    expect(printed).toContain('runtime 0.1.0 is already installed')
    expect(printed).toContain('delorun update --profile default')
    expect(started).toBe(false)
    expect(asked).toBe(0)
    expect(recorded.installs).toHaveLength(0)
  })
})

describe('the environment the runtime starts with', () => {
  it('drops every inherited DELORUN_LAUNCHER_ variable, so the runtime sees only the launcher values this launcher sets', () => {
    const inherited = { PATH: '/bin', DELORUN_LAUNCHER_VERSION: '9.9.9', DELORUN_LAUNCHER_ROOTS: '/tmp/forged-roots', delorun_launcher_other: 'x' }
    expect(launchEnvironment(inherited, { DELORUN_LAUNCHER_ROOTS: '/pkg/roots' })).toEqual({ PATH: '/bin', DELORUN_LAUNCHER_ROOTS: '/pkg/roots' })
    expect(launchEnvironment(inherited, { DELORUN_LAUNCHER_ROOTS: '/pkg/roots', DELORUN_LAUNCHER_VERSION: '0.4.2' })).toEqual({ PATH: '/bin', DELORUN_LAUNCHER_ROOTS: '/pkg/roots', DELORUN_LAUNCHER_VERSION: '0.4.2' })
  })

  it('drops the variables that load code into the runtime’s Node and its dynamic loader, and the ones that decide what its HTTPS connections trust', () => {
    const environment = launchEnvironment(
      {
        PATH: '/bin',
        NODE_OPTIONS: '--require /tmp/hook.cjs',
        NODE_PATH: '/tmp/modules',
        NODE_EXTRA_CA_CERTS: '/tmp/interceptor.pem',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        LD_PRELOAD: '/tmp/hook.so',
        LD_LIBRARY_PATH: '/tmp/lib',
        DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
        DELORUN_HOME: '/inherited',
      },
      { DELORUN_HOME: '/home', DELORUN_PROFILE: 'work' },
    )
    expect(environment).toEqual({ PATH: '/bin', DELORUN_HOME: '/home', DELORUN_PROFILE: 'work' })
  })

  it('drops the variables whatever their case, since a Windows environment does not tell the cases apart', () => {
    const environment = launchEnvironment(
      { node_options: '--require x', Node_Path: '/x', ld_preload: '/x.so', Dyld_Library_Path: '/x', Node_Extra_Ca_Certs: '/x.pem', HOME: '/home' },
      {},
    )
    expect(environment).toEqual({ HOME: '/home' })
  })

  it('drops the variables that load OpenSSL modules and Node’s compile cache, and the C library’s module paths', () => {
    const names = ['OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE', 'NODE_ICU_DATA', 'GCONV_PATH', 'LOCPATH']
    expect(launchEnvironment(Object.fromEntries(names.map(name => [name, '/x'])), {})).toEqual({})
  })

  it('keeps the variables the runtime’s tools need, such as the person’s PATH, proxies, credentials and agents, because it runs their commands', () => {
    const kept = { PATH: '/bin', HOME: '/home', HTTPS_PROXY: 'http://proxy.example.test', SSL_CERT_FILE: '/etc/ssl/cert.pem', SSH_AUTH_SOCK: '/run/agent', DEEPSEEK_API_KEY: 'k', LANG: 'C', DISPLAY: ':0', GOPATH: '/go', WSL_DISTRO_NAME: 'Ubuntu' }
    expect(launchEnvironment(kept, {})).toEqual(kept)
  })

  it('drops a parent’s extra certificate authority and its TLS check switch, which would intercept every HTTPS connection the runtime makes', () => {
    const environment = launchEnvironment(
      { NODE_EXTRA_CA_CERTS: '/tmp/interceptor.pem', NODE_TLS_REJECT_UNAUTHORIZED: '0', HOME: '/home' },
      {},
    )
    expect(environment).toEqual({ HOME: '/home' })
  })

  it('starts a child Node that sees none of them, and sees the launch protocol’s own variables', async () => {
    const dropped = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DELORUN_PROFILE'] as const
    const saved = new Map(dropped.map(name => [name, process.env[name]]))
    try {
      process.env.NODE_OPTIONS = '--require /nonexistent/delorun-hook.cjs'
      process.env.NODE_PATH = '/nonexistent/delorun-modules'
      process.env.LD_PRELOAD = '/nonexistent/delorun-hook.so'
      process.env.DYLD_INSERT_LIBRARIES = '/nonexistent/delorun-hook.dylib'
      const probe = 'process.exit([process.env.NODE_OPTIONS, process.env.NODE_PATH, process.env.LD_PRELOAD, process.env.DYLD_INSERT_LIBRARIES, process.env.DELORUN_PROFILE].join("|") === "||||probe" ? 0 : 9)'
      const status = await spawnRuntime({ command: process.execPath, args: ['-e', probe], env: { DELORUN_PROFILE: 'probe' } })
      expect(status).toBe(0)
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe('a runtime that ends without a status', () => {
  it('counts as 128 plus the signal that ended it', async () => {
    const status = await spawnRuntime({ command: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGKILL")'], env: {} })
    expect(status).toBe(128 + 9)
  })
})

describe('a signal sent to the launcher while the runtime runs', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'delorun-spawn-signal-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  type Forwarded = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

  /** Start a runtime that writes its pid to `ready` and waits, and give back the listeners the launcher added to this process. */
  async function started(script: string): Promise<{ readonly status: Promise<number>, readonly pid: number, readonly added: (signal: Forwarded) => () => void }> {
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM'), SIGHUP: process.listeners('SIGHUP') }
    const status = spawnRuntime({ command: process.execPath, args: ['-e', script], env: { READY: join(directory, 'ready') } })
    const ready = join(directory, 'ready')
    for (let waited = 0; !existsSync(ready) || readFileSync(ready, 'utf8') === ''; waited += 20) {
      if (waited > 10_000) throw new Error('the runtime did not start')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return { status, pid: Number(readFileSync(ready, 'utf8')), added: signal => process.listeners(signal).find(listener => !before[signal].includes(listener)) as () => void }
  }

  const READY = 'require("fs").writeFileSync(process.env.READY, String(process.pid)); setInterval(() => undefined, 1000)'

  it('passes SIGTERM on to the runtime, and the launcher exits with the runtime\'s own status', async () => {
    const { status, added } = await started(`process.on("SIGTERM", () => process.exit(42)); ${READY}`)
    added('SIGTERM')()
    expect(await status).toBe(42)
  })

  it('passes SIGHUP on too, and a runtime it ends by signal counts as 128 plus the number', async () => {
    const { status, added } = await started(READY)
    added('SIGHUP')()
    expect(await status).toBe(128 + 1)
  })

  it('leaves SIGINT to the terminal: the runtime that Ctrl-C reaches once through the process group gets exactly one', async () => {
    // The runtime counts its SIGINTs and exits 100 + the count a moment after the first.
    const { status, added, pid } = await started(`let count = 0; process.on("SIGINT", () => { if (count++ === 0) setTimeout(() => process.exit(100 + count), 300) }); ${READY}`)
    // Ctrl-C: the terminal signals the runtime, and the launcher receives its own copy.
    process.kill(pid, 'SIGINT')
    added('SIGINT')()
    expect(await status).toBe(101)
  })

  it('stops listening once the runtime has ended', async () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listeners(signal as Forwarded).length)
    await spawnRuntime({ command: process.execPath, args: ['-e', ''], env: {} })
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listeners(signal as Forwarded).length)).toEqual(before)
  })
})

describe('a runtime a real runtime store installed', () => {
  it('starts it while it is whole, and refuses it after one byte changes, without spawning', async () => {
    const fixture = await fixtureRelease()
    const directory = await home({ root: fixture.roots[0]! })
    try {
      const store = new RuntimeStore({ home: directory, platform: fixture.platform, logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } })
      await store.install({ version: version(VERSION), root: fixture.rootMetadata, fill: staging => fillFromFixture(fixture, staging) })
      let asked = 0
      const channel: RuntimeChannel = {
        resolve: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
        fill: () => { asked++; return Promise.reject(new Error('the channel must not be asked')) },
      }
      let started: LaunchCommand | undefined
      const running = await runLauncher(launch({
        home: directory,
        store,
        channel,
        roots: fixture.roots,
        spawn: (command) => {
          started = command
          return Promise.resolve(0)
        },
      }))
      expect(running).toBe(0)
      expect(started?.command).toBe(join(directory, 'runtimes', VERSION, 'node', 'bin', 'node'))
      // One byte in place: the file keeps the length its signed list names, so only the digest can refuse it.
      const changed = join(directory, 'runtimes', VERSION, ...fixture.entries[0]!.path.split('/'))
      await chmod(changed, 0o644)
      const handle = await open(changed, 'r+')
      try {
        const byte = Buffer.alloc(1)
        await handle.read(byte, 0, 1, 0)
        byte[0] = byte[0]! ^ 0xff
        await handle.write(byte, 0, 1, 0)
      } finally {
        await handle.close()
      }
      expect((await readFile(changed)).byteLength).toBe(fixture.entries[0]!.data.byteLength)
      let printed = ''
      let spawned = false
      const status = await runLauncher(launch({
        home: directory,
        store,
        channel,
        roots: fixture.roots,
        spawn: () => {
          spawned = true
          return Promise.resolve(0)
        },
        stderr: (text) => { printed += text },
      }))
      expect(status).toBe(LAUNCHER_EXIT.failed)
      expect(printed).toContain(`${fixture.entries[0]!.path} (sha256)`)
      expect(spawned).toBe(false)
      expect(asked).toBe(0)
    } finally {
      // An installation is read-only; the spec's cleanup must be able to remove it.
      await unlock(directory)
    }
  })
})

describe('a runtime signed by a targets key a newer shipped root revoked', () => {
  it('c02-start-anchors-on-newest-shipped-root: is refused at start, because the start anchors on the newest shipped root, not the older stored one, and spawns nothing', async () => {
    const fixture = await fixtureRelease()
    const directory = await home({ root: fixture.roots[0]! })
    try {
      const store = new RuntimeStore({ home: directory, platform: fixture.platform, logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } })
      await store.install({ version: version(VERSION), root: fixture.rootMetadata, fill: staging => fillFromFixture(fixture, staging) })
      // Root 2 replaces every role key, signed by both root keys: the targets key that signed the installed release is revoked.
      const replacement = await fixtureRelease()
      const second = nextRoot(fixture.rootMetadata, replacement.keys, [fixture.keys.root, replacement.keys.root])
      const channel: RuntimeChannel = {
        resolve: () => Promise.reject(new Error('the channel must not be asked')),
        fill: () => Promise.reject(new Error('the channel must not be asked')),
      }
      let printed = ''
      let spawned = false
      const status = await runLauncher(launch({
        home: directory,
        store,
        channel,
        roots: [fixture.roots[0]!, second],
        spawn: () => {
          spawned = true
          return Promise.resolve(0)
        },
        stderr: (text) => { printed += text },
      }))
      expect(status).toBe(LAUNCHER_EXIT.failed)
      expect(printed).toContain('RUNTIME_CHANGED')
      expect(spawned).toBe(false)
    } finally {
      await unlock(directory)
    }
  })
})

describe('a real runtime store whose identity record a program running as the person forged', () => {
  it('c15-verify-sees-past-forged-record: delorun verify is refused, naming the changed file, though the record vouches for it and sets its last full pass to now', async () => {
    const fixture = await fixtureRelease()
    const directory = await home({ root: fixture.roots[0]! })
    // A runtime file, which ordinary starts take on the record's word.
    const changed = 'app/package.json'
    try {
      const store = new RuntimeStore({ home: directory, platform: fixture.platform, logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } })
      await store.install({ version: version(VERSION), root: fixture.rootMetadata, fill: staging => fillFromFixture(fixture, staging) })
      // A record vouches only for change times 2 s behind its capture: move `Date` past that window and record again.
      const recordPath = join(directory, 'trust', 'runtime-files', `delorun-${VERSION}-${fixture.platform}.json`)
      await rm(recordPath, { force: true })
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
      vi.setSystemTime(Date.now() + 3_000)
      await store.checkRuntime(version(VERSION), fixture.rootMetadata)
      const recorded = await readFile(recordPath, 'utf8').catch(() => undefined)
      // One byte changed in place, with the mode and times restored, and the record rewritten to vouch for it.
      const target = join(directory, 'runtimes', VERSION, ...changed.split('/'))
      const before = await stat(target)
      await chmod(target, 0o755)
      const handle = await open(target, 'r+')
      try {
        await handle.write(Buffer.from('X'), 0, 1, 0)
      } finally {
        await handle.close()
      }
      await chmod(target, before.mode & 0o777)
      await utimes(target, before.atime, before.mtime)
      if (recorded !== undefined) {
        const record = JSON.parse(recorded) as { files: (string | null)[], fullCheckAt: number }
        const list = fixture.entries.map(entry => entry.path)
        const after = await lstat(target, { bigint: true })
        record.files[list.indexOf(changed)] = `${String(after.ino)}:${String(after.mode)}:${String(after.size)}:${String(after.mtimeNs)}:${String(after.ctimeNs)}`
        record.fullCheckAt = Date.now()
        await rm(recordPath)
        await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      }
      const started: string[] = []
      let printed = ''
      const options = {
        home: directory,
        store,
        channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
        roots: fixture.roots,
        spawn: (command: LaunchCommand) => { started.push(command.args.at(-1) ?? ''); return Promise.resolve(0) },
        stderr: (text: string) => { printed += text },
      }
      if (recorded !== undefined) {
        // The documented limit: where change times are trusted, the forged record lets another command start.
        expect(await runLauncher(launch({ ...options, args: ['status'] }))).toBe(0)
        expect(started).toEqual(['status'])
      }
      expect(await runLauncher(launch({ ...options, args: ['verify'] }))).toBe(LAUNCHER_EXIT.failed)
      expect(printed).toContain(`${changed} (sha256)`)
      expect(started).not.toContain('verify')
    } finally {
      vi.useRealTimers()
      await unlock(directory)
    }
  })
})

describe('a real runtime store whose current fails its start check after an update', () => {
  it('refuses delorun verify without running either release, leaving both pointers and every file as they were, and starts previous with delorun recover rollback for delorun start', async () => {
    const fixture = await fixtureRelease()
    // A release signed by keys this home's root does not list: installed as `current`, it fails the start check.
    const unsigned = await fixtureRelease({ version: '0.2.0' })
    const directory = await home({ root: fixture.roots[0]! })
    try {
      const store = new RuntimeStore({ home: directory, platform: fixture.platform, logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } })
      await store.install({ version: version(VERSION), root: fixture.rootMetadata, fill: staging => fillFromFixture(fixture, staging) })
      await store.install({ version: version('0.2.0'), root: unsigned.rootMetadata, fill: staging => fillFromFixture(unsigned, staging) })
      await store.switchTo(version(VERSION), version('0.2.0'))
      const channel = refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked'))
      const started: LaunchCommand[] = []
      let printed = ''
      const options = {
        home: directory,
        store,
        channel,
        roots: fixture.roots,
        spawn: (command: LaunchCommand) => { started.push(command); return Promise.resolve(0) },
        stderr: (text: string) => { printed += text },
      }
      const before = await homeTree(directory)
      const refused = await runLauncher(launch({ ...options, args: ['verify'] }))
      expect(refused).toBe(LAUNCHER_EXIT.failed)
      expect(started).toEqual([])
      expect(printed).toContain('Delorun did not run delorun verify: release 0.2.0 failed its start check, so Delorun ran no release.\nWhy: RUNTIME_CHANGED: ')
      expect(printed).toContain(`Start release ${VERSION}, the version before the last update, to roll back to it: delorun recover rollback --profile default`)
      expect(await homeTree(directory)).toEqual(before)
      expect(await store.pointers()).toEqual({ current: version('0.2.0'), previous: version(VERSION) })
      const status = await runLauncher(launch({ ...options, args: ['start'] }))
      expect(status).toBe(0)
      expect(started.map(command => [command.command, ...command.args.slice(-2)])).toEqual([[join(directory, 'runtimes', VERSION, 'node', 'bin', 'node'), ...ROLLBACK_ARGS]])
    } finally {
      // An installation is read-only; the spec's cleanup must be able to remove it.
      await unlock(directory)
    }
  })
})

describe('the command line', () => {
  it('keeps --release and --profile for itself and passes everything else to the runtime', () => {
    const line = parseCommandLine(['--release', '0.1.0', '--profile=work', 'doctor', '--json'])
    expect(line.release).toBe('0.1.0')
    expect(line.profile).toBe('work')
    expect(line.runtimeArgs).toEqual(['--profile=work', 'doctor', '--json'])
    expect(line.help).toBe(false)
  })

  it('reports a flag without its value', () => {
    expect(() => parseCommandLine(['--release'])).toThrow(/needs a release version/u)
  })

  it('stops at the first --, so the runtime keeps its own --release and --profile', () => {
    const line = parseCommandLine(['--profile', 'work', '--', '--release', '0.2.0', '--profile', 'desktop'])
    expect(line.profile).toBe('work')
    expect(line.release).toBeUndefined()
    expect(line.runtimeArgs).toEqual(['--profile', 'work', '--release', '0.2.0', '--profile', 'desktop'])
    expect(line.passedThrough).toEqual(['--release', '0.2.0', '--profile', 'desktop'])
  })

  it('passes --release and --help after the command word to the runtime', () => {
    const verify = parseCommandLine(['verify', '--release', '0.1.0'])
    expect(verify.release).toBeUndefined()
    expect(verify.runtimeArgs).toEqual(['verify', '--release', '0.1.0'])
    const inline = parseCommandLine(['--profile', 'work', 'verify', '--release=0.1.0', '--json'])
    expect(inline.release).toBeUndefined()
    expect(inline.profile).toBe('work')
    expect(inline.runtimeArgs).toEqual(['--profile', 'work', 'verify', '--release=0.1.0', '--json'])
    for (const help of ['--help', '-h']) {
      const line = parseCommandLine(['start', help])
      expect(line.help).toBe(false)
      expect(line.runtimeArgs).toEqual(['start', help])
    }
  })

  it('still reads --release and --help before the command word and after repair, the launcher\'s own command', () => {
    expect(parseCommandLine(['--release', '0.1.0', 'verify']).release).toBe('0.1.0')
    expect(parseCommandLine(['--profile', 'work', '--help']).help).toBe(true)
    const repair = parseCommandLine(['repair', '--release', '0.1.1', '--from', '/tmp/r'])
    expect(repair.release).toBe('0.1.1')
    expect(repair.runtimeArgs).toEqual(['repair', '--from', '/tmp/r'])
    expect(parseCommandLine(['repair', '--help']).help).toBe(true)
  })

  it('refuses a profile name that would leave the home', () => {
    expect(() => launcherProfile('../../../etc', {})).toThrow(/is not a profile name/u)
    expect(() => launcherProfile(undefined, { DELORUN_PROFILE: '../../etc' })).toThrow(/is not a profile name/u)
    expect(() => launcherProfile('Work', {})).toThrow(/is not a profile name/u)
    expect(() => launcherProfile('a'.repeat(33), {})).toThrow(/is not a profile name/u)
    expect(launcherProfile('work-2_x', {})).toBe('work-2_x')
  })

  it('refuses the desktop app’s own profile', () => {
    expect(() => launcherProfile('desktop', {})).toThrow(/desktop/u)
    expect(launcherProfile(undefined, { DELORUN_PROFILE: 'work' })).toBe('work')
    expect(launcherProfile(undefined, {})).toBe('default')
  })

  it('reserved-profile-refused: refuses every name contract C1 reserves, from the option and DELORUN_PROFILE', () => {
    for (const name of ['desktop', 'headless', 'data-users', 'node_modules']) {
      expect(() => launcherProfile(name, {})).toThrow(name)
      expect(() => launcherProfile(undefined, { DELORUN_PROFILE: name })).toThrow(name)
    }
    for (const name of ['work', 'web', 'tui', 'my-headless', 'data-users2']) expect(launcherProfile(name, {})).toBe(name)
  })

  it('documents the launcher’s own options and passes the rest through', () => {
    expect(usage()).toContain('--release <version>')
    expect(usage()).toContain('Every other argument is passed to delorun unchanged.')
  })
})

describe('the release-log check at a start', () => {
  /**
   * Start the installed fixture runtime with a start check that answers as given.
   * @param result - what the check answers.
   * @param args - the runtime's arguments.
   * @returns the exit status, what was printed and whether the runtime started.
   */
  async function startWith(result: LauncherStartCheck, args: readonly string[] = []): Promise<{ readonly status: number, readonly printed: string, readonly started: boolean, readonly checked: RuntimeVersion[] }> {
    const fixture = await fixtureRelease()
    const recorded: Recorded = { launches: [], installs: [], retentions: 0 }
    const checked: RuntimeVersion[] = []
    let printed = ''
    let started = false
    const status = await runLauncher(launch({
      home: await home({ root: fixture.roots[0]! }),
      store: recordingStore(recorded, { installed: true }),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
      args,
      spawn: () => { started = true; return Promise.resolve(0) },
      stderr: (text) => { printed += text },
      startCheck: (checkedVersion, root) => {
        expect(root.version).toBe(1)
        checked.push(checkedVersion)
        return Promise.resolve(result)
      },
    }))
    return { status, printed, started, checked }
  }

  it('starts a verified release and prints nothing', async () => {
    const run = await startWith({ state: 'verified', stop: false })
    expect(run).toMatchObject({ status: 0, printed: '', started: true, checked: [version('0.1.0')] })
  })

  it('starts an unchecked release with the warning and its reason, and never blocks it', async () => {
    const run = await startWith({ state: 'unchecked', stop: false, warning: 'Release 0.1.0 has not been checked against the release log; Delorun checks it at the next connection.', detail: 'the release log gave no checkpoint (offline)', notices: ['the stored checkpoint does not read'] })
    expect(run.started).toBe(true)
    expect(run.printed).toBe('Release log: the stored checkpoint does not read\nRelease 0.1.0 has not been checked against the release log; Delorun checks it at the next connection. (the release log gave no checkpoint (offline))\n')
    const bare = await startWith({ state: 'unchecked', stop: false, warning: 'Release 0.1.0 has not been checked.' })
    expect(bare.printed).toBe('Release 0.1.0 has not been checked.\n')
  })

  it('stops a release whose release-log check failed, saying how to proceed and that deleting state is no remedy', async () => {
    const run = await startWith({ state: 'failed', stop: true, refusal: 'consistency-proof-invalid', detail: 'the proof does not verify' })
    expect(run.status).toBe(LAUNCHER_EXIT.failed)
    expect(run.started).toBe(false)
    expect(run.printed).toBe(failedStartText(version('0.1.0'), { state: 'failed', stop: true, refusal: 'consistency-proof-invalid', detail: 'the proof does not verify' }, 'default'))
    expect(run.printed).toContain('Run delorun verify')
    expect(run.printed).toContain('Deleting files under the home\'s trust/ directory does not repair this')
  })

  it('names the missing bundle\'s path and offers the rollback and the restored file, not a reinstall', async () => {
    const path = '/home/.delorun/runtimes/delorun-0.1.0.manifest.log.json'
    const run = await startWith({ state: 'failed', stop: true, refusal: 'bundle-malformed', detail: 'no release-log bundle is stored beside this release', missingBundle: path })
    expect(run.status).toBe(LAUNCHER_EXIT.failed)
    expect(run.started).toBe(false)
    expect(run.printed).toContain('Delorun did not start release 0.1.0: the release-log bundle stored beside it is missing.')
    expect(run.printed).toContain(`no release-log bundle is stored at ${path}`)
    expect(run.printed).toContain('delorun recover rollback --profile default')
    expect(run.printed).toContain(`restore ${path}`)
    expect(run.printed).not.toContain('reinstall')
  })

  it('starts previous for delorun recover rollback when current\'s bundle is missing, after checking previous\'s own release log', async () => {
    const fixture = await fixtureRelease()
    const current = version('0.2.0')
    const previous = version('0.1.0')
    const started: LaunchCommand[] = []
    const checked: RuntimeVersion[] = []
    let printed = ''
    const store: LauncherStore = {
      prepareLaunch: request => Promise.resolve({ command: `/home/.delorun/runtimes/${current}/node/bin/node`, args: ['entry.js', ...request.args], env: {}, version: current, check: { full: false, hashed: 6, files: 40, fullCheckAt: 1_700_000_000_000 } }),
      install: () => Promise.reject(new Error('the launcher must not install')),
      retain: () => Promise.reject(new Error('the launcher must not retain')),
      pointers: () => Promise.resolve({ current, previous }),
      checkRuntime: checkedVersion => Promise.resolve({ version: checkedVersion, manifest: {} as VerifiedRuntime['manifest'], files: { files: [] } as Partial<VerifiedRuntime['files']> as VerifiedRuntime['files'], manifestSha256: '0'.repeat(64) }),
      launchCommand: (launched, _profile, args) => ({ command: `/home/.delorun/runtimes/${launched}/node/bin/node`, args: ['entry.js', ...args], env: {} }),
    }
    const status = await runLauncher(launch({
      home: await home({ root: fixture.roots[0]! }),
      store,
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
      args: ['recover', 'rollback'],
      spawn: (command) => { started.push(command); return Promise.resolve(0) },
      stderr: (text) => { printed += text },
      startCheck: (release) => {
        checked.push(release)
        return Promise.resolve(release === current ? { state: 'failed', stop: true, refusal: 'bundle-malformed', detail: 'missing', missingBundle: '/b' } : { state: 'verified', stop: false })
      },
    }))
    expect(status).toBe(0)
    expect(checked).toEqual([current, previous])
    expect(started.map(command => command.command)).toEqual([`/home/.delorun/runtimes/${previous}/node/bin/node`])
    expect(printed).toContain(`Starting release ${previous}, the version before the last update`)
    // A plain start does not roll back on its own: it prints the refusal and starts nothing.
    const plain = await startWith({ state: 'failed', stop: true, refusal: 'bundle-malformed', detail: 'missing', missingBundle: '/b' }, ['start'])
    expect(plain.started).toBe(false)
  })

  it('does not start itself again when previous names the same release as current and its bundle is missing', async () => {
    const fixture = await fixtureRelease()
    const same = version('0.2.0')
    const started: LaunchCommand[] = []
    let checks = 0
    let printed = ''
    const store: LauncherStore = {
      prepareLaunch: request => Promise.resolve({ command: `/home/.delorun/runtimes/${same}/node/bin/node`, args: ['entry.js', ...request.args], env: {}, version: same, check: { full: false, hashed: 6, files: 40, fullCheckAt: 1_700_000_000_000 } }),
      install: () => Promise.reject(new Error('the launcher must not install')),
      retain: () => Promise.reject(new Error('the launcher must not retain')),
      // A kill between the store's two pointer writes leaves both pointers on one release.
      pointers: () => Promise.resolve({ current: same, previous: same }),
      checkRuntime: checkedVersion => Promise.resolve({ version: checkedVersion, manifest: {} as VerifiedRuntime['manifest'], files: { files: [] } as Partial<VerifiedRuntime['files']> as VerifiedRuntime['files'], manifestSha256: '0'.repeat(64) }),
      launchCommand: (launched, _profile, args) => ({ command: `/home/.delorun/runtimes/${launched}/node/bin/node`, args: ['entry.js', ...args], env: {} }),
    }
    const status = await runLauncher(launch({
      home: await home({ root: fixture.roots[0]! }),
      store,
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
      args: ['recover', 'rollback'],
      spawn: (command) => { started.push(command); return Promise.resolve(0) },
      stderr: (text) => { printed += text },
      startCheck: () => {
        // Fails the spec instead of hanging it when the launcher starts itself again.
        if (++checks > 3) return Promise.reject(new Error('the launcher started the same release again and again'))
        return Promise.resolve({ state: 'failed', stop: true, refusal: 'bundle-malformed', detail: 'missing', missingBundle: '/b' })
      },
    }))
    expect(checks).toBe(1)
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(started).toEqual([])
    expect(printed).toContain(`Delorun did not start release ${same}`)
  })

  it('redacts a secret the failed check\'s detail quotes before it prints it', async () => {
    const key = ['sk', '0123456789abcdef0123456789abcdef'].join('-')
    const run = await startWith({ state: 'failed', stop: true, refusal: 'consistency-proof-invalid', detail: `the log server answered ${key}` })
    expect(run.printed).toContain('Why: consistency-proof-invalid: the log server answered [redacted:provider-key]\n')
    expect(run.printed).not.toContain(key)
  })

  it('still runs delorun verify for a failed release, so the person can see every check', async () => {
    const run = await startWith({ state: 'failed', stop: true, refusal: 'consistency-proof-invalid', detail: 'x' }, ['--profile', 'default', 'verify'])
    expect(run.started).toBe(true)
    expect(run.printed).toContain('Delorun did not start release 0.1.0')
  })

  it('names the runtime command, skipping the profile option', () => {
    expect(runtimeCommand([])).toBeUndefined()
    expect(runtimeCommand(['--profile', 'work', 'verify', '--json'])).toBe('verify')
    expect(runtimeCommand(['--json', 'status'])).toBe('status')
  })
})

describe('a current runtime that fails its start check', () => {
  const CURRENT = version('0.2.0')
  const PREVIOUS = version('0.1.0')

  /** What a spec's broken store was asked. */
  interface Asked {
    /** The versions whose start check ran, with the root version each was given. */
    checked: string[]
    /** The commands built. */
    commands: string[]
  }

  /**
   * A store whose `current` fails its start check, with a `previous` that passes or fails its own.
   * @param asked - the record to add to.
   * @param previous - whether `previous` is installed, and whether it passes its start check.
   * @returns the store.
   */
  function brokenStore(asked: Asked, previous: 'none' | 'passes' | 'fails'): LauncherStore {
    return {
      prepareLaunch: () => Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', `/home/.delorun/runtimes/${CURRENT}`, `runtime ${CURRENT} differs from its signed file list: app/entry.js (sha256)`, ['reinstall', 'rollback'])),
      install: () => Promise.reject(new Error('the launcher must not install')),
      retain: () => Promise.reject(new Error('the launcher must not retain')),
      pointers: () => Promise.resolve(previous === 'none' ? { current: CURRENT } : { current: CURRENT, previous: PREVIOUS }),
      checkRuntime: (checked, root) => {
        asked.checked.push(`${checked}@${String(root.version)}`)
        if (previous === 'fails') return Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', `/home/.delorun/runtimes/${checked}`, 'differs'))
        return Promise.resolve({ version: checked, manifest: {} as VerifiedRuntime['manifest'], files: { files: [] } as Partial<VerifiedRuntime['files']> as VerifiedRuntime['files'], manifestSha256: '0'.repeat(64) })
      },
      launchCommand: (launched, profile, args) => {
        asked.commands.push(`${launched} ${args.join(' ')}`)
        return { command: `/home/.delorun/runtimes/${launched}/node/bin/node`, args: ['entry.js', ...args], env: { DELORUN_PROFILE: profile } }
      },
    }
  }

  /**
   * Run the launcher over a broken store.
   * @param previous - the store's `previous`.
   * @param options - the stored root, when it is not the shipped one; a named release; the start check; the arguments,
   *   `start` by default.
   * @returns the status, what was printed, the commands started, what the store was asked, and the home's tree before
   *   and after the run.
   */
  async function run(previous: 'none' | 'passes' | 'fails', options: { readonly stored?: Uint8Array, readonly target?: RuntimeVersion, readonly startCheck?: LauncherOptions['startCheck'], readonly args?: readonly string[], readonly argv?: readonly string[] } = {}): Promise<{ readonly status: number, readonly printed: string, readonly started: LaunchCommand[], readonly asked: Asked, readonly before: HomeTree, readonly after: HomeTree }> {
    const fixture = await fixtureRelease()
    const asked: Asked = { checked: [], commands: [] }
    const started: LaunchCommand[] = []
    let printed = ''
    const directory = await home({ root: options.stored ?? fixture.roots[0]! })
    const before = await homeTree(directory)
    const status = await runLauncher(launch({
      home: directory,
      store: brokenStore(asked, previous),
      channel: refusingChannel(new InstallError('INSTALL_VERIFY_FAILED', 'the channel', 'the channel must not be asked')),
      roots: fixture.roots,
      ...options.argv === undefined
        ? { args: options.args ?? ['start'] }
        : { args: parseCommandLine(options.argv).runtimeArgs, passedThrough: parseCommandLine(options.argv).passedThrough },
      spawn: (command) => { started.push(command); return Promise.resolve(7) },
      stderr: (text) => { printed += text },
      ...options.target === undefined ? {} : { target: options.target },
      ...options.startCheck === undefined ? {} : { startCheck: options.startCheck },
    }))
    return { status, printed, started, asked, before, after: await homeTree(directory) }
  }

  /** The notice a run that starts `previous` prints. */
  const NOTICE = `Delorun did not start release ${CURRENT}: it failed its start check. Starting release ${PREVIOUS}, the version before the last update, to roll back to it: delorun recover rollback\n`

  it.each([
    [[]],
    [['start']],
    [['--profile', 'default']],
    [['--profile=default']],
    [['--profile', 'default', 'start']],
    [['start', '--profile', 'default']],
    [['recover', 'rollback']],
    [['--profile', 'default', 'recover', 'rollback']],
  ])('starts previous with delorun recover rollback for the start or rollback command %j', async (args) => {
    const result = await run('passes', { args })
    expect(result.status).toBe(7)
    expect(result.started.map(command => command.args)).toEqual([['entry.js', ...ROLLBACK_ARGS]])
    expect(result.printed).toBe(NOTICE)
  })

  it.each([
    [['verify']],
    [['stop']],
    [['status']],
    [['update']],
    [['logs']],
    [['recover', 'status']],
    [['frobnicate']],
    [['--profile', 'default', 'verify']],
    [['--profile=default', 'stop']],
    [['--foreground']],
    [['start', '--foreground']],
    [['start', 'start']],
    [['recover', 'rollback', '--profile-only']],
    [['--profile']],
  ])('refuses %j, which is not a start, naming delorun recover rollback, and launches nothing and changes nothing in the home', async (args) => {
    const released: RuntimeVersion[] = []
    const result = await run('passes', { args, startCheck: (release) => { released.push(release); return Promise.resolve({ state: 'verified', stop: false }) } })
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.asked.commands).toEqual([])
    expect(released).toEqual([])
    expect(result.printed).toBe([
      `Delorun did not run ${['delorun', ...args].join(' ')}: release ${CURRENT} failed its start check, so Delorun ran no release.`,
      `Why: RUNTIME_CHANGED: runtime ${CURRENT} differs from its signed file list: app/entry.js (sha256)`,
      'What you can do:',
      `  Start release ${PREVIOUS}, the version before the last update, to roll back to it: delorun recover rollback --profile default`,
      '',
    ].join('\n'))
    expect(result.after).toEqual(result.before)
  })

  it.each([
    [['--', '--profile', 'work']],
    [['--', 'start']],
  ])('refuses the command line %j, whose arguments after -- the launcher did not read, and starts no release', async (argv) => {
    const result = await run('passes', { argv })
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.printed).toContain('delorun recover rollback --profile default')
    expect(result.after).toEqual(result.before)
  })

  it('starts previous with delorun recover rollback after checking it under the anchored root, printing one line', async () => {
    const result = await run('passes')
    expect(result.status).toBe(7)
    expect(result.asked).toEqual({ checked: [`${PREVIOUS}@1`], commands: [`${PREVIOUS} recover rollback`] })
    expect(result.started).toEqual([{ command: `/home/.delorun/runtimes/${PREVIOUS}/node/bin/node`, args: ['entry.js', ...ROLLBACK_ARGS], env: { DELORUN_PROFILE: 'default', [DELORUN_START_CHECK_ENV]: expect.any(String) } }])
    // `previous` passed the full check, which the record the runtime gets names.
    expect(parseStartCheckHandoff(result.started[0]?.env[DELORUN_START_CHECK_ENV])).toMatchObject({ release: PREVIOUS, full: true, hashed: 0, files: 0 })
    expect(result.printed).toBe(`Delorun did not start release ${CURRENT}: it failed its start check. Starting release ${PREVIOUS}, the version before the last update, to roll back to it: delorun recover rollback\n`)
  })

  it('refuses as before, starting nothing, when no previous is installed', async () => {
    const result = await run('none')
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.asked.checked).toEqual([])
    expect(result.printed).toContain(`Delorun did not start the installed runtime.\nWhy: RUNTIME_CHANGED: runtime ${CURRENT} differs from its signed file list`)
  })

  it('refuses as before, starting nothing, when previous fails its own start check', async () => {
    const result = await run('fails')
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.asked).toEqual({ checked: [`${PREVIOUS}@1`], commands: [] })
    expect(result.printed).toContain('Delorun did not start the installed runtime')
  })

  it('checks and starts nothing when the stored root is not one the launcher trusts', async () => {
    const stranger = await fixtureRelease()
    const result = await run('passes', { stored: stranger.roots[0]! })
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.asked).toEqual({ checked: [], commands: [] })
  })

  it('starts no rollback for a named release, which refuses as the store does', async () => {
    const result = await run('passes', { target: version('0.3.0') })
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.asked.checked).toEqual([])
  })

  it('runs the release-log check of previous, and starts no rollback when it fails', async () => {
    const checked: RuntimeVersion[] = []
    const result = await run('passes', { startCheck: (release) => { checked.push(release); return Promise.resolve({ state: 'failed', stop: true, refusal: 'consistency-proof-invalid', detail: 'the log forked' }) } })
    expect(checked).toEqual([PREVIOUS])
    expect(result.status).toBe(LAUNCHER_EXIT.failed)
    expect(result.started).toEqual([])
    expect(result.printed).toContain(`Delorun did not start release ${PREVIOUS}: its release-log check failed`)
  })
})
