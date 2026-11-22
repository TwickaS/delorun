import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import {
  closureFiles,
  fixtureHome,
  makeWritable,
  releaseFiles,
  version,
  writeClosure,
  type FixtureFile,
  type FixtureHome,
} from './support.ts'
import type { RuntimeStoreError } from '../src/index.ts'
import { HomeRuntimeStore, type ChannelRelease, type OpenUpdateChannel, type PreparePhase, type ReleaseFileBytes, type UpdateInstallEvent } from '../src/index.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')
const V3 = version('0.3.0')

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

/** A release the fixture channel offers, with the file bytes its fill keeps beside the installation. */
interface OfferedRelease extends ChannelRelease {
  /** The release files, signed over the offered closure. */
  readonly bytes: ReleaseFileBytes
}

/**
 * A release the fixture channel offers, as the launcher's download would publish it.
 * @param release - the version.
 * @param files - the closure's files.
 * @returns the signed release files.
 */
function offered(release: RuntimeVersion, files: Record<string, FixtureFile>): OfferedRelease {
  return { version: release, root: fixture.root, bytes: releaseFiles(fixture.keys.targets, release, files) }
}

/** The fixture channel: the releases a spec offers, resolved to the newest when the update names none. */
class FixtureChannel {
  /** The versions whose archive the channel filled, in order. */
  readonly fills: RuntimeVersion[] = []
  /** The versions the store installed and the channel recorded, in order. */
  readonly recorded: RuntimeVersion[] = []
  /** Where the channel writes its install progress, as the prepare that opened it gave it. */
  report: (event: UpdateInstallEvent) => void = () => {}
  private readonly releases = new Map<RuntimeVersion, OfferedRelease>()

  /**
   * @param offered - the releases on the channel.
   */
  constructor(...offered: readonly OfferedRelease[]) {
    for (const release of offered) this.releases.set(release.version, release)
  }

  async resolve(target: RuntimeVersion | undefined): Promise<ChannelRelease> {
    const newest = [...this.releases.keys()].sort((left, right) => (left < right ? -1 : 1)).at(-1)
    const chosen = target ?? newest
    const release = chosen === undefined ? undefined : this.releases.get(chosen)
    if (release === undefined) throw new Error(`the channel has no release ${String(chosen)}`)
    this.report({ step: 'resolved', channel: 'stable', version: release.version })
    return { version: release.version, root: release.root }
  }

  async fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes> {
    const found = this.releases.get(release.version)
    if (found === undefined) throw new Error(`the channel has no release ${release.version}`)
    this.fills.push(release.version)
    writeClosure(directory, closureFiles(release.version))
    return found.bytes
  }

  async recordInstalled(release: ChannelRelease): Promise<void> {
    this.recorded.push(release.version)
  }
}

/**
 * An opener of one fixture channel, which reports a step for each release it resolves.
 * @param channel - the channel.
 * @param events - where the steps go besides the opener's caller; nowhere by default.
 * @returns the opener.
 */
function opening(channel: FixtureChannel, events: UpdateInstallEvent[] = []): OpenUpdateChannel {
  return async (report) => {
    channel.report = (event) => { events.push(event); report(event) }
    return channel
  }
}

/** The fixture report builder: it records the versions it reported, reports each one's purpose and names no disabled plugin. */
class FixtureReporter {
  /** The versions reported, in order. */
  readonly reported: RuntimeVersion[] = []

  async build(version: RuntimeVersion, purpose: 'update' | 'rollback') {
    this.reported.push(version)
    return { report: { for: version, purpose }, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false }
  }
}

/**
 * Expect a promise to reject with a store error of a code.
 * @param promise - the operation.
 * @param code - the expected code.
 */
async function refused(promise: Promise<unknown>, code: RuntimeStoreError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'RuntimeStoreError', code })
}

/**
 * Change one installed byte of a version, as a person or process with their access could.
 * @param installedVersion - the version to spoil.
 */
function tamper(installedVersion: RuntimeVersion): void {
  const path = join(fixture.home, 'runtimes', installedVersion, 'app/package.json')
  makeWritable(join(fixture.home, 'runtimes', installedVersion))
  writeFileSync(path, '{"name":"changed"}\n')
}

/**
 * Whether a version passes the start check now.
 * @param version - the version.
 * @returns true when it is installed and whole.
 */
async function isInstalledNow(version: RuntimeVersion): Promise<boolean> {
  return fixture.store.checkRuntime(version, fixture.root).then(() => true, () => false)
}

describe('pointers', () => {
  it('reads current and previous from the store', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    expect(await store.pointers()).toEqual({ current: V2, previous: V1 })
  })

  it('surfaces a store error with its code when current is missing, so the home process maps it', async () => {
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    await refused(store.pointers(), 'NO_ACTIVE_RUNTIME')
  })
})

describe('prepare', () => {
  it('installs the newest release on the channel and leaves current on the running version', async () => {
    await fixture.install(V1)
    const channel = new FixtureChannel(offered(V2, closureFiles('0.2.0')))
    const phases: PreparePhase[] = []
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(channel), report: new FixtureReporter() })
    const prepared = await store.prepare(undefined, phase => { phases.push(phase) }, () => {})
    expect(phases).toEqual(['checking', 'installing', 'reporting'])
    expect(prepared).toEqual({ version: V2, report: { for: V2, purpose: 'update' }, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false })
    expect(await fixture.store.pointers()).toEqual({ current: V1 })
    expect(await fixture.store.checkRuntime(V2, fixture.root)).toMatchObject({ version: V2 })
  })

  it('records the release through the channel once the store installed it, reports the install\'s steps, and opens no channel for an intact target', async () => {
    await fixture.install(V1)
    const recorded: string[] = []
    const channel = new FixtureChannel(offered(V2, closureFiles('0.2.0')))
    channel.recordInstalled = async (release: ChannelRelease) => { recorded.push(`${release.version} installed=${String(await isInstalledNow(release.version))}`) }
    let opened = 0
    const written: UpdateInstallEvent[] = []
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: async (report) => { opened++; return opening(channel)(report) }, report: new FixtureReporter() })
    await store.prepare(undefined, () => {}, (event) => { written.push(event) })
    await store.prepare(undefined, () => {}, () => {})
    expect(recorded).toEqual([`${V2} installed=true`])
    expect(written).toEqual([{ step: 'resolved', channel: 'stable', version: V2 }, { step: 'installing', version: V2 }, { step: 'installed', version: V2 }])
    await store.prepare(V2, () => {}, () => {})
    expect(opened).toBe(2)
  })

  it('skips the install of an installed target whose files match its manifest, and fetches again only once', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    const channel = new FixtureChannel(offered(V2, closureFiles('0.2.0')))
    const reporter = new FixtureReporter()
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(channel), report: reporter })
    const phases: PreparePhase[] = []
    const prepared = await store.prepare(V2, phase => { phases.push(phase) }, () => {})
    expect(phases).toEqual(['checking', 'reporting'])
    expect(prepared.version).toBe(V2)
    expect(channel.fills).toEqual([])
    const again: PreparePhase[] = []
    await store.prepare(undefined, phase => { again.push(phase) }, () => {})
    expect(again).toEqual(['checking', 'reporting'])
    expect(channel.fills).toEqual([])
    expect(reporter.reported).toEqual([V2, V2])
  })

  it('installs a named target again when its files no longer match its manifest', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    tamper(V2)
    const channel = new FixtureChannel(offered(V2, closureFiles('0.2.0')))
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(channel), report: new FixtureReporter() })
    const phases: PreparePhase[] = []
    const prepared = await store.prepare(V2, phase => { phases.push(phase) }, () => {})
    expect(phases).toEqual(['checking', 'installing', 'reporting'])
    expect(prepared.version).toBe(V2)
    expect(channel.fills).toEqual([V2])
    const path = join(fixture.home, 'runtimes', V2, 'app/package.json')
    expect(readFileSync(path, 'utf8')).toBe('{"name":"@delorun/runtime-closure","version":"0.2.0"}\n')
    expect(await fixture.store.pointers()).toEqual({ current: V1, previous: undefined })
  })

  it('fails without landing anything when the channel cannot fill the release', async () => {
    await fixture.install(V1)
    const failing = new FixtureChannel(offered(V2, closureFiles('0.2.0')))
    failing.fill = () => Promise.reject(new Error('the download failed'))
    const before = await fixture.store.pointers()
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(failing), report: new FixtureReporter() })
    await expect(store.prepare(undefined, () => {}, () => {})).rejects.toThrow('the download failed')
    expect(await fixture.store.pointers()).toEqual(before)
    expect(existsSync(join(fixture.home, 'runtimes', V2))).toBe(false)
    expect(readdirSync(join(fixture.home, 'staging'))).toEqual([])
  })

  it('surfaces the code of the store refusal when the fetched release fails the store checks', async () => {
    await fixture.install(V1)
    const release = offered(V2, closureFiles(V2))
    const lying = new FixtureChannel(release)
    lying.fill = (_resolved, directory) => {
      writeClosure(directory, closureFiles('0.9.9'))
      return Promise.resolve(release.bytes)
    }
    const before = await fixture.store.pointers()
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(lying), report: new FixtureReporter() })
    await refused(store.prepare(undefined, () => {}, () => {}), 'INSTALL_VERIFY_FAILED')
    expect(await fixture.store.pointers()).toEqual(before)
    expect(existsSync(join(fixture.home, 'runtimes', V2))).toBe(false)
  })

  it('an update to a lower version is refused: a channel naming a lower release installs nothing', async () => {
    await fixture.install(V2)
    const channel = new FixtureChannel(offered(V1, closureFiles('0.1.0')))
    const reporter = new FixtureReporter()
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(channel), report: reporter })
    await refused(store.prepare(undefined, () => {}, () => {}), 'TARGET_LOWER')
    expect(channel.fills).toEqual([])
    expect(channel.recorded).toEqual([])
    expect(reporter.reported).toEqual([])
    expect(existsSync(join(fixture.home, 'runtimes', V1))).toBe(false)
    expect(await fixture.store.pointers()).toEqual({ current: V2 })
  })

  it('an update to a lower version is refused: a request naming a lower installed version reports nothing', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    const channel = new FixtureChannel(offered(V1, closureFiles('0.1.0')))
    const reporter = new FixtureReporter()
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(channel), report: reporter })
    await refused(store.prepare(V1, () => {}, () => {}), 'TARGET_LOWER')
    expect(reporter.reported).toEqual([])
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
  })

  it('returns the report and the disabled plugins as the reporter built them', async () => {
    await fixture.install(V1)
    const store = new HomeRuntimeStore({
      store: fixture.store,
      profile: 'default',
      root: async () => fixture.root, fullCheckDays: 7,
      openChannel: opening(new FixtureChannel()),
      report: { build: () => Promise.resolve({ report: { disabled: ['notes'] }, health: { disabledPlugins: ['notes'], namedRows: [] }, dataDiffers: true }) },
    })
    await expect(store.prepare(V1, () => {}, () => {})).resolves.toEqual({ version: V1, report: { disabled: ['notes'] }, health: { disabledPlugins: ['notes'], namedRows: [] }, dataDiffers: true })
  })
})

describe('reportRollback', () => {
  /**
   * A home with 0.1.0 installed as `previous` and 0.2.0 as `current`, and the seam over it.
   * @returns the seam.
   */
  async function twoVersions(): Promise<HomeRuntimeStore> {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    return new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
  }

  it('reports the previous version after its start check passes', async () => {
    const store = await twoVersions()
    await expect(store.reportRollback(V1)).resolves.toEqual({ version: V1, report: { for: V1, purpose: 'rollback' }, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false })
  })

  it('refuses a target that fails the start check', async () => {
    const store = await twoVersions()
    tamper(V1)
    await refused(store.reportRollback(V1), 'RUNTIME_CHANGED')
  })

  it('refuses a target that is not installed', async () => {
    const store = await twoVersions()
    await refused(store.reportRollback(V3), 'NOT_INSTALLED')
  })
})

describe('switching and restoring', () => {
  it('switches by the store atomic writes and restores the pointers read before an update', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    const before = await store.pointers()
    await store.switchTo(V1, V2)
    expect(await store.pointers()).toEqual({ current: V2, previous: V1 })
    await store.restore(before)
    expect(await store.pointers()).toEqual({ current: V1 })
    expect(existsSync(join(fixture.home, 'runtimes/previous'))).toBe(false)
  })
})

describe('homeCommand', () => {
  it('starts the runtime node on the CLI entry as the home process, for a successor and a fresh start', async () => {
    await fixture.install(V1)
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    const expected = {
      command: join(fixture.home, 'runtimes', V1, 'node/bin/node'),
      args: [join(fixture.home, 'runtimes', V1, 'app/node_modules/@delorun/cli/src/bin.js'), 'start', '--foreground', '--profile', 'default'],
      cwd: fixture.home,
    }
    expect(store.homeCommand(V1, 'start')).toEqual(expected)
    expect(store.homeCommand(V1, 'successor')).toEqual(expected)
  })
})

describe('checkLaunch and retain', () => {
  it('checks a version under the anchored root and runs the release-log check before a home process starts from it', async () => {
    await fixture.install(V1)
    const checked: string[] = []
    const store = new HomeRuntimeStore({
      store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter(),
      preLaunch: async (version, root) => { checked.push(`${version}@${String(root.version)}`) },
    })
    await store.checkLaunch(V1)
    expect(checked).toEqual([`${V1}@1`])
    tamper(V1)
    await refused(store.checkLaunch(V1), 'RUNTIME_CHANGED')
    expect(checked).toEqual([`${V1}@1`])
  })

  it('stops at a release-log check that refuses, and needs none', async () => {
    await fixture.install(V1)
    const stop = new Error('the release-log check failed')
    const refusing = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter(), preLaunch: () => Promise.reject(stop) })
    await expect(refusing.checkLaunch(V1)).rejects.toBe(stop)
    const plain = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    await plain.checkLaunch(V1)
  })

  it('keeps only the versions the pointers name', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.install(V3)
    await fixture.store.switchTo(V1, V2)
    const store = new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: opening(new FixtureChannel()), report: new FixtureReporter() })
    await store.retain()
    expect(existsSync(join(fixture.home, 'runtimes', V3))).toBe(false)
    expect(existsSync(join(fixture.home, 'runtimes', V1))).toBe(true)
  })
})
