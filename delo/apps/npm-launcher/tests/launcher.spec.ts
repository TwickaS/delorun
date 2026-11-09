/**
 * The launcher's run flow: it starts the installed runtime without asking the channel for anything, installs the
 * channel's release only when the store holds none, keeps the release's files beside the installation, and prints one
 * refusal sentence with a remedy when any install step refuses, exiting 1 with nothing installed.
 *
 * The release fixture is the install path's own (`../../install/tests/support.ts`), because a launcher's flow is the
 * install path plus the store, and a release is what both are about.
 */
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { InstallError, type InstallErrorCode } from '@delo/install'
import {
  parseRuntimeVersion,
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
} from '@delo/runtime-store'
import { launcherProfile, runLauncher, type LauncherOptions, type LauncherStore } from '../src/launcher.ts'
import { installRemedies, LAUNCHER_EXIT, refusalFor } from '../src/refusals.ts'
import { launchEnvironment, parseCommandLine, spawnRuntime, usage } from '../src/bin.ts'
import { fixtureRelease, VERSION, type Fixture } from '../../install/tests/support.ts'

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
 * A temporary Delo home, with the trusted root a start check reads when the spec asks for one.
 * @param options - the root to store, when the home holds one.
 * @returns its path.
 */
async function home(options: { readonly root?: Uint8Array } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-launcher-'))
  directories.push(directory)
  if (options.root !== undefined) {
    await mkdir(join(directory, 'trust'), { mode: 0o700 })
    await writeFile(join(directory, 'trust', TRUST_FILES.root), options.root, { mode: 0o600 })
  }
  return directory
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
        return Promise.reject(new RuntimeStoreError('NO_ACTIVE_RUNTIME', '/home/.delo/runtimes', 'no runtime is installed', ['reinstall']))
      }
      return Promise.resolve({
        command: '/home/.delo/runtimes/0.1.0/node/bin/node',
        args: ['the-entry.js', ...request.args],
        env: { DELO_HOME: '/home/.delo' },
        version: version('0.1.0'),
      })
    },
    install: async (request: InstallRequest): Promise<VerifiedRuntime> => {
      recorded.installs.push(request)
      await request.fill('/home/.delo/staging/0123456789abcdef')
      installed = true
      return { manifest: {} as VerifiedRuntime['manifest'], files: {} as VerifiedRuntime['files'], version: request.version }
    },
    retain: (): Promise<RetentionResult> => {
      recorded.retentions++
      return Promise.resolve({ removed: [], failed: [] })
    },
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
 * @param home - the resolved Delo home.
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

/**
 * The launcher's inputs for a spec, with the parts it does not exercise defaulted.
 * @param options - the home, the store, the channel, the roots the launcher ships, and what the spec observes.
 * @returns the options.
 */
function launch(options: {
  readonly home: string
  readonly store: LauncherStore
  readonly channel: RuntimeChannel
  readonly roots: readonly Uint8Array[]
  readonly target?: RuntimeVersion
  readonly spawn?: (command: LaunchCommand) => Promise<number>
  readonly stderr?: (text: string) => void
}): LauncherOptions {
  return {
    home: options.home,
    profile: 'default',
    platform: 'linux-x64',
    args: [],
    mode: 'enforce',
    store: options.store,
    channel: options.channel,
    roots: options.roots,
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
    spawn: options.spawn ?? (() => Promise.resolve(0)),
    output: { stdout: () => undefined, stderr: options.stderr ?? (() => undefined) },
    ...options.target === undefined ? {} : { target: options.target },
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
    expect(started?.command).toBe('/home/.delo/runtimes/0.1.0/node/bin/node')
    expect(recorded.launches).toHaveLength(1)
    expect(recorded.installs).toHaveLength(0)
    expect(asked).toBe(0)
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
    expect(printed).toContain('Delo refused to download https://example.test/delorun-0.1.0.tar.gz')
    expect(printed).toContain('report this if it repeats')
    expect(started).toBe(false)
    expect(recorded.installs).toHaveLength(1)
  })

  it('prints the store’s own sentence when the store refuses the release it downloaded', async () => {
    let printed = ''
    const store: LauncherStore = {
      prepareLaunch: () => Promise.reject(new RuntimeStoreError('NO_ACTIVE_RUNTIME', '/home/.delo/runtimes', 'no runtime is installed')),
      install: () => Promise.reject(new RuntimeStoreError('INSTALL_VERIFY_FAILED', '/home/.delo/staging', 'the archive is not the manifest’s', ['reinstall'])),
      retain: () => Promise.resolve({ removed: [], failed: [] }),
    }
    const status = await runLauncher(launch({
      home: await home(),
      store,
      channel: refusingChannel(new InstallError('DOWNLOAD_FAILED', 'https://example.test/x', 'the connection did not open')),
      roots: [],
      stderr: (text) => { printed += text },
    }))
    expect(status).toBe(LAUNCHER_EXIT.failed)
    expect(printed).toContain('Delo refused the release it downloaded')
    expect(printed).toContain('delorun update --profile default')
  })

  it('prints one sentence and a remedy for every install refusal the path can raise', () => {
    const codes: readonly InstallErrorCode[] = [
      'DOWNLOAD_REFUSED',
      'DOWNLOAD_FAILED',
      'INSTALL_VERIFY_FAILED',
      'ARCHIVE_REFUSED',
      'RELEASE_LOG_FAILED',
      'RELEASE_LOG_UNCHECKED',
      'RELEASE_NOT_OFFERED',
      'RELEASE_METADATA_INVALID',
      'TRUST_STATE_INVALID',
      'NO_TRUSTED_ROOT',
    ]
    for (const code of codes) {
      const remedies = installRemedies(code)
      expect(remedies.length, code).toBeGreaterThan(0)
      const refusal = refusalFor(new InstallError(code, 'a release file', 'what is wrong'), { home: '/home/.delo', profile: 'default' })
      expect(refusal.exit, code).toBe(LAUNCHER_EXIT.failed)
      expect(refusal.remedies, code).toEqual(remedies)
      expect(refusal.text.endsWith('\n'), code).toBe(true)
      expect(refusal.text, code).not.toContain(code)
    }
  })
})

describe('the root a start trusts', () => {
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
    expect(printed).toContain('Delo did not start the installed runtime')
    expect(printed).toContain('--release 0.2.0')
    expect(printed).toContain('runtime 0.1.0 is already installed')
    expect(printed).toContain('delorun update --profile default')
    expect(started).toBe(false)
    expect(asked).toBe(0)
    expect(recorded.installs).toHaveLength(0)
  })
})

describe('the environment the runtime starts with', () => {
  it('drops the variables that load code into the runtime’s Node and its dynamic loader', () => {
    const environment = launchEnvironment(
      {
        PATH: '/bin',
        NODE_OPTIONS: '--require /tmp/hook.cjs',
        NODE_PATH: '/tmp/modules',
        LD_PRELOAD: '/tmp/hook.so',
        LD_LIBRARY_PATH: '/tmp/lib',
        DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
        DELO_HOME: '/inherited',
      },
      { DELO_HOME: '/home', DELO_PROFILE: 'work' },
    )
    expect(environment).toEqual({ PATH: '/bin', DELO_HOME: '/home', DELO_PROFILE: 'work' })
  })

  it('starts a child Node that sees none of them, and sees the launch protocol’s own variables', async () => {
    const dropped = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DELO_PROFILE'] as const
    const saved = new Map(dropped.map(name => [name, process.env[name]]))
    try {
      process.env.NODE_OPTIONS = '--require /nonexistent/delo-hook.cjs'
      process.env.NODE_PATH = '/nonexistent/delo-modules'
      process.env.LD_PRELOAD = '/nonexistent/delo-hook.so'
      process.env.DYLD_INSERT_LIBRARIES = '/nonexistent/delo-hook.dylib'
      const probe = 'process.exit([process.env.NODE_OPTIONS, process.env.NODE_PATH, process.env.LD_PRELOAD, process.env.DYLD_INSERT_LIBRARIES, process.env.DELO_PROFILE].join("|") === "||||probe" ? 0 : 9)'
      const status = await spawnRuntime({ command: process.execPath, args: ['-e', probe], env: { DELO_PROFILE: 'probe' } })
      expect(status).toBe(0)
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
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
  })

  it('refuses a profile name that would leave the home', () => {
    expect(() => launcherProfile('../../../etc', {})).toThrow(/is not a profile name/u)
    expect(() => launcherProfile(undefined, { DELO_PROFILE: '../../etc' })).toThrow(/is not a profile name/u)
    expect(() => launcherProfile('Work', {})).toThrow(/is not a profile name/u)
    expect(() => launcherProfile('a'.repeat(33), {})).toThrow(/is not a profile name/u)
    expect(launcherProfile('work-2_x', {})).toBe('work-2_x')
  })

  it('refuses the desktop app’s own profile', () => {
    expect(() => launcherProfile('desktop', {})).toThrow(/desktop/u)
    expect(launcherProfile(undefined, { DELO_PROFILE: 'work' })).toBe('work')
    expect(launcherProfile(undefined, {})).toBe('default')
  })

  it('documents the launcher’s own options and passes the rest through', () => {
    expect(usage()).toContain('--release <version>')
    expect(usage()).toContain('Every other argument is passed to delorun unchanged.')
  })
})
