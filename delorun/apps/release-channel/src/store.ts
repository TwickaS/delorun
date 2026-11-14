/**
 * The object store the channel's commands write to and read from, as three operations over R2: the Worker binding the
 * cron Worker uses and the S3 API the CLI commands use. Both stores make every write conditional.
 *
 * @module @delorun/release-channel/store
 */

/** An object read from the store. */
export interface StoredObject {
  /** The object's bytes. */
  readonly bytes: Uint8Array
  /** The object's entity tag, as the store reports it. */
  readonly etag: string
}

/** What the re-signing needs of the store. */
export interface ReplaceStore {
  /**
   * Read one object.
   * @param key - the object key.
   * @returns the object, or `undefined` when no such key exists.
   */
  read(key: string): Promise<StoredObject | undefined>
  /**
   * List the keys below a prefix.
   * @param prefix - the key prefix.
   * @returns every key that starts with it.
   */
  list(prefix: string): Promise<string[]>
  /**
   * Replace an object only while it still has the entity tag that was read.
   * @param key - the object key.
   * @param bytes - the new content.
   * @param etag - the entity tag the caller read.
   * @returns whether the write happened; `false` when another writer changed the object first.
   */
  putIfMatch(key: string, bytes: Uint8Array, etag: string): Promise<boolean>
}

/** What publishing needs of the store: {@link ReplaceStore} and create-only writes. */
export interface PublishStore extends ReplaceStore {
  /**
   * Create an object only when no object has the key.
   * @param key - the object key.
   * @param bytes - the content.
   * @returns whether the write happened; `false` when the key already exists.
   */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>
}
