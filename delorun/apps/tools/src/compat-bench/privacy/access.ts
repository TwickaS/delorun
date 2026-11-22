/**
 * The optional `dsh.access` block of a plugin's `package.json` (A553, shape approved as A600): the author's own
 * statement of what the plugin does with the things the eight markers cover. `version` is `1`; each marker key is
 * either `false` (the author says the plugin does not do this) or an object with a `why` (and fields the install
 * screen and the standards stage read); a missing key means "not declared". The bench never trusts the block to hide
 * anything: what it sees is shown either way, a seen item that is not declared is a finding, and a key set to `false`
 * that the bench sees is a finding too.
 *
 * ```json
 * { "dsh": { "access": {
 *   "version": 1,
 *   "sendsOut": { "hosts": [{ "host": "example.com", "carries": ["none"], "why": "Fetches the page you ask for." }], "why": "Fetches the page you ask for." },
 *   "actsForYou": { "actions": ["runs-commands"], "why": "Runs `git` to read the repository's history." },
 *   "opensADoor": false
 * } } }
 * ```
 *
 * The bench reads only `version`, the keys, `why` and the host names under `sendsOut`; it does not validate the other
 * fields (the standards stage does).
 *
 * @module @delorun/tools/compat-bench/privacy/access
 */
import { MARKER_KEYS } from './types.ts'
import type { MarkerKey } from './types.ts'

/** The longest `why` the bench keeps; a longer one is cut, with a problem noted. */
export const MAX_REASON_LENGTH = 200

/** The one block version the bench reads. */
export const ACCESS_VERSION = 1

/** What the author said about one marker. */
export type DeclaredItem = Readonly<{
  /** `false` in the block: the author says the plugin does not do this. */
  does: boolean
  /** The author's short reason; empty when `does` is false. */
  why: string
  /** The host names listed under `sendsOut.hosts` (`model-provider` stands for the person's configured provider). */
  hosts?: ReadonlyArray<string>
}>

/** The result of reading a manifest's access block. */
export type DeclaredAccess = Readonly<{
  /** What the author said, by marker. */
  declared: Readonly<Partial<Record<MarkerKey, DeclaredItem>>>
  /** What is wrong with the block, in plain English; empty when it is well formed or absent. */
  problems: ReadonlyArray<string>
}>

/**
 * @param value - a value from the block.
 * @returns whether it is a plain object.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read `dsh.access` from a parsed `package.json`.
 * @param manifest - the parsed manifest, or anything else when it could not be read.
 * @returns what the author said, and the problems found.
 */
export function readDeclaredAccess(manifest: unknown): DeclaredAccess {
  if (!isRecord(manifest) || !isRecord(manifest.dsh) || !('access' in manifest.dsh)) return { declared: {}, problems: [] }
  const access = manifest.dsh.access
  if (!isRecord(access)) return { declared: {}, problems: ['dsh.access is not an object'] }
  if ('version' in access && access.version !== ACCESS_VERSION) return { declared: {}, problems: [`dsh.access.version is ${JSON.stringify(access.version)}; the bench reads version ${ACCESS_VERSION} only, so the block is ignored`] }
  const declared: Partial<Record<MarkerKey, DeclaredItem>> = {}
  const problems: string[] = []
  if (!('version' in access)) problems.push(`dsh.access.version is missing (it is ${ACCESS_VERSION})`)
  for (const [key, value] of Object.entries(access)) {
    if (key === 'version') continue
    if (!(MARKER_KEYS as readonly string[]).includes(key)) {
      problems.push(`dsh.access.${key} is not one of: ${MARKER_KEYS.join(', ')}`)
      continue
    }
    const marker = key as MarkerKey
    if (value === false) {
      declared[marker] = { does: false, why: '' }
      continue
    }
    if (!isRecord(value) || typeof value.why !== 'string' || value.why.trim() === '') {
      problems.push(`dsh.access.${key} is false or an object with a short "why" as a string`)
      continue
    }
    const why = value.why.trim().replace(/\s+/g, ' ')
    if (why.length > MAX_REASON_LENGTH) problems.push(`dsh.access.${key}.why is longer than ${MAX_REASON_LENGTH} characters; the card keeps the first ${MAX_REASON_LENGTH}`)
    const hosts = marker === 'sendsOut' ? readHosts(value.hosts, problems) : undefined
    declared[marker] = { does: true, why: why.slice(0, MAX_REASON_LENGTH), ...hosts === undefined ? {} : { hosts } }
  }
  return { declared, problems }
}

/**
 * @param value - `dsh.access.sendsOut.hosts`.
 * @param problems - where to note what is wrong.
 * @returns the host names, or undefined when there is no usable list.
 */
function readHosts(value: unknown, problems: string[]): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push('dsh.access.sendsOut.hosts is not a list')
    return undefined
  }
  const names: string[] = []
  for (const entry of value as ReadonlyArray<unknown>) {
    if (isRecord(entry) && typeof entry.host === 'string' && entry.host.trim() !== '') names.push(entry.host.trim().toLowerCase())
    else problems.push('dsh.access.sendsOut.hosts has an entry with no "host" name')
  }
  return names
}
