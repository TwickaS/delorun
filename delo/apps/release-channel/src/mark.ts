/**
 * The re-signer's high-water mark: the highest timestamp version it has signed or seen verified, and each channel's
 * release at that time. It lives in storage that only the cron Worker is bound to (a Workers KV namespace), never in
 * the R2 bucket, because the S3 publish token can write the bucket. A bucket rolled back to an older signed
 * `timestamp.json` is therefore refused instead of re-signed with a fresh `issued`.
 *
 * @module @delo/release-channel/mark
 */
import semver from 'semver'

/** The channels the mark tracks. */
const CHANNELS = ['stable', 'beta'] as const

/** The highest timestamp the re-signer has seen. */
export interface HighWaterMark {
  /** The timestamp version. */
  readonly version: number
  /** The release each channel named in it, as semver text. */
  readonly channels: Readonly<Record<(typeof CHANNELS)[number], string>>
}

/** Where the mark is kept. */
export interface MarkStore {
  /**
   * Read the mark.
   * @returns the mark, or `undefined` before the first re-signing.
   */
  read(): Promise<HighWaterMark | undefined>
  /**
   * Replace the mark.
   * @param mark - the new mark.
   */
  write(mark: HighWaterMark): Promise<void>
}

/** The part of a Workers KV namespace binding the mark uses. */
export interface MarkNamespace {
  /**
   * Read a value.
   * @param key - the key.
   * @returns the text, or `null`.
   */
  get(key: string): Promise<string | null>
  /**
   * Write a value.
   * @param key - the key.
   * @param value - the text.
   */
  put(key: string, value: string): Promise<void>
}

const KEY = 'timestamp-high-water-mark'

/**
 * The mark over a KV namespace binding.
 * @param namespace - the binding.
 * @returns the store.
 */
export function kvMark(namespace: MarkNamespace): MarkStore {
  return {
    async read() {
      const text = await namespace.get(KEY)
      return text === null ? undefined : JSON.parse(text) as HighWaterMark
    },
    async write(mark) {
      await namespace.put(KEY, JSON.stringify(mark))
    },
  }
}

/**
 * Move the mark up to `next` without lowering it, tolerating a concurrent writer. Workers KV has no compare-and-swap,
 * so the function reads first (a mark already higher is kept), writes, and reads again: a lower mark means a writer
 * that read before this write replaced it, and the write is repeated. A writer that replaces the mark after the second
 * read with a value it computed before this write is not caught; the next cron run or publish sees the higher
 * timestamp in the bucket and moves the mark up again.
 * @param store - the mark.
 * @param next - the mark to keep at least.
 */
export async function raiseMark(store: MarkStore, next: HighWaterMark): Promise<void> {
  const before = await store.read()
  if (before !== undefined && before.version > next.version) return
  await store.write(next)
  const after = await store.read()
  if (after !== undefined && after.version < next.version) await store.write(next)
}

/**
 * Refuse a timestamp that lies below the mark.
 * @param mark - the stored mark, if any.
 * @param seen - the verified current timestamp's version and channel releases.
 * @throws Error when its version is lower than the mark's or any channel's release is lower than the mark's.
 */
export function checkAgainstMark(mark: HighWaterMark | undefined, seen: HighWaterMark): void {
  if (mark === undefined) return
  if (seen.version < mark.version) throw new Error(`the bucket's timestamp.json is version ${String(seen.version)}, below the re-signer's high-water mark ${String(mark.version)}; the bucket was rolled back, so nothing is re-signed`)
  for (const channel of CHANNELS) {
    if (semver.lt(seen.channels[channel], mark.channels[channel])) throw new Error(`the bucket's timestamp.json names ${channel} release ${seen.channels[channel]}, below the re-signer's high-water mark ${mark.channels[channel]}; the channel went backwards, so nothing is re-signed`)
  }
}
