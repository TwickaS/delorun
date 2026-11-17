/**
 * The pack hub over a real installed-release fixture: a pack is downloaded from a fake channel, verified, installed
 * into the home and loaded through the plugin manager's install; the queue's states, its one reload, the offline
 * failure, cancelling and the persisted file are what a surface reads.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { buildPackArchive, PackRefusal } from '@delorun/release-formats/packs/archive'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { StorePaths, type InstalledRelease, type PackFiles } from '@delorun/runtime-store'
import { fixtureHome, PLATFORM, version, type FixtureHome } from '../../runtime-store/tests/support.ts'
import type { PacksEnvironment } from '../src/environment.ts'
import { PacksHub } from '../src/hub.ts'
import type { InstallBundle } from '../src/runner.ts'
import { packView, type PacksSnapshot } from '../src/wire.ts'

const V1 = version('0.1.0')
const text = (path: string, body: string) => ({ path, mode: '0644' as const, data: Buffer.from(body) })

let fixture: FixtureHome
beforeEach(() => { fixture = fixtureHome() })
afterEach(() => { fixture.remove() })

interface Setup {
  readonly hub: PacksHub
  readonly installs: { spec: string, requestId: string, expected: { name: string, version: string } }[]
  readonly reloads: number[]
  readonly file: string
  readonly paths: StorePaths
  readonly chats: { count: number }
  readonly files: { fetchRelease: PackFiles['fetchRelease'] }
}

async function setup(options: { application?: string, archive?: (signal?: AbortSignal) => Promise<Uint8Array> } = {}): Promise<Setup> {
  await fixture.install('0.1.0')
  const paths = new StorePaths(fixture.home, PLATFORM)
  const manifestBytes = readFileSync(paths.releaseFiles(V1).manifest)
  const built = await Promise.all(['one', 'two'].map(name => buildPackArchive(`delorun-0.1.0-pack-${name}.any.tar.gz`, [text('package.json', `{"name":"${name}","version":"1.0.0","type":"module"}`)], 1_800_000_000)))
  const entries = ['one', 'two'].map((name, index) => ({ name, version: '1.0.0', experimental: name === 'two', variants: { any: { ...built[index]!.variant, external: [], peers: [] } } }))
  const signed = { schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: createHash('sha256').update(manifestBytes).digest('hex'), packs: entries }
  const packsBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [fixture.keys.targets]), undefined, 2)}\n`)
  const served = new Map<string, Uint8Array>([['delorun-0.1.0.packs.json', packsBytes], ['delorun-0.1.0.packs.log.json', Buffer.from('{}')]])
  built.forEach(each => served.set(each.variant.archive.name, each.bytes))
  const release: InstalledRelease = { paths, root: fixture.root, version: V1, manifestBytes, checkLog: () => ({ ok: true }) }
  const files: PackFiles = {
    fetchRelease: (name, _size, transfer) => (options.archive !== undefined && name.endsWith('.tar.gz') ? options.archive(transfer?.signal) : Promise.resolve(served.get(name))),
    fetchExternal: () => Promise.reject(new Error('no external')),
  }
  const environment: PacksEnvironment = { release: () => Promise.resolve(release), files }
  const installs: Setup['installs'] = []
  const reloads: number[] = []
  const chats = { count: 0 }
  const installBundle: InstallBundle = (spec, opts) => {
    installs.push({ spec, requestId: opts.requestId, expected: opts.expected })
    return Promise.resolve({ application: options.application ?? 'applied' })
  }
  const file = join(fixture.home, 'run', 'default', 'installs.json')
  const hub = new PacksHub({ environment, installBundle, runningChats: () => chats.count, reload: () => { reloads.push(Date.now()); return Promise.resolve() }, file, concurrency: 2, requestId: key => `pack:${key}` })
  return { hub, installs, reloads, file, paths, chats, files }
}

async function until(hub: PacksHub, done: (snapshot: PacksSnapshot) => boolean): Promise<PacksSnapshot> {
  let last = await hub.snapshot()
  await vi.waitFor(async () => { last = await hub.snapshot(); expect(done(last)).toBe(true) }, { timeout: 5000 })
  return last
}

describe('the pack hub', () => {
  it('lists the release\'s packs as available, experimental-labelled, with their download size', async () => {
    const { hub } = await setup()
    const snapshot = await hub.snapshot()
    expect(snapshot).toMatchObject({ supported: true, release: '0.1.0', queue: [] })
    expect(snapshot.packs.map(pack => [pack.name, pack.experimental, pack.availability])).toEqual([['one', false, 'available'], ['two', true, 'available']])
    expect(snapshot.packs.every(pack => pack.downloadBytes > 0)).toBe(true)
  })

  it('downloads, installs and loads a pack through the plugin manager under its own request id', async () => {
    const { hub, installs, paths, file } = await setup()
    expect((await hub.enqueue(['one'])).ok).toBe(true)
    const snapshot = await until(hub, each => each.queue[0]?.state === 'ready')
    expect(installs).toEqual([{ spec: `link:${join(paths.pack(V1, 'one'), 'package')}`, requestId: 'pack:one', expected: { name: 'one', version: '1.0.0' } }])
    expect(snapshot.packs.find(pack => pack.name === 'one')?.availability).toBe('installed')
    expect(packView(snapshot.packs[0], snapshot.queue[0])).toEqual({ kind: 'installed' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(hub.installedTarget('one', '0.1.0')).toEqual({ spec: `link:${join(paths.pack(V1, 'one'), 'package')}`, version: '0.1.0' })
    expect(hub.installedTarget('two', '0.1.0')).toBeUndefined()
  })

  it('reloads the Host once for several installs that need it, and not while a chat runs', async () => {
    const { hub, reloads, chats } = await setup({ application: 'restart-required' })
    chats.count = 1
    await hub.enqueue(['one', 'two'])
    await until(hub, each => each.queue.length === 2 && each.queue.every(item => item.state === 'needs-reload'))
    await sleep(50)
    expect(reloads).toHaveLength(0)
    chats.count = 0
    hub.chatsChanged()
    await until(hub, each => each.queue.every(item => item.state === 'ready'))
    expect(reloads).toHaveLength(1)
  })

  it('fails an install that cannot connect as offline, which a surface reads as needing a connection', async () => {
    const { hub } = await setup({ archive: () => Promise.reject(new PackRefusal('x needs a connection', 'OFFLINE')) })
    await hub.enqueue(['one'])
    const snapshot = await until(hub, each => each.queue[0]?.state === 'failed')
    expect(snapshot.queue[0]?.failure?.code).toBe('offline')
    expect(packView(snapshot.packs[0], snapshot.queue[0])).toMatchObject({ kind: 'offline' })
  })

  it('cancels a working download and removes nothing from the home', async () => {
    let started = false
    const { hub, paths } = await setup({ archive: (signal) => {
      started = true
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    } })
    await hub.enqueue(['one'])
    await vi.waitFor(() => { expect(started).toBe(true) })
    await hub.cancel('one')
    const snapshot = await until(hub, each => each.queue[0]?.state === 'cancelled')
    expect(snapshot.packs[0]?.availability).toBe('available')
    expect(existsSync(paths.pack(V1, 'one'))).toBe(false)
  })

  it('leaves an installed pack installed when a phone cancels it, since cancel only stops a queued or working install', async () => {
    const { hub, paths } = await setup()
    await hub.enqueue(['one'])
    await until(hub, each => each.queue[0]?.state === 'ready')
    await hub.cancel('one')
    const snapshot = await hub.snapshot()
    expect(snapshot.queue[0]?.state).toBe('ready')
    expect(snapshot.packs[0]?.availability).toBe('installed')
    expect(existsSync(paths.pack(V1, 'one'))).toBe(true)
  })

  it('dismisses a failed or cancelled row but never a ready one', async () => {
    const { hub } = await setup({ archive: () => Promise.reject(new PackRefusal('x needs a connection', 'OFFLINE')) })
    await hub.enqueue(['one'])
    await until(hub, each => each.queue[0]?.state === 'failed')
    expect((await hub.dismiss('one'))).toMatchObject({ ok: true, value: { queue: [] } })
    const ready = await setup()
    await ready.hub.enqueue(['one'])
    await until(ready.hub, each => each.queue[0]?.state === 'ready')
    expect((await ready.hub.dismiss('one'))).toMatchObject({ ok: true, value: { queue: [{ state: 'ready' }] } })
  })

  it('refuses an unknown pack and keeps the list as it was', async () => {
    const { hub } = await setup()
    expect(await hub.enqueue(['nope'])).toMatchObject({ ok: false, error: { code: 'unknown-pack' } })
    expect((await hub.snapshot()).queue).toEqual([])
  })

  it('restores the list after a restart: a working item fails as interrupted and a queued one starts again', async () => {
    const { file, hub } = await setup()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ v: 1, items: [{ key: 'one', state: 'downloading', receivedBytes: 5, reloadNeeded: false }, { key: 'two', state: 'failed', receivedBytes: 0, reloadNeeded: false, failure: { code: 'failed', message: 'x' } }] })}\n`)
    const restarted = new PacksHub(hub.deps)
    expect((await restarted.snapshot()).queue.map(item => [item.key, item.state, item.failure?.code])).toEqual([['one', 'failed', 'interrupted'], ['two', 'failed', 'failed']])
  })

  it('says why a Host without an installed release has no packs', async () => {
    const hub = new PacksHub({ environment: { unsupported: 'not an installation' }, installBundle: () => Promise.reject(new Error('unused')), runningChats: () => 0, reload: () => Promise.resolve(), file: join(fixture.home, 'run', 'q.json'), concurrency: 1, requestId: key => key })
    expect(await hub.snapshot()).toEqual({ supported: false, reason: 'not an installation', packs: [], queue: [] })
    expect(await hub.enqueue(['one'])).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })
})
