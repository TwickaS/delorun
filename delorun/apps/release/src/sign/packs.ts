/**
 * Signing a release's packs file (contract C2): the release workflow writes `delorun-<version>.packs.json` unsigned,
 * naming every pack archive with its digests; signing binds it to the manifest by digest, checks each archive in the
 * release directory against the file, signs it with the targets key, and writes the log entry requests that a second
 * release-log record needs, one per log-entry key in the order the logging step tries them. A release with no packs file has no packs.
 *
 * @module @delorun/release/sign/packs
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { entryRequest } from '@delorun/release-formats/log/entry'
import type { LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
import { packsEntryName, packsName } from '@delorun/release-formats/log/bundle'

/** The files signing adds for the packs, by name. */
export type PackOutputs = ReadonlyArray<readonly [string, string | Buffer]>

/**
 * Sign the packs file of a release.
 * @param directory - the release directory.
 * @param version - the release version.
 * @param manifestBytes - the signed manifest file's bytes, whose SHA-256 the packs file names.
 * @param key - the targets private key.
 * @param signers - the log-entry keys that sign the packs file's entry requests, in the order the logging step tries
 *   them (`entrySigners` of `log/entry-keys`); the targets key as an Ed25519ph entry key by default.
 * @returns the signed packs file and its log entry requests, named by {@link packsEntryName} in that order, or nothing
 *   when the release has no packs file.
 * @throws Error when the file does not read, is for another release, or a pack archive it names is absent or differs
 * from its length or digests.
 */
export async function signPacks(directory: string, version: string, manifestBytes: Uint8Array, key: KeyObject, signers: readonly LogEntrySigner[] = [{ keyDetails: 'PKIX_ED25519_PH', key }]): Promise<PackOutputs> {
  const path = join(directory, packsName(version))
  if (!existsSync(path)) return []
  const draft = readEnvelope('packs', await readFile(path))
  if (draft.signed.version !== version) throw new Error(`${packsName(version)} is for ${draft.signed.version}`)
  const signed = { ...draft.signed, manifest: createHash('sha256').update(manifestBytes).digest('hex') }
  for (const pack of signed.packs) {
    for (const [platform, variant] of Object.entries(pack.variants)) {
      const archive = variant.archive
      const bytes = await readFile(join(directory, archive.name)).catch((error: unknown) => {
        throw new Error(`${pack.name} (${platform}) names ${archive.name}, which is not in ${directory}`, { cause: error })
      })
      if (bytes.byteLength !== archive.length || createHash('sha256').update(bytes).digest('hex') !== archive.sha256 || createHash('sha512').update(bytes).digest('base64') !== archive.sha512) {
        throw new Error(`${archive.name} does not match the packs file`)
      }
    }
  }
  const text = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [key]), undefined, 2)}\n`)
  readEnvelope('packs', text)
  const requests = signers.map((signer, position) => [packsEntryName(version, position), Buffer.from(`${JSON.stringify(entryRequest(text, signer.key, signer.keyDetails), undefined, 2)}\n`)] as const)
  return [[packsName(version), text], ...requests]
}
