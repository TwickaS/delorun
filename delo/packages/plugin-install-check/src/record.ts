/**
 * The records the install check keeps under a profile, in `delo-plugin-installs/` beside upstream's profile files, at
 * mode 0600 in a 0700 directory:
 *
 * - `records/<name>.json`, one {@link InstallRecord} per installed plugin (`/` of a scoped name as `+`): the source,
 *   version and integrity or commit it was installed from, the findings shown at its installation, the advisories the
 *   person allowed, the lockfile entries it brought, and the SHA-256 of each file of each package of its closure;
 * - `trust.json`, the {@link PluginTrustStatus} of the last check of the installed plugins against their records,
 *   which a start writes after its quick check and `delorun verify` after its full check.
 *
 * A record that is a link, not a regular file, larger than its limit, or not exactly a record reads as absent: the
 * plugin is then `unrecorded`, never `unchanged`. The records hold no secret; a process that can rewrite them can also
 * rewrite the plugin itself, so they detect a change made through another path (an edited store, a hand edit, a
 * package operation outside Delo), not one made by code that runs as the person.
 *
 * @module @delo/plugin-install-check/record
 */
import { constants } from 'node:fs'
import { open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { FINDING_RULES, type InstallFinding } from './findings.ts'

/** The directory under a profile that holds the records. */
export const RECORDS_DIRECTORY = 'delo-plugin-installs'

/** The schema name and major version of an install record. */
export const INSTALL_RECORD_SCHEMA = 'delo.plugin-install/1'

/** The schema name and major version of the trust status. */
export const PLUGIN_TRUST_SCHEMA = 'delo.plugin-trust/1'

/** The largest record read. */
const RECORD_MAX_BYTES = 256 * 1024 * 1024

/** Where a plugin came from, as the lockfile records it. */
export interface InstallSource {
  /** `registry` for a registry version, `tarball` for a URL, `git` for a git checkout. */
  readonly kind: 'registry' | 'tarball' | 'git'
  /** The version reference the profile's lockfile records for it. */
  readonly reference: string
  /** The tarball's Subresource Integrity, when the lockfile records one. */
  readonly integrity?: string
  /** The git commit, for a git checkout. */
  readonly commit?: string
  /** The tarball URL or the repository, for a tarball or a git checkout. */
  readonly url?: string
}

/** One package of a plugin's closure, as installed. */
export interface RecordedPackage {
  /** The name it is installed under. */
  readonly name: string
  /** The version its `package.json` declares, when it declares one. */
  readonly version?: string
  /** Its directory, relative to the profile, with `/` separators. */
  readonly dir: string
  /** Per file: its SHA-256, or `link:<target>`. */
  readonly files: Readonly<Record<string, string>>
  /** Per file: its identity, or `null` where it cannot vouch. */
  readonly identities: Readonly<Record<string, string | null>>
  /** Whether the package held more files than were recorded. */
  readonly truncated: boolean
}

/** What the install check recorded of one plugin's installation. */
export interface InstallRecord {
  /** The plugin's name. */
  readonly name: string
  /** The version its `package.json` declares. */
  readonly version?: string
  /** Where it came from. */
  readonly source: InstallSource
  /** When the check ran, in milliseconds. */
  readonly installedAt: number
  /** When the file identities were captured, in milliseconds; never later than the observations. */
  readonly capturedAt: number
  /** The findings shown when it was installed. */
  readonly findings: readonly InstallFinding[]
  /** The critical advisories the person allowed for this installation. */
  readonly allowedAdvisories: readonly string[]
  /** The lockfile entries its closure holds. */
  readonly lockfileEntries: readonly string[]
  /** The packages of its closure, the plugin first. */
  readonly packages: readonly RecordedPackage[]
}

/** How an installed plugin compares with its record. */
export type PluginTrustState = 'unchanged' | 'changed' | 'unrecorded'

/** One plugin of the trust status. */
export interface PluginTrustEntry {
  /** The plugin's name. */
  readonly name: string
  /** The version its record names; `null` when it has no record. */
  readonly version: string | null
  /** `changed` when a recorded file differs, was added or is gone; `unrecorded` when no record reads. */
  readonly state: PluginTrustState
  /** How many files differ. */
  readonly changedCount: number
  /** Up to 20 of them, as `<package dir>/<file>`. */
  readonly changedFiles: readonly string[]
  /** How many findings were shown at installation. */
  readonly installFindings: number
  /** When it was installed, in milliseconds; `null` without a record. */
  readonly installedAt: number | null
}

/**
 * The last check of a profile's installed plugins against their install records. Linked and local folders are left
 * out: their files change as the person works on them.
 */
export interface PluginTrustStatus {
  /** When the check finished, in milliseconds. */
  readonly checkedAt: number
  /** `quick` hashes only files whose identity changed; `full` hashes every file. */
  readonly mode: 'quick' | 'full'
  /** One entry per installed plugin from npm, a tarball or git, sorted by name. */
  readonly plugins: readonly PluginTrustEntry[]
  /** Why the check could not read the profile's lockfile; absent when it could. */
  readonly problem?: string
}

const Finding = z.strictObject({
  rule: z.enum(FINDING_RULES),
  title: z.string(),
  package: z.string(),
  version: z.string().exactOptional(),
  path: z.string(),
  line: z.number().int().min(0),
  severity: z.enum(['critical', 'warning']),
  advisory: z.string().exactOptional(),
})
const RecordSchema = z.strictObject({
  schema: z.literal(INSTALL_RECORD_SCHEMA),
  name: z.string().min(1),
  version: z.string().exactOptional(),
  source: z.strictObject({
    kind: z.enum(['registry', 'tarball', 'git']),
    reference: z.string().min(1),
    integrity: z.string().exactOptional(),
    commit: z.string().exactOptional(),
    url: z.string().exactOptional(),
  }),
  installedAt: z.number().int().min(0),
  capturedAt: z.number().int().min(0),
  findings: z.array(Finding),
  allowedAdvisories: z.array(z.string()),
  lockfileEntries: z.array(z.string()),
  packages: z.array(z.strictObject({
    name: z.string().min(1),
    version: z.string().exactOptional(),
    dir: z.string(),
    files: z.record(z.string(), z.string()),
    identities: z.record(z.string(), z.string().nullable()),
    truncated: z.boolean(),
  })),
})
const TrustSchema = z.strictObject({
  schema: z.literal(PLUGIN_TRUST_SCHEMA),
  checkedAt: z.number().int().min(0),
  mode: z.enum(['quick', 'full']),
  plugins: z.array(z.strictObject({
    name: z.string(),
    version: z.string().nullable(),
    state: z.enum(['unchanged', 'changed', 'unrecorded']),
    changedCount: z.number().int().min(0),
    changedFiles: z.array(z.string()),
    installFindings: z.number().int().min(0),
    installedAt: z.number().int().min(0).nullable(),
  })),
  problem: z.string().exactOptional(),
})

/**
 * The record file of a plugin.
 * @param profileDir - the profile directory.
 * @param name - the plugin's name.
 * @returns `<profile>/delo-plugin-installs/records/<name>.json`, a scoped name's `/` written `+`.
 */
export function recordPath(profileDir: string, name: string): string {
  return join(profileDir, RECORDS_DIRECTORY, 'records', `${name.replace('/', '+')}.json`)
}

/**
 * The trust status file of a profile.
 * @param profileDir - the profile directory.
 * @returns `<profile>/delo-plugin-installs/trust.json`.
 */
export function trustPath(profileDir: string): string {
  return join(profileDir, RECORDS_DIRECTORY, 'trust.json')
}

/**
 * Read a JSON file the check wrote: a regular file, not a link, within the size limit.
 * @param path - the file.
 * @returns the parsed JSON, or `undefined` when it is missing or refused.
 */
async function readOwnJson(path: string): Promise<unknown> {
  let text: string
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > RECORD_MAX_BYTES) return undefined
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (_unreadable) {
    // Missing, a link (ELOOP) or unreadable: the file vouches for nothing.
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (_notJson) {
    // Not JSON: the file vouches for nothing.
    return undefined
  }
}

/**
 * Read a plugin's install record.
 * @param profileDir - the profile directory.
 * @param name - the plugin's name.
 * @returns the record, or `undefined` when none reads.
 */
export async function readInstallRecord(profileDir: string, name: string): Promise<InstallRecord | undefined> {
  const parsed = RecordSchema.safeParse(await readOwnJson(recordPath(profileDir, name)))
  if (!parsed.success || parsed.data.name !== name) return undefined
  const { schema: _schema, ...record } = parsed.data
  return record
}

/**
 * Read every install record of a profile.
 * @param profileDir - the profile directory.
 * @returns the records that read, by plugin name.
 */
export async function readInstallRecords(profileDir: string): Promise<Map<string, InstallRecord>> {
  let names: string[]
  try {
    names = await readdir(join(profileDir, RECORDS_DIRECTORY, 'records'))
  } catch (_absent) {
    // No records directory: no plugin was recorded.
    return new Map()
  }
  const records = new Map<string, InstallRecord>()
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    const record = await readInstallRecord(profileDir, file.slice(0, -'.json'.length).replace('+', '/'))
    if (record !== undefined) records.set(record.name, record)
  }
  return records
}

/**
 * Write a plugin's install record, mode 0600 in a mode 0700 directory.
 * @param profileDir - the profile directory.
 * @param record - the record.
 */
export async function writeInstallRecord(profileDir: string, record: InstallRecord): Promise<void> {
  await writeFileAtomic(recordPath(profileDir, record.name), `${JSON.stringify({ schema: INSTALL_RECORD_SCHEMA, ...record })}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Remove a plugin's install record.
 * @param profileDir - the profile directory.
 * @param name - the plugin's name.
 */
export async function removeInstallRecord(profileDir: string, name: string): Promise<void> {
  await rm(recordPath(profileDir, name), { force: true })
}

/**
 * Read a profile's trust status: what the last check found. The studio's trust badge and `delorun verify`'s listing
 * read it.
 * @param profileDir - the profile directory.
 * @returns the status, or `undefined` when no check has written one, or it does not read.
 */
export async function readPluginTrust(profileDir: string): Promise<PluginTrustStatus | undefined> {
  const parsed = TrustSchema.safeParse(await readOwnJson(trustPath(profileDir)))
  if (!parsed.success) return undefined
  const { schema: _schema, ...status } = parsed.data
  return status
}

/**
 * Write a profile's trust status, mode 0600 in a mode 0700 directory.
 * @param profileDir - the profile directory.
 * @param status - the status.
 */
export async function writePluginTrust(profileDir: string, status: PluginTrustStatus): Promise<void> {
  await writeFileAtomic(trustPath(profileDir), `${JSON.stringify({ schema: PLUGIN_TRUST_SCHEMA, ...status }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
