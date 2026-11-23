/**
 * Reading a log-entry private key for the signing commands (contract C18): the key file is named on the command line
 * as `--log-entry-key <type>=<key.pem>`, never looked up at a default location, and only its path appears in a message.
 *
 * @module @delorun/release/log/key-file
 */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { entryPublicKey, isLogEntryKeyDetails, type LogEntrySigner } from '@delorun/release-formats/log/entry-keys'

/**
 * Read a `--log-entry-key` value: an entry key type and a private key file of that type's kind.
 * @param value - `<type>=<path>`.
 * @returns the signer.
 * @throws Error when the value has no `=`, names a type this tool does not implement, the file is readable by others
 *   than its owner, or it holds no private key of the type's kind.
 */
export function readLogEntryKey(value: string): LogEntrySigner {
  const split = value.indexOf('=')
  const keyDetails = split < 0 ? '' : value.slice(0, split)
  if (!isLogEntryKeyDetails(keyDetails)) throw new Error(`--log-entry-key ${JSON.stringify(value)} is not <type>=<key.pem> with type PKIX_ED25519_PH or PKIX_ECDSA_P256_SHA_256`)
  const path = resolve(value.slice(split + 1))
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8).padStart(4, '0')}; a signing key file must be readable by its owner only (chmod 600)`)
  const key = createPrivateKey(readFileSync(path))
  if (entryPublicKey(keyDetails, createPublicKey(key).export({ format: 'der', type: 'spki' })) === undefined) throw new Error(`${path} holds no ${keyDetails} private key`)
  return { keyDetails, key }
}
