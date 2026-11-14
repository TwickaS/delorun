/**
 * The timestamp re-signing: the next version continues the current one with the same channel entries, `issued` an
 * hour back and the contract's lifetime, and refuses, writing nothing, what does not verify.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TIMESTAMP_LIFETIME_SECONDS } from '@delorun/contract-release-manifest'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { rootFile } from '@delorun/release/tests/sign/fixture'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { resignTimestamp, timestampKey } from '../src/resign-core.ts'
import { FIRST, MemoryMark, signedChannel, storeWith } from './support.ts'

const DAY = 86_400

describe('timestamp re-signing', () => {
  it('writes version + 1 with the same channels, issued an hour before now and the contract lifetime', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const now = FIRST + DAY
    const result = await resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now })
    expect(result).toMatchObject({ outcome: 'resigned', version: 2 })
    const bytes = store.objects.get('timestamp.json')!.bytes
    const written = readEnvelope('timestamp', bytes).signed
    expect(written.channels).toEqual(channel.timestamp.metadata.channels)
    expect(written.root).toEqual(channel.timestamp.metadata.root)
    expect(Date.parse(written.issued) / 1000).toBe(now - 3600)
    expect(Date.parse(written.expires) / 1000 - Date.parse(written.issued) / 1000).toBe(TIMESTAMP_LIFETIME_SECONDS)
    const root = trustRootChain([channel.rootBytes], now).at(-1)!
    expect(verifyTimestamp(root, bytes, now).version).toBe(2)
  })

  it('continues a timestamp that expired while the schedule was down', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const result = await resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + 10 * DAY })
    expect(result).toMatchObject({ outcome: 'resigned', version: 2 })
  })

  it('refuses a root whose timestamp threshold is above 1, before it writes', async () => {
    const channel = signedChannel()
    const trusted = trustRootChain([channel.rootBytes], FIRST).at(-1)!.metadata
    const second = publicKeyEntry(generateKeyPairSync('ed25519').privateKey)
    const { bytes } = rootFile(channel.keys, { keys: { ...trusted.keys, [second.keyid]: second.entry }, roles: { ...trusted.roles, timestamp: { keyids: [...trusted.roles.timestamp.keyids, second.keyid], threshold: 2 } } })
    const store = storeWith({ ...channel, rootBytes: bytes })
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + DAY })).rejects.toThrow(/requires 2 timestamp signatures/u)
    expect(store.writes).toEqual([])
  })

  it('refuses a current timestamp signed by another key and writes nothing', async () => {
    const channel = signedChannel({ signer: generateKeyPairSync('ed25519').privateKey })
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + DAY })).rejects.toThrow(/timestamp/u)
    expect(store.writes).toEqual([])
  })

  it('refuses a current timestamp whose lifetime is not the contract lifetime', async () => {
    const channel = signedChannel({ lifetime: 100 })
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + 60 })).rejects.toThrow(/exactly/u)
    expect(store.writes).toEqual([])
  })

  it('refuses a key that is not a timestamp key of the root, before it writes', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: generateKeyPairSync('ed25519').privateKey, now: FIRST + DAY })).rejects.toThrow(/timestamp/u)
    expect(store.writes).toEqual([])
  })

  it('refuses when the bucket holds no timestamp or no root', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    store.objects.delete('root/1.root.json')
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST })).rejects.toThrow(/no root/u)
    store.objects.delete('timestamp.json')
    await expect(resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST })).rejects.toThrow(/no timestamp\.json/u)
  })

  it('leaves a racing publish in place and reports the race', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const racing = Buffer.from('published by a release')
    store.beforeWrite = key => { if (key === 'timestamp.json') store.force(key, racing) }
    const result = await resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + DAY })
    expect(result).toEqual({ outcome: 'raced' })
    expect(store.objects.get('timestamp.json')!.bytes).toEqual(racing)
  })

  it('refuses a bucket rolled back below the high-water mark and writes nothing', async () => {
    const channel = signedChannel({ version: 3 })
    const store = storeWith(channel)
    const mark = new MemoryMark()
    mark.value = { version: 9, channels: { stable: '0.1.0', beta: '0.1.0' } }
    await expect(resignTimestamp({ store, mark, key: channel.keys.timestamp, now: FIRST + DAY })).rejects.toThrow(/below the re-signer's high-water mark 9.*rolled back/u)
    expect(store.writes).toEqual([])
    expect(mark.writes).toEqual([])
  })

  it('refuses a channel that names a lower release than the mark', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const mark = new MemoryMark()
    mark.value = { version: 1, channels: { stable: '0.2.0', beta: '0.1.0' } }
    await expect(resignTimestamp({ store, mark, key: channel.keys.timestamp, now: FIRST + DAY })).rejects.toThrow(/stable release 0\.1\.0, below .* 0\.2\.0/u)
    expect(store.writes).toEqual([])
  })

  it('records the mark after a write, learns a higher published version, and accepts the version it wrote', async () => {
    const channel = signedChannel({ version: 5 })
    const store = storeWith(channel)
    const mark = new MemoryMark()
    mark.value = { version: 2, channels: { stable: '0.1.0', beta: '0.1.0' } }
    await resignTimestamp({ store, mark, key: channel.keys.timestamp, now: FIRST + DAY })
    expect(mark.value).toEqual({ version: 6, channels: { stable: '0.1.0', beta: '0.1.0' } })
    await resignTimestamp({ store, mark, key: channel.keys.timestamp, now: FIRST + 2 * DAY })
    expect(mark.value.version).toBe(7)
  })

  it('does not move the mark when a publish wins the race', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const mark = new MemoryMark()
    store.beforeWrite = key => { if (key === 'timestamp.json') store.force(key, Buffer.from('published')) }
    expect(await resignTimestamp({ store, mark, key: channel.keys.timestamp, now: FIRST + DAY })).toEqual({ outcome: 'raced' })
    expect(mark.writes).toEqual([])
  })

  it('re-signs a current timestamp with a channel key it does not know, keeping that key byte-identical', async () => {
    const channel = signedChannel({ extra: { nightly: { release: '0.2.0-nightly.1' } } })
    const store = storeWith(channel)
    await resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + DAY })
    const after = JSON.parse(Buffer.from(store.objects.get('timestamp.json')!.bytes).toString()).signed
    const before = JSON.parse(Buffer.from(channel.timestamp.bytes).toString()).signed
    expect(JSON.stringify(after.nightly ?? after.channels)).toBe(JSON.stringify(before.nightly ?? before.channels))
    expect(Object.keys(after)).toEqual(Object.keys(before))
  })

  it('re-signs from the signed JSON: every field but version, issued and expires is byte-identical', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    await resignTimestamp({ store, mark: new MemoryMark(), key: channel.keys.timestamp, now: FIRST + DAY })
    const before = JSON.parse(Buffer.from(channel.timestamp.bytes).toString()).signed
    const after = JSON.parse(Buffer.from(store.objects.get('timestamp.json')!.bytes).toString()).signed
    expect(JSON.stringify(after.channels)).toBe(JSON.stringify(before.channels))
    expect(Object.keys(after)).toEqual(Object.keys(before))
    const { version, issued, expires, ...rest } = after
    const { version: _version, issued: _issued, expires: _expires, ...beforeRest } = before
    expect(JSON.stringify(rest)).toBe(JSON.stringify(beforeRest))
    expect([version, issued === before.issued, expires === before.expires]).toEqual([2, false, false])
  })

  it('reads the timestamp key as an Ed25519 PEM and refuses anything else', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(timestampKey(pem).asymmetricKeyType).toBe('ed25519')
    expect(() => timestampKey(undefined)).toThrow(/not set/u)
    expect(() => timestampKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).toThrow(/Ed25519/u)
  })
})
