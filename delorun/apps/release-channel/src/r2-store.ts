/**
 * {@link ReplaceStore} over a Worker's R2 bucket binding, for the cron Worker. It reads objects and replaces one key
 * through R2's conditional put; the public Worker uses the narrower {@link ReadOnlyBucket} and never writes.
 *
 * @module @delorun/release-channel/r2-store
 */
import type { ReplaceStore, StoredObject } from './store.ts'

/** The part of an R2 object the stores read. */
export interface R2ObjectLike {
  /** The entity tag. */
  readonly etag: string
  /** The object's size in bytes. */
  readonly size: number
  /** The object's bytes. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/** The part of an R2 bucket binding the cron Worker uses. */
export interface WritableBucket {
  /**
   * Read an object.
   * @param key - the object key.
   * @returns the object, or `null`.
   */
  get(key: string): Promise<R2ObjectLike | null>
  /**
   * List objects.
   * @param options - the prefix and cursor.
   * @returns one page of keys.
   */
  list(options: { prefix: string, cursor?: string }): Promise<{ objects: readonly { key: string }[], truncated: boolean, cursor?: string }>
  /**
   * Write an object only when the condition holds.
   * @param key - the object key.
   * @param value - the content.
   * @param options - the condition.
   * @returns the written object, or `null` when the condition failed.
   */
  put(key: string, value: Uint8Array, options: { onlyIf: { etagMatches: string } }): Promise<unknown>
}

/**
 * The store over an R2 bucket binding.
 * @param bucket - the binding.
 * @returns the store.
 */
export function r2Store(bucket: WritableBucket): ReplaceStore {
  return {
    async read(key): Promise<StoredObject | undefined> {
      const object = await bucket.get(key)
      return object === null ? undefined : { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag }
    },
    async list(prefix) {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor })
        keys.push(...page.objects.map(object => object.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
      return keys
    },
    async putIfMatch(key, bytes, etag) {
      return await bucket.put(key, bytes, { onlyIf: { etagMatches: etag } }) !== null
    },
  }
}
