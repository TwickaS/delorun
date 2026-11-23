/**
 * Writes the draft of a root's signed content (contract C2, root metadata) from public key files, for `sign-root.ts`
 * to sign in the owner's ceremony:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/draft-root.ts --version <n> --root-key <root.pub.pem>...
 * --targets-key <targets.pub.pem> --timestamp-key <timestamp.pub.pem> --catalogue-key <catalogue.pub.pem>
 * --log-origin <origin> --log-vkey <vkey> [--earlier-log <last release>=<vkey>]... --log-entry-key <type>=<public.pem>...
 * --witness <vkey>... [--witness-threshold <n>] [--root-threshold <n>] [--issued <YYYY-MM-DDTHH:MM:SSZ>] [--days <n>]
 * --out <draft.json>`
 *
 * Each key file is an Ed25519 public key in a PEM file (`openssl pkey -pubout`); a private key file is refused, so
 * the draft step never reads private key material. Each role's key ids are the SHA-256 of the raw public keys, the
 * targets key is the one `active` targets key, `--issued` is the current time to the second by default, and
 * `expires` is `--days` (365 by default, the most C2 allows) after it. The log verifier key and each witness verifier key must
 * parse as C2SP signed-note verifier keys, and the witness's name is the name its key carries. The draft is written
 * only when it reads as root metadata, never over an existing file.
 *
 * `--log-entry-key` lists a key trusted to sign release log entries, with its entry key type (`PKIX_ED25519_PH` or
 * `PKIX_ECDSA_P256_SHA_256`), as an `active` entry of `logEntryKeys` in the order given, which is the order the signing
 * tool tries them in; at least one is required, because a root without the list verifies no release. `logs` lists the
 * current log first, then each `--earlier-log`: a log whose checkpoints still verify the bundles of releases logged
 * there, such as a previous Rekor shard, under the name its key carries, with the last release it may hold as its
 * `lastRelease`, so only the current log takes new releases.
 * A rotation's draft repeats every key of the root before it that it keeps.
 *
 * @module @delorun/release/draft-root
 */
import { createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RELEASE_SCHEMAS, ROOT_MAX_LIFETIME_DAYS, type ListedLog, type LogEntryKey, type RootMetadata, type SemanticVersion, type UtcTimestamp } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { entryPublicKey, isLogEntryKeyDetails } from '@delorun/release-formats/log/entry-keys'
import { parseVerifier } from '@delorun/release-formats/log/note'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { RootSchema } from '@delorun/release-formats/sign/schemas'
import semver from 'semver'

/** The command's options. */
const OPTIONS = {
  'version': { type: 'string', default: '1' },
  'root-key': { type: 'string', multiple: true },
  'root-threshold': { type: 'string', default: '1' },
  'targets-key': { type: 'string' },
  'timestamp-key': { type: 'string' },
  'catalogue-key': { type: 'string' },
  'log-origin': { type: 'string' },
  'log-vkey': { type: 'string' },
  'earlier-log': { type: 'string', multiple: true },
  'log-entry-key': { type: 'string', multiple: true },
  'witness': { type: 'string', multiple: true },
  'witness-threshold': { type: 'string', default: '1' },
  'issued': { type: 'string' },
  'days': { type: 'string', default: String(ROOT_MAX_LIFETIME_DAYS) },
  'out': { type: 'string' },
} as const

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u

/**
 * Read an Ed25519 public key from a PEM file.
 * @param path - the file.
 * @returns the key id and the root metadata's key entry.
 * @throws Error when the file holds a private key or no Ed25519 public key.
 */
function publicKeyFile(path: string): ReturnType<typeof publicKeyEntry> {
  const text = readFileSync(resolve(path), 'utf8')
  if (text.includes('PRIVATE KEY')) throw new Error(`${path} holds a private key; pass the public key (openssl pkey -in <key> -pubout)`)
  return publicKeyEntry(createPublicKey(text))
}

/**
 * Read an `--earlier-log` value: the last release the log may hold and its verifier key.
 * @param value - `<last release>=<vkey>`.
 * @returns the listed log.
 * @throws Error when the value has no `=` or its last release is not a semantic version written as `semver` writes it.
 */
function earlierLog(value: string): ListedLog {
  const split = value.indexOf('=')
  const lastRelease = split < 0 ? '' : value.slice(0, split)
  if (semver.valid(lastRelease) !== lastRelease) throw new Error(`--earlier-log ${JSON.stringify(value)} is not <last release>=<vkey> with a semantic version as the last release`)
  const vkey = value.slice(split + 1)
  return { origin: parseVerifier(vkey).name, vkey, lastRelease: brandString<SemanticVersion>(lastRelease) }
}

/**
 * Read a `--log-entry-key` value as an `active` log-entry key.
 * @param value - `<type>=<public.pem>`.
 * @returns the root metadata's log-entry key entry.
 * @throws Error when the value has no `=`, names a type this tool does not implement, the file holds a private key, or
 *   its public key is not of the type's kind.
 */
function logEntryKeyFile(value: string): LogEntryKey {
  const split = value.indexOf('=')
  const keyDetails = split < 0 ? '' : value.slice(0, split)
  if (!isLogEntryKeyDetails(keyDetails)) throw new Error(`--log-entry-key ${JSON.stringify(value)} is not <type>=<public.pem> with type PKIX_ED25519_PH or PKIX_ECDSA_P256_SHA_256`)
  const path = value.slice(split + 1)
  const text = readFileSync(resolve(path), 'utf8')
  if (text.includes('PRIVATE KEY')) throw new Error(`${path} holds a private key; pass the public key (openssl pkey -in <key> -pubout)`)
  const der = createPublicKey(text).export({ format: 'der', type: 'spki' })
  if (entryPublicKey(keyDetails, der) === undefined) throw new Error(`${path} holds no ${keyDetails} public key`)
  return { keyDetails, public: der.toString('base64'), status: 'active' }
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} ${value} is not a positive integer`)
  return number
}

function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(`${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`)
}

/**
 * Compose a root draft.
 * @param argv - the arguments after the script.
 * @param now - the current time in Unix seconds, the default `issued`.
 * @returns the draft.
 * @throws Error when an argument is missing or invalid, or the draft is not root metadata.
 */
export function draftRoot(argv: readonly string[], now: number): RootMetadata {
  const { values } = parseArgs({ args: [...argv], strict: true, options: OPTIONS })
  const required = [values['root-key'], values['targets-key'], values['timestamp-key'], values['catalogue-key'], values['log-origin'], values['log-vkey'], values.witness]
  if (required.includes(undefined) || values['log-entry-key'] === undefined) throw new Error('pass --root-key, --targets-key, --timestamp-key, --catalogue-key, --log-origin, --log-vkey, at least one --witness and at least one --log-entry-key')
  const issuedText = values.issued ?? utc(now)
  if (!UTC.test(issuedText)) throw new Error(`--issued ${issuedText} is not a UTC time such as 2026-11-11T00:00:00Z`)
  const issued = Date.parse(issuedText) / 1000
  const days = positiveInteger('days', values.days)
  if (days > ROOT_MAX_LIFETIME_DAYS) throw new Error(`--days ${values.days} is above the ${String(ROOT_MAX_LIFETIME_DAYS)} days a root may live`)
  const logOrigin = values['log-origin']!
  const logVerifier = parseVerifier(values['log-vkey']!)
  if (logVerifier.name !== logOrigin) throw new Error(`--log-vkey names ${logVerifier.name}, not the log origin ${logOrigin}`)
  const roots = values['root-key']!.map(publicKeyFile)
  const [targets, timestamp, catalogue] = [values['targets-key']!, values['timestamp-key']!, values['catalogue-key']!].map(publicKeyFile)
  const metadata: RootMetadata = {
    schema: RELEASE_SCHEMAS.root,
    version: positiveInteger('version', values.version),
    issued: utc(issued),
    expires: utc(issued + days * 86_400),
    keys: Object.fromEntries([...roots, targets!, timestamp!, catalogue!].map(key => [key.keyid, key.entry])),
    roles: {
      root: { keyids: roots.map(key => key.keyid), threshold: positiveInteger('root-threshold', values['root-threshold']) },
      targets: { keys: [{ keyid: targets!.keyid, status: 'active' }], threshold: 1 },
      timestamp: { keyids: [timestamp!.keyid], threshold: 1 },
      catalogue: { keyids: [catalogue!.keyid], threshold: 1 },
    },
    log: { origin: logOrigin, vkey: values['log-vkey']! },
    logs: [{ origin: logOrigin, vkey: values['log-vkey']! }, ...(values['earlier-log'] ?? []).map(earlierLog)],
    logEntryKeys: values['log-entry-key'].map(logEntryKeyFile),
    witnesses: { keys: values.witness!.map(vkey => ({ name: parseVerifier(vkey).name, vkey })), threshold: positiveInteger('witness-threshold', values['witness-threshold']) },
  }
  const checked = RootSchema.safeParse(metadata)
  if (!checked.success) throw new Error(`the draft is not root metadata: ${checked.error.message}`)
  return metadata
}

function main(argv: readonly string[]): number {
  try {
    const { out } = parseArgs({ args: [...argv], strict: true, options: OPTIONS }).values
    if (out === undefined) throw new Error('pass --out <draft.json>')
    const draft = draftRoot(argv, Math.floor(Date.now() / 1000))
    writeFileSync(resolve(out), `${JSON.stringify(toJsonValue(draft), undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
    console.log(`draft-root: wrote the draft of root version ${String(draft.version)}, expiring ${draft.expires}, to ${out}`)
    return 0
  } catch (error) {
    console.error(`draft-root: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
