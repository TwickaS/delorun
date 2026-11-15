/**
 * Two local publishes with the Worker's daily re-signing between them (G3): without the import the second publish
 * collides with the channel's version; with it the second publish is accepted and a client verifies it as a successor.
 * Throwaway keys; the Worker's own `resignTimestamp` runs against an in-memory bucket and mark.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { importTimestamp, initialState, nextTimestamp, stateAfter, type ManifestFile, type TimestampState } from '@delorun/release/sign/timestamp'
import { manifestContent, rootFile, throwawayKeys, type Keys } from '@delorun/release/tests/sign/fixture'
import { publishChannel, PublishRefusal } from '../src/publish-release.ts'
import { resignTimestamp } from '../src/resign-core.ts'
import { MemoryMark, MemoryStore } from './support.ts'

const T0 = Date.parse('2026-11-10T12:00:00Z') / 1000
const DAY = 86_400
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function sign(content: object, key: Keys['timestamp']): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
}

/** One local release: the signer signs the next timestamp from its state, and the channel directory is laid out for the publish. */
function localRelease(keys: Keys, rootBytes: Buffer, state: TimestampState, version: string, now: number): { dir: string, state: TimestampState, timestampVersion: number } {
  const root = trustRootChain([rootBytes], now).at(-1)!
  const manifest: ManifestFile = { name: `delorun-${version}.manifest.json`, bytes: sign({ ...manifestContent(version, Buffer.from(`archive ${version}`)), channel: 'stable' }, keys.targets) }
  const content = nextTimestamp({ state, roots: [root], first: state.timestamp === null, manifests: { stable: manifest, beta: manifest }, replaced: [], now })
  const bytes = sign(content, keys.timestamp)
  const dir = mkdtempSync(join(tmpdir(), 'ts-import-'))
  directories.push(dir)
  for (const [name, data] of Object.entries({ 'timestamp.json': bytes, 'root/1.root.json': rootBytes, [`releases/download/v${version}/${manifest.name}`]: manifest.bytes })) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), data)
  }
  return { dir, state: stateAfter(root, bytes, content.version), timestampVersion: content.version }
}

describe('a second local publish after the Worker re-signed', () => {
  async function firstPublishAndTwoResigns() {
    const keys = throwawayKeys()
    const rootBytes = rootFile(keys).bytes
    const root = trustRootChain([rootBytes], T0).at(-1)!
    const store = new MemoryStore()
    const mark = new MemoryMark()
    const first = localRelease(keys, rootBytes, initialState(root), '0.1.0', T0)
    await publishChannel(store, first.dir)
    expect(first.timestampVersion).toBe(1)
    await resignTimestamp({ store, mark, key: keys.timestamp, now: T0 + DAY })
    await resignTimestamp({ store, mark, key: keys.timestamp, now: T0 + 2 * DAY })
    return { keys, rootBytes, root, store, signerState: first.state, now: T0 + 2 * DAY + 60 }
  }

  it('collides with the channel before the import: the stale state signs version 2 against a stored 3', async () => {
    const s = await firstPublishAndTwoResigns()
    const second = localRelease(s.keys, s.rootBytes, s.signerState, '0.1.1', s.now)
    expect(second.timestampVersion).toBe(2)
    await expect(publishChannel(s.store, second.dir)).rejects.toThrow(PublishRefusal)
  })

  it('is accepted after the import and verifies as the successor of what the client stored', async () => {
    const s = await firstPublishAndTwoResigns()
    const served = s.store.objects.get('timestamp.json')!.bytes
    const adopted = importTimestamp({ state: s.signerState, roots: [s.root], bytes: served, now: s.now })!
    const second = localRelease(s.keys, s.rootBytes, adopted, '0.1.1', s.now)
    expect(second.timestampVersion).toBe(4)
    await publishChannel(s.store, second.dir)
    const stored = s.store.objects.get('timestamp.json')!.bytes
    const clientHolds = { version: 3, bytes: served }
    expect(verifyTimestamp(s.root, stored, s.now, clientHolds).version).toBe(4)
  })

  it('refuses an import when a racing re-signing already moved the channel past the file that was downloaded', async () => {
    const s = await firstPublishAndTwoResigns()
    const served = s.store.objects.get('timestamp.json')!.bytes
    const adopted = importTimestamp({ state: s.signerState, roots: [s.root], bytes: served, now: s.now })!
    const second = localRelease(s.keys, s.rootBytes, adopted, '0.1.1', s.now)
    await resignTimestamp({ store: s.store, mark: new MemoryMark(), key: s.keys.timestamp, now: s.now })
    await expect(publishChannel(s.store, second.dir)).rejects.toThrow(PublishRefusal)
  })
})
