/**
 * The timestamp re-signing: the next version continues the current one with the same channel entries, `issued` an
 * hour back and the contract's lifetime, and refuses, writing nothing, what does not verify.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TIMESTAMP_LIFETIME_SECONDS } from '@delo/contract-release-manifest'
import { readEnvelope } from '@delo/release-formats/sign/schemas'
import { trustRootChain, verifyTimestamp } from '@delo/release-formats/sign/verify'
import { resignTimestamp, timestampKey } from '../src/resign-core.ts'
import { FIRST, signedChannel, storeWith } from './support.ts'

const DAY = 86_400

describe('timestamp re-signing', () => {
  it('writes version + 1 with the same channels, issued an hour before now and the contract lifetime', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const now = FIRST + DAY
    const result = await resignTimestamp({ store, key: channel.keys.timestamp, now })
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
    const result = await resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST + 10 * DAY })
    expect(result).toMatchObject({ outcome: 'resigned', version: 2 })
  })

  it('refuses a current timestamp signed by another key and writes nothing', async () => {
    const channel = signedChannel({ signer: generateKeyPairSync('ed25519').privateKey })
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST + DAY })).rejects.toThrow(/timestamp/u)
    expect(store.writes).toEqual([])
  })

  it('refuses a current timestamp whose lifetime is not the contract lifetime', async () => {
    const channel = signedChannel({ lifetime: 100 })
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST + 60 })).rejects.toThrow(/exactly/u)
    expect(store.writes).toEqual([])
  })

  it('refuses a key that is not a timestamp key of the root, before it writes', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    await expect(resignTimestamp({ store, key: generateKeyPairSync('ed25519').privateKey, now: FIRST + DAY })).rejects.toThrow(/timestamp/u)
    expect(store.writes).toEqual([])
  })

  it('refuses when the bucket holds no timestamp or no root', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    store.objects.delete('root/1.root.json')
    await expect(resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST })).rejects.toThrow(/no root/u)
    store.objects.delete('timestamp.json')
    await expect(resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST })).rejects.toThrow(/no timestamp\.json/u)
  })

  it('leaves a racing publish in place and reports the race', async () => {
    const channel = signedChannel()
    const store = storeWith(channel)
    const racing = Buffer.from('published by a release')
    store.beforeWrite = key => { if (key === 'timestamp.json') store.force(key, racing) }
    const result = await resignTimestamp({ store, key: channel.keys.timestamp, now: FIRST + DAY })
    expect(result).toEqual({ outcome: 'raced' })
    expect(store.objects.get('timestamp.json')!.bytes).toEqual(racing)
  })

  it('reads the timestamp key as an Ed25519 PEM and refuses anything else', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(timestampKey(pem).asymmetricKeyType).toBe('ed25519')
    expect(() => timestampKey(undefined)).toThrow(/not set/u)
    expect(() => timestampKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).toThrow(/Ed25519/u)
  })
})
