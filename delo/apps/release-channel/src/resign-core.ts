/**
 * Timestamp re-signing (contract C2, timestamp metadata). It reads the current `timestamp.json`, verifies it under the
 * root chain stored beside it, and writes the next one: version + 1, the same channel entries, `issued` one hour
 * before now and the contract's lifetime after it. It signs only what the current timestamp already names, so a holder
 * of the timestamp key keeps a release current but forges none.
 *
 * The cron Worker calls {@link resignTimestamp} daily with the timestamp key as a Worker secret, and `resign.ts` runs
 * it from a command line. This module imports nothing that only the command line needs, so the Worker bundle omits it.
 *
 * @module @delo/release-channel/resign-core
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { signEnvelope } from '@delo/release-formats/sign/envelope'
import { toJsonValue } from '@delo/release-formats/sign/json'
import { verifyTimestamp, walkRootChain } from '@delo/release-formats/sign/verify'
import { resignedTimestamp } from '@delo/release/sign/timestamp'
import type { ReplaceStore } from './store.ts'

/** The result of one re-signing attempt. */
export type ResignOutcome =
  | { readonly outcome: 'resigned', readonly version: number, readonly expires: string }
  /** Another writer replaced `timestamp.json` after it was read; that write stands and the next run retries. */
  | { readonly outcome: 'raced' }

/**
 * Re-sign the current timestamp.
 * @param request - the store, the timestamp private key and the time in Unix seconds.
 * @returns the outcome.
 * @throws Error when no timestamp or root is stored, the roots do not chain, the current timestamp does not verify
 * under the newest root (a bad signature, a root other than the newest, or a lifetime other than the contract's), or
 * the key is not one of the root's timestamp keys; nothing is written in these cases.
 */
export async function resignTimestamp(request: { readonly store: ReplaceStore, readonly key: KeyObject, readonly now: number }): Promise<ResignOutcome> {
  const { store, key, now } = request
  const current = await store.read('timestamp.json')
  if (current === undefined) throw new Error('the bucket holds no timestamp.json to re-sign; the first timestamp is signed with sign-timestamp.ts')
  const numbered = (await store.list('root/')).map(name => /^root\/([1-9][0-9]*)\.root\.json$/u.exec(name)).filter(match => match !== null).map(match => ({ name: match[0], version: Number(match[1]) }))
  if (numbered.length === 0) throw new Error('the bucket holds no root/<n>.root.json')
  numbered.sort((a, b) => a.version - b.version)
  const files = await Promise.all(numbered.map(async ({ name }) => (await store.read(name))?.bytes ?? Promise.reject(new Error(`${name} disappeared while it was read`))))
  const chain = walkRootChain(files)
  const root = chain.at(-1)!
  // The current timestamp may be past its expiry after a missed run; its signature and lifetime still hold.
  const previous = verifyTimestamp(root, current.bytes, now, undefined, { allowExpired: true })
  const content = resignedTimestamp(previous, now)
  const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
  // Verifying the new file also proves the key is one of the root's timestamp keys.
  verifyTimestamp(root, bytes, now)
  if (!await store.putIfMatch('timestamp.json', bytes, current.etag)) return { outcome: 'raced' }
  return { outcome: 'resigned', version: content.version, expires: content.expires }
}

/**
 * Read the timestamp private key.
 * @param pem - the PKCS #8 PEM text.
 * @returns the key.
 * @throws Error when the text holds no Ed25519 private key.
 */
export function timestampKey(pem: string | undefined): KeyObject {
  if (pem === undefined || pem === '') throw new Error('the timestamp key is not set')
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the timestamp key is not an Ed25519 key')
  return key
}
