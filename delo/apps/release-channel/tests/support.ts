/**
 * Test support: an in-memory object store with R2's conditional-write semantics, and a signed channel over throwaway
 * keys.
 */
import { createHash, type KeyObject } from 'node:crypto'
import { RELEASE_SCHEMAS, type ReleaseChannel, type TimestampMetadata, type UtcTimestamp } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { signEnvelope } from '@delo/release-formats/sign/envelope'
import { toJsonValue } from '@delo/release-formats/sign/json'
import { sha256Hex } from '@delo/release-formats/brands'
import { trustRootChain } from '@delo/release-formats/sign/verify'
import { manifestContent, rootFile, throwawayKeys, type Keys } from '@delo/release/tests/sign/fixture'
import type { PublishStore, StoredObject } from '../src/store.ts'

/** A store in memory. `beforeWrite` runs before each conditional write evaluates, to stage a racing writer. */
export class MemoryStore implements PublishStore {
  readonly objects = new Map<string, StoredObject>()
  readonly writes: string[] = []
  beforeWrite: ((key: string) => void) | undefined
  private counter = 0

  /**
   * Put bytes unconditionally, as another writer would.
   * @param key - the key.
   * @param bytes - the content.
   */
  force(key: string, bytes: Uint8Array): void {
    this.counter += 1
    this.objects.set(key, { bytes, etag: `etag-${String(this.counter)}` })
  }

  async read(key: string): Promise<StoredObject | undefined> {
    return this.objects.get(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix))
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    this.beforeWrite?.(key)
    if (this.objects.has(key)) return false
    this.force(key, bytes)
    this.writes.push(key)
    return true
  }

  async putIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<boolean> {
    this.beforeWrite?.(key)
    if (this.objects.get(key)?.etag !== etag) return false
    this.force(key, bytes)
    this.writes.push(key)
    return true
  }
}

/** The signing time of the fixture's first timestamp. */
export const FIRST = Date.parse('2026-11-06T12:00:00Z') / 1000

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

/** A channel's signed metadata over throwaway keys. */
export interface SignedChannel {
  readonly keys: Keys
  readonly rootBytes: Buffer
  readonly timestamp: { readonly metadata: TimestampMetadata, readonly bytes: Buffer }
}

/**
 * Sign root 1 and a first timestamp that names it.
 * @param options - the keys (throwaway by default), the timestamp's lifetime in seconds (3 days by default) and its signing key.
 * @returns the root and timestamp.
 */
export function signedChannel(options: { keys?: Keys, lifetime?: number, signer?: KeyObject, version?: number } = {}): SignedChannel {
  const keys = options.keys ?? throwawayKeys()
  const { bytes: rootBytes } = rootFile(keys)
  const root = trustRootChain([rootBytes], FIRST).at(-1)!
  const manifest = Buffer.from('manifest bytes')
  const pointer = { release: brandString<TimestampMetadata['channels']['stable']['release']>('0.1.0'), manifest: { name: 'delorun-0.1.0.manifest.json', length: manifest.byteLength, sha256: sha256Hex(createHash('sha256').update(manifest).digest('hex')) } }
  const channels: Record<ReleaseChannel, typeof pointer> = { stable: pointer, beta: pointer }
  const metadata: TimestampMetadata = {
    schema: RELEASE_SCHEMAS.timestamp,
    version: options.version ?? 1,
    issued: utc(FIRST),
    expires: utc(FIRST + (options.lifetime ?? 259_200)),
    root: { version: 1, sha256: root.sha256 },
    channels,
  }
  const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(metadata), signatures: [] }, [options.signer ?? keys.timestamp]), undefined, 2)}\n`)
  return { keys, rootBytes, timestamp: { metadata, bytes } }
}

/**
 * A store holding the channel's root and timestamp.
 * @param channel - the signed channel.
 * @returns the store.
 */
export function storeWith(channel: SignedChannel): MemoryStore {
  const store = new MemoryStore()
  store.force('root/1.root.json', channel.rootBytes)
  store.force('timestamp.json', channel.timestamp.bytes)
  return store
}

export { manifestContent }
