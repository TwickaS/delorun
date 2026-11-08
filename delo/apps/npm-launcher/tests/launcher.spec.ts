/**
 * The launcher's run flow: it starts the installed runtime without asking the channel for anything, installs the
 * channel's release only when the store holds none, keeps the release's files beside the installation, and prints one
 * refusal sentence with a remedy when any install step refuses, exiting 1 with nothing installed.
 *
 * The release fixture is the install path's own (`../../install/tests/support.ts`), because a launcher's flow is the
 * install path plus the store, and a release is what both are about.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { InstallError, type InstallErrorCode } from '@delo/install'
import {
  parseRuntimeVersion,
  RuntimeStoreError,
  type ChannelRelease,
  type InstallRequest,
  type LaunchCommand,
  type LaunchPlan,
  type LaunchRequest,
  type RetentionResult,
  type RuntimeChannel,
  type VerifiedRuntime,
} from '@delo/runtime-store'
import { launcherProfile, runLauncher, type LauncherOptions, type LauncherStore } from '../src/launcher.ts'
import { installRemedies, LAUNCHER_EXIT, refusalFor } from '../src/refusals.ts'
import { parseCommandLine, usage } from '../src/bin.ts'
import { fixtureRelease, VERSION } from '../../install/tests/support.ts'

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
 * The launcher's inputs for a spec, with the parts it does not exercise defaulted.
 * @param options - the home, the store, the channel, and what the spec observes.
 * @returns the options.
 */
function launch(options: {
  readonly home: string
  readonly store: LauncherStore
  readonly channel: RuntimeChannel
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
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
    spawn: options.spawn ?? (() => Promise.resolve(0)),
    output: { stdout: () => undefined, stderr: options.stderr ?? (() => undefined) },
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
    const status = await runLauncher(launch({ home: directory, store: recordingStore(recorded), channel: fixtureChannel(directory, fixture) }))
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
