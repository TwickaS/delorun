/**
 * Review probes (not part of the package): the seam over the store — homeCommand's argv and cwd, error shapes that
 * cross the seam, and what prepare does with a channel offering a version lower than the installed one.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeRuntimeStore, RuntimeStoreError, type ChannelRelease, type ReleaseFileBytes } from '../src/index.ts'
import { closureFiles, fixtureHome, makeWritable, releaseFiles, version, writeClosure, type FixtureFile, type FixtureHome } from './support.ts'

const V1 = version('0.1.0')
const V2 = version('0.2.0')

let fixture: FixtureHome

beforeEach(() => {
  fixture = fixtureHome()
})

afterEach(() => {
  fixture.remove()
})

/** A channel with fixed offers. */
function channelOf(offers: Array<{ readonly release: string, readonly files?: Record<string, FixtureFile> }>): { resolve(target?: string): Promise<ChannelRelease>, fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes>, recordInstalled(release: ChannelRelease): Promise<void> } {
  const map = new Map(offers.map(offer => [offer.release, releaseFiles(fixture.keys.targets, offer.release, offer.files ?? closureFiles(offer.release))]))
  return {
    async resolve(target) {
      const chosen = target ?? offers.map(offer => offer.release).sort().at(-1)!
      if (!map.has(chosen)) throw new Error(`the channel has no release ${chosen}`)
      return { version: version(chosen), root: fixture.root }
    },
    async fill(release, directory) {
      writeClosure(directory, closureFiles(String(release.version)))
      return map.get(String(release.version))!
    },
    async recordInstalled() {},
  }
}

const reporter = { build: async (version: unknown) => ({ report: { for: version }, health: { disabledPlugins: [], namedRows: [] }, dataDiffers: false }) }

function seam(channel: ReturnType<typeof channelOf>): HomeRuntimeStore {
  return new HomeRuntimeStore({ store: fixture.store, profile: 'default', root: async () => fixture.root, fullCheckDays: 7, openChannel: async () => channel, report: reporter })
}

describe('probe: homeCommand', () => {
  it('carries no token-like argument in argv, and runs from the home, in both modes', async () => {
    await fixture.install(V1)
    const store = seam(channelOf([]))
    for (const mode of ['successor', 'start'] as const) {
      const command = store.homeCommand(V1, mode)
      expect(command.cwd).toBe(fixture.home)
      expect(command.args.join(' ').toLowerCase()).not.toContain('token')
      expect(command.args).toEqual([
        join(fixture.home, 'runtimes', V1, 'app/node_modules/@delo/cli/src/bin.js'),
        'start', '--foreground', '--profile', 'default',
      ])
      // no field of the command names a secret-bearing file
      expect(JSON.stringify(command)).not.toContain('start-token')
    }
  })
})

describe('probe: errors across the seam', () => {
  it('a root source that cannot anchor the root refuses reportRollback, and a prepare of an installed target, before the channel is asked', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    const refusal = new RuntimeStoreError('ROOT_NOT_ANCHORED', join(fixture.home, 'trust/root.json'), 'no launcher roots')
    let opened = 0
    const store = new HomeRuntimeStore({
      store: fixture.store, profile: 'default', root: () => Promise.reject(refusal), fullCheckDays: 7, report: reporter,
      openChannel: async () => { opened += 1; return channelOf([]) },
    })
    await expect(store.reportRollback(V1)).rejects.toBe(refusal)
    await expect(store.prepare(V1, () => {}, () => {})).rejects.toBe(refusal)
    expect(opened).toBe(0)
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
  })

  it('prepare reports an intact installed target without contacting the channel', async () => {
    await fixture.install(V1)
    let resolved = 0
    const channel = channelOf([{ release: '0.1.0' }])
    const wrapped = { ...channel, resolve: async (target?: string) => { resolved += 1; return channel.resolve(target) } }
    const store = seam(wrapped)
    const prepared = await store.prepare(V1, () => {}, () => {})
    expect(prepared.version).toBe(V1)
    expect(resolved).toBe(0)
  })

  it('prepare refuses what the channel resolves when it is lower than current, with TARGET_LOWER and the rollback remedy', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    const store = seam(channelOf([{ release: '0.1.0' }]))
    await expect(store.prepare(undefined, () => {}, () => {})).rejects.toMatchObject({ code: 'TARGET_LOWER', remedies: ['rollback'] })
    expect(await fixture.store.pointers()).toEqual({ current: V2, previous: V1 })
  })
})

describe('probe: start-check refusals keep their codes through the seam', () => {
  it('reportRollback refuses a tampered previous with RUNTIME_CHANGED and remedies', async () => {
    await fixture.install(V1)
    await fixture.install(V2)
    await fixture.store.switchTo(V1, V2)
    makeWritable(join(fixture.home, 'runtimes', V1))
    writeFileSync(join(fixture.home, 'runtimes', V1, 'app/package.json'), '{"name":"changed"}\n')
    const store = seam(channelOf([]))
    const error = await store.reportRollback(V1).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(RuntimeStoreError)
    expect((error as RuntimeStoreError).code).toBe('RUNTIME_CHANGED')
    expect((error as RuntimeStoreError).remedies).toEqual(['reinstall'])
  })
})
