/**
 * The registry of Delorun's production trust material, `delorun/release/production-keys.json` (`delorun.production-keys/1`):
 * the SHA-256 of every production root file, the key id of every production root, targets and timestamp key, and the id
 * of every production log-entry key (the SHA-256 of its DER public key, `entryKeyId` of `log/entry-keys`). A local
 * release refuses any root, key, root role or listed log-entry key that the registry lists, so production keys never sign a release
 * that no second builder rebuilt. The owner fills the registry after the key ceremony; the package README states how.
 *
 * @module @delorun/release/local/production-keys
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KeyId, RootMetadata, Sha256Hex } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { parseStrictJson } from '@delorun/release-formats/sign/json'

/** The registry's `schema` value. */
export const PRODUCTION_KEYS_SCHEMA = 'delorun.production-keys/1'

/** The registry's path below the repository root. */
export const PRODUCTION_KEYS_PATH = join('delorun', 'release', 'production-keys.json')

/** The largest registry file the reader accepts, in bytes. */
const PRODUCTION_KEYS_LIMIT = 64 * 1024

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u)

const RegistrySchema = z.strictObject({
  schema: z.literal(PRODUCTION_KEYS_SCHEMA),
  roots: z.array(z.strictObject({ version: z.number().int().min(1), sha256: hex64 })),
  keyids: z.array(hex64),
})

/** The production trust material a local release refuses. */
export interface ProductionKeys {
  /** The SHA-256 of each production root file's bytes. */
  readonly rootDigests: ReadonlySet<Sha256Hex>
  /** The key id of each production root, targets and timestamp key, as root metadata lists it, and of each production log-entry key. */
  readonly keyids: ReadonlySet<KeyId>
}

/**
 * Read a production-keys registry.
 * @param bytes - the registry file's bytes.
 * @returns the listed root digests and key ids.
 * @throws Error when the file exceeds 64 KiB, is not strict JSON, has another `schema`, an unknown or missing field,
 *   a value that is not a positive root version or 64 lowercase hex digits, or lists a root version, root digest or
 *   key id twice.
 */
export function readProductionKeys(bytes: Uint8Array): ProductionKeys {
  const parsed = RegistrySchema.safeParse(parseStrictJson(bytes, PRODUCTION_KEYS_LIMIT))
  if (!parsed.success) throw new Error(`the production-keys registry does not read: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  const { roots, keyids } = parsed.data
  const repeated = (values: readonly (string | number)[]): string | number | undefined => values.find((value, index) => values.indexOf(value) !== index)
  for (const [what, values] of [['root version', roots.map(root => root.version)], ['root digest', roots.map(root => root.sha256)], ['key id', keyids]] as const) {
    const twice = repeated(values)
    if (twice !== undefined) throw new Error(`the production-keys registry lists the ${what} ${String(twice)} twice`)
  }
  return {
    rootDigests: new Set(roots.map(root => brandString<Sha256Hex>(root.sha256))),
    keyids: new Set(keyids.map(keyid => brandString<KeyId>(keyid))),
  }
}

/**
 * Read the registry file at a path.
 * @param path - the registry file, such as {@link PRODUCTION_KEYS_PATH} below the repository root.
 * @returns the listed root digests and key ids.
 * @throws Error when the file cannot be read, or as {@link readProductionKeys} throws.
 */
export function readProductionKeysFile(path: string): ProductionKeys {
  return readProductionKeys(readFileSync(path))
}

/**
 * Every key id a root lists: in each role, whatever the role's name, then in its `keys`, then each log-entry key's id
 * (the SHA-256 of its DER public key) in its `logEntryKeys`.
 * @param root - the root metadata.
 * @returns the key ids, each with where the root lists it.
 */
export function rootKeyIds(root: RootMetadata): Array<{ readonly keyid: KeyId, readonly where: string }> {
  const listed: Array<{ keyid: KeyId, where: string }> = []
  for (const [role, keys] of Object.entries(root.roles)) {
    const ids = 'keyids' in keys ? keys.keyids : keys.keys.map(key => key.keyid)
    for (const keyid of ids) listed.push({ keyid, where: `roles.${role}` })
  }
  for (const keyid of Object.keys(root.keys)) listed.push({ keyid: brandString<KeyId>(keyid), where: 'keys' })
  for (const [position, key] of (root.logEntryKeys ?? []).entries()) {
    listed.push({ keyid: brandString<KeyId>(createHash('sha256').update(Buffer.from(key.public, 'base64')).digest('hex')), where: `logEntryKeys[${String(position)}]` })
  }
  return listed
}
