/**
 * The install check of a profile's plugins, free of Cordis, which the `pluginAudit` provider in the Host and
 * `delorun plugin` both run, and the change check a start and `delorun verify` run against what it recorded.
 *
 * A plugin installed from npm, a tarball or git is checked once per installed version, in two steps. {@link checkPackage}
 * reads the profile's lockfile alone, so it runs after pnpm resolved the installation and before anything is fetched
 * into the profile or any script runs: the plugin and every package its installation added to the lockfile get the
 * findings of [findings](./findings.ts). Once the installation is in place and its approved build scripts have run,
 * {@link recordInstalled} records the SHA-256 of every file of the plugin's closure ([record](./record.ts)), so a
 * build's own output is part of the record. A plugin a critical advisory refuses is never recorded. A plugin from a
 * trusted npm scope or git owner shows critical advisories only. A linked or local folder is not checked or recorded:
 * its files change as the person works on it.
 *
 * @module @delo/plugin-install-check/check
 */
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { trustedFileSystem } from '@delo/runtime-store/identity'
import { capturePackage, comparePackage, type FileChanges } from './files.ts'
import { findingsFor, type FindingSettings, type InstallFinding } from './findings.ts'
import { closureOf, LOCKFILE, LockfileError, lockfileClosure, packageKey, parseLockfile, type ClosurePackage, type Lockfile } from './lockfile.ts'
import semver from 'semver'
import { readInstallRecord, readInstallRecords, removeInstallRecord, writeInstallRecord, writePluginTrust, type InstallRecord, type InstallSource, type PluginTrustEntry, type PluginTrustStatus } from './record.ts'

export type { FindingRule, FindingSettings, InstallFinding } from './findings.ts'
export { LockfileError } from './lockfile.ts'
export { readInstallRecord, readPluginTrust, recordPath, trustPath, type InstallRecord, type InstallSource, type PluginTrustEntry, type PluginTrustState, type PluginTrustStatus } from './record.ts'

/** Every setting of the check. */
export interface InstallCheckSettings extends FindingSettings {
  /** The most files recorded per package. */
  readonly maxFiles: number
  /** npm scopes (`@scope`) and git owners (`<host>/<owner>`) whose plugins show critical advisories only. */
  readonly trustedSources: readonly string[]
}

/** One plugin to check. */
export interface PackageCheckRequest {
  /** The profile directory. */
  readonly profileDir: string
  /** The plugin's name, as the profile depends on it. */
  readonly name: string
  /** The critical advisories the person allows for this installation, by GHSA id. */
  readonly allowedAdvisories: readonly string[]
  /**
   * Whether the person accepted exactly these blocking findings, for a caller whose acceptance names a set of findings
   * rather than advisory ids; absent accepts none.
   */
  readonly acceptsBlocking?: (blocking: readonly InstallFinding[]) => boolean
  /** Names the installation itself carries, which a new name is compared with. */
  readonly knownNames: ReadonlySet<string>
  /** The registries the installation asked, as URLs; a plain `http:` one is a finding. */
  readonly registries: readonly string[]
  /** The clock, in milliseconds. */
  readonly now: () => number
  /** Ends every request early. */
  readonly signal?: AbortSignal
  /**
   * Whether a plugin whose record stands is compared with its installed files; false while the files are not installed
   * or not built yet, when only the recorded findings are shown. True when absent.
   */
  readonly compareFiles?: boolean
  /** Whether a mirror resolved the installation, so its integrity is confirmed against the primary registry. */
  readonly confirmIntegrity?: boolean
}

/** What an installation that passed the check leaves to record once it is installed and built. */
export interface PendingRecord {
  readonly name: string
  readonly version?: string
  readonly source: InstallSource
  readonly findings: readonly InstallFinding[]
  readonly allowedAdvisories: readonly string[]
  readonly lockfileEntries: readonly string[]
}

/** What checking one plugin found. */
export type PackageCheck =
  /** The profile does not depend on the name, or it is a linked or local folder, which is not checked. */
  | { readonly kind: 'skipped', readonly reason: 'not-a-dependency' | 'local-folder' }
  /** The profile's lockfile does not read, so nothing was checked; the finding says why. */
  | { readonly kind: 'unchecked', readonly findings: readonly InstallFinding[] }
  /**
   * The plugin was checked: `findings` lists every finding; `blocking` the critical findings no allowance names, which
   * refuse the installation until accepted; `refused` the integrities the primary registry contradicts, which refuse it
   * whatever is accepted; `trusted` whether its source is trusted. `pending` is what {@link recordInstalled} records
   * once the installation is in place, present when the installation passed and its record does not stand yet.
   */
  | { readonly kind: 'checked', readonly name: string, readonly version?: string, readonly findings: readonly InstallFinding[], readonly blocking: readonly InstallFinding[], readonly refused: readonly InstallFinding[], readonly trusted: boolean, readonly pending?: PendingRecord }

/**
 * Read a profile's lockfile.
 * @param profileDir - the profile directory.
 * @returns the lockfile; an empty one when the profile has none.
 * @throws LockfileError when it cannot be read.
 */
async function readProfileLockfile(profileDir: string): Promise<Lockfile> {
  let text: string
  try {
    text = await readFile(join(profileDir, LOCKFILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dependencies: new Map(), packages: new Map(), snapshots: new Map() }
    throw new LockfileError(`the profile's ${LOCKFILE} cannot be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
  return parseLockfile(text)
}

/**
 * Whether a dependency reference names a linked or local folder.
 * @param lockfile - the lockfile.
 * @param name - the dependency.
 * @param reference - its reference.
 * @returns true for `link:` and for a `file:` directory.
 */
function isLocalFolder(lockfile: Lockfile, name: string, reference: string): boolean {
  if (reference.startsWith('link:')) return true
  const key = packageKey(name, reference)
  return key !== undefined && lockfile.packages.get(key)?.resolution.type === 'directory'
}

/**
 * Where a plugin came from.
 * @param pkg - the plugin's installed package.
 * @returns its source.
 */
function sourceOf(pkg: ClosurePackage): InstallSource {
  const resolution = pkg.entry?.resolution ?? {}
  const integrity = resolution.integrity === undefined ? {} : { integrity: resolution.integrity }
  if (resolution.type === 'git') return { kind: 'git', reference: pkg.reference, ...integrity, ...resolution.commit === undefined ? {} : { commit: resolution.commit }, ...resolution.repo === undefined ? {} : { url: resolution.repo } }
  if (resolution.tarball !== undefined) {
    const commit = /\/([0-9a-f]{40})$/u.exec(resolution.tarball)?.[1]
    return { kind: 'tarball', reference: pkg.reference, ...integrity, ...commit === undefined ? {} : { commit }, url: resolution.tarball }
  }
  return { kind: 'registry', reference: pkg.reference, ...integrity }
}

/**
 * The git owner a source URL names, as `<host>/<owner>`; a GitHub archive host counts as `github.com`.
 * @param url - the repository or tarball URL.
 * @returns the owner, or `undefined` when the URL names none.
 */
function ownerOf(url: string): string | undefined {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\//u.exec(url.replace(/^git\+/u, ''))
  if (match === null) return undefined
  const host = match[1]!.toLowerCase() === 'codeload.github.com' ? 'github.com' : match[1]!.toLowerCase()
  return `${host}/${match[2]!}`
}

/**
 * Whether a plugin comes from a trusted npm scope or git owner.
 * @param name - the plugin's name.
 * @param source - its source.
 * @param trusted - the trusted scopes and owners.
 * @returns true when one names it.
 */
export function isTrustedSource(name: string, source: InstallSource, trusted: readonly string[]): boolean {
  const owner = source.url === undefined ? undefined : ownerOf(source.url)
  return trusted.some(entry => entry.startsWith('@')
    ? source.kind === 'registry' && name.startsWith(`${entry}/`)
    : owner !== undefined && owner.toLowerCase() === entry.toLowerCase())
}

/**
 * A package directory relative to the profile.
 * @param profileDir - the profile's real directory.
 * @param dir - the package's real directory.
 * @returns the relative path with `/` separators.
 */
function relativeDir(profileDir: string, dir: string): string {
  return relative(profileDir, dir).split(sep).join('/')
}

/**
 * The version a package's manifest declares.
 * @param dir - the package's directory.
 * @returns the version, or `undefined` when the manifest declares none or does not read.
 */
async function manifestVersion(dir: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string' ? manifest.version : undefined
  } catch (_unreadable) {
    // A manifest that does not read declares no version; the record names the lockfile's reference instead.
    return undefined
  }
}

/**
 * Compare a plugin's installed closure with its record.
 * @param profileDir - the profile's real directory.
 * @param record - the record.
 * @param options - `full` hashes every file; `capturedAt` is this check's time.
 * @returns the changed files as `<package dir>/<file>`, and the record with the identities a hash vouched for again.
 */
async function compareRecord(profileDir: string, record: InstallRecord, options: { readonly full: boolean, readonly capturedAt: number, readonly limit: number }): Promise<{ readonly changed: readonly string[], readonly refreshed: InstallRecord | undefined }> {
  const trusted = await trustedFileSystem(profileDir) !== undefined
  const changed: string[] = []
  let refreshedAny = false
  const packages = []
  for (const pkg of record.packages) {
    let changes: FileChanges
    try {
      changes = await comparePackage(join(profileDir, ...pkg.dir.split('/')), pkg, { full: options.full, trusted, capturedAt: options.capturedAt, limit: options.limit })
    } catch (_gone) {
      // A package directory that cannot be read is gone: every file it held counts as changed.
      changes = { changed: [], added: [], removed: Object.keys(pkg.files), identities: {} }
    }
    changed.push(...[...changes.changed, ...changes.added, ...changes.removed].map(file => `${pkg.dir}/${file}`))
    const refreshed = Object.keys(changes.identities).length > 0
    refreshedAny ||= refreshed
    packages.push(refreshed ? { ...pkg, identities: { ...pkg.identities, ...changes.identities } } : pkg)
  }
  const refreshed = refreshedAny && changed.length === 0 ? { ...record, capturedAt: options.capturedAt, packages } : undefined
  return { changed: changed.sort(), refreshed }
}

/**
 * The finding for a plugin whose files changed since its record.
 * @param record - the record.
 * @param changed - the changed files.
 * @returns the finding.
 */
function changedFinding(record: InstallRecord, changed: readonly string[]): InstallFinding {
  return {
    rule: 'changed-files', package: record.name, ...record.version === undefined ? {} : { version: record.version }, path: changed[0]!, line: 0, severity: 'warning',
    title: `${String(changed.length)} ${changed.length === 1 ? 'file' : 'files'} of ${record.name} changed since it was installed, such as ${changed[0]!}; reinstall it if you did not change it`,
  }
}

/**
 * The lockfile reference of a profile's dependency and its root entry's integrity, which name one resolution of it.
 * @param profileDir - the profile directory.
 * @param name - the dependency.
 * @returns `<reference> <integrity>`, or `undefined` when the lockfile does not read or does not name the dependency.
 */
export async function lockedReference(profileDir: string, name: string): Promise<string | undefined> {
  let lockfile: Lockfile
  try {
    lockfile = await readProfileLockfile(profileDir)
  } catch (_unreadable) {
    // A lockfile that does not read names no resolution; the caller keys nothing by it.
    return undefined
  }
  const reference = lockfile.dependencies.get(name)
  if (reference === undefined) return undefined
  const key = packageKey(name, reference)
  return `${reference} ${(key === undefined ? undefined : lockfile.packages.get(key)?.resolution.integrity) ?? ''}`
}

/**
 * Check one plugin of a profile. A plugin whose record names its current lockfile reference is compared with the
 * record and shows the findings recorded at its installation; any other is checked as a new installation.
 * @param request - the profile, the plugin, the allowed advisories, the known names and the clock.
 * @param settings - the check's settings.
 * @returns what the check found.
 */
export async function checkPackage(request: PackageCheckRequest, settings: InstallCheckSettings): Promise<PackageCheck> {
  let lockfile: Lockfile
  try {
    lockfile = await readProfileLockfile(request.profileDir)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    return { kind: 'unchecked', findings: [{ rule: 'missing-integrity', title: `Nothing was checked: ${error.message}`, package: request.name, path: LOCKFILE, line: 0, severity: 'warning' }] }
  }
  const reference = lockfile.dependencies.get(request.name)
  if (reference === undefined) return { kind: 'skipped', reason: 'not-a-dependency' }
  if (isLocalFolder(lockfile, request.name, reference)) return { kind: 'skipped', reason: 'local-folder' }
  const profileDir = realpathSync(request.profileDir)
  const record = await readInstallRecord(profileDir, request.name)
  if (record?.source.reference === reference) {
    const capturedAt = request.now()
    const { changed, refreshed } = request.compareFiles === false ? { changed: [], refreshed: undefined } : await compareRecord(profileDir, record, { full: false, capturedAt, limit: settings.maxFiles })
    if (refreshed !== undefined) await writeInstallRecord(profileDir, refreshed)
    const trusted = isTrustedSource(record.name, record.source, settings.trustedSources)
    return { kind: 'checked', name: record.name, ...record.version === undefined ? {} : { version: record.version }, findings: [...record.findings, ...changed.length === 0 ? [] : [changedFinding(record, changed)]], blocking: [], refused: [], trusted }
  }
  const closure = lockfileClosure(lockfile, request.name)
  const root = closure[0]
  if (root === undefined) return { kind: 'skipped', reason: 'not-a-dependency' }
  const others = await readInstallRecords(profileDir)
  others.delete(request.name)
  const known = new Set([...others.values()].flatMap(each => each.lockfileEntries))
  const brought = closure.filter((pkg, index) => index === 0 || pkg.entry === undefined || !known.has(pkg.entry.key))
  const broughtKeys = new Set(brought.flatMap(pkg => pkg.entry === undefined ? [] : [pkg.entry.key]))
  const knownNames = new Set([
    ...request.knownNames,
    ...[...lockfile.packages.values()].filter(entry => !broughtKeys.has(entry.key)).map(entry => entry.name),
    ...[...lockfile.dependencies.keys()].filter(name => name !== request.name),
  ])
  const source = sourceOf(root)
  const trusted = isTrustedSource(request.name, source, settings.trustedSources)
  const all = await findingsFor({ packages: brought, knownNames, registries: request.registries, now: request.now(), confirmIntegrity: request.confirmIntegrity === true, ...request.signal === undefined ? {} : { signal: request.signal } }, settings)
  const findings = trusted ? all.filter(finding => finding.severity === 'critical') : all
  const refused = findings.filter(finding => finding.rule === 'integrity-mismatch')
  const allowed = new Set(request.allowedAdvisories)
  const unallowed = findings.filter(finding => finding.severity === 'critical' && finding.rule !== 'integrity-mismatch' && !allowed.has(finding.advisory ?? ''))
  const blocking = unallowed.length > 0 && request.acceptsBlocking?.(unallowed) === true ? [] : unallowed
  const version = root.entry?.packageVersion ?? semver.valid(root.entry?.version ?? '') ?? undefined
  const base = { kind: 'checked' as const, name: request.name, ...version === undefined ? {} : { version }, findings, blocking, refused, trusted }
  if (blocking.length > 0 || refused.length > 0) return base
  return {
    ...base,
    pending: {
      name: request.name, ...version === undefined ? {} : { version }, source, findings,
      allowedAdvisories: findings.flatMap(finding => finding.severity === 'critical' && finding.advisory !== undefined ? [finding.advisory] : []),
      lockfileEntries: closure.flatMap(pkg => pkg.entry === undefined ? [] : [pkg.entry.key]).sort(),
    },
  }
}

/**
 * Record a checked plugin once its installation is in place and its build scripts have run: the SHA-256 and identity
 * of every file of every package of its installed closure.
 * @param profileDir - the profile directory.
 * @param pending - what the check left to record.
 * @param options - the clock, in milliseconds, and the most files recorded per package.
 * @returns whether it recorded: false when the profile's lockfile no longer names the reference the check read.
 * @throws LockfileError when the profile's lockfile does not read.
 */
export async function recordInstalled(profileDir: string, pending: PendingRecord, options: { readonly now: () => number, readonly maxFiles: number }): Promise<boolean> {
  const lockfile = await readProfileLockfile(profileDir)
  if (lockfile.dependencies.get(pending.name) !== pending.source.reference) return false
  const real = realpathSync(profileDir)
  const capturedAt = options.now()
  const packages = []
  for (const pkg of closureOf(real, lockfile, pending.name)) {
    const captured = await capturePackage(pkg.dir, options.maxFiles, capturedAt)
    const pkgVersion = await manifestVersion(pkg.dir)
    packages.push({ name: pkg.name, ...pkgVersion === undefined ? {} : { version: pkgVersion }, dir: relativeDir(real, pkg.dir), ...captured })
  }
  await writeInstallRecord(real, { ...pending, installedAt: capturedAt, capturedAt, packages })
  return true
}

/** What bringing a profile's records in step with its dependencies did. */
export interface ReconcileResult {
  /** Each plugin checked as a new installation, in name order. */
  readonly checked: readonly { readonly name: string, readonly check: PackageCheck }[]
  /** The plugins whose records were removed, because the profile no longer depends on them. */
  readonly removed: readonly string[]
}

/**
 * Bring a profile's records in step with its dependencies after pnpm resolved a package operation: check each plugin
 * from npm, a tarball or git that has no record, or whose record names another lockfile reference, and remove the
 * record of each plugin the profile no longer depends on. The checked plugins are recorded by {@link recordInstalled}
 * once installed.
 * @param request - the profile, the allowed advisories, the known names and the clock.
 * @param settings - the check's settings.
 * @returns what it checked and removed.
 * @throws LockfileError when the profile's lockfile does not read.
 */
export async function reconcileProfile(request: Omit<PackageCheckRequest, 'name'>, settings: InstallCheckSettings): Promise<ReconcileResult> {
  const lockfile = await readProfileLockfile(request.profileDir)
  const records = await readInstallRecords(request.profileDir)
  const checked: { name: string, check: PackageCheck }[] = []
  for (const [name, reference] of [...lockfile.dependencies].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isLocalFolder(lockfile, name, reference) || records.get(name)?.source.reference === reference) continue
    checked.push({ name, check: await checkPackage({ ...request, name }, settings) })
  }
  const removed = [...records.keys()].filter(name => !lockfile.dependencies.has(name)).sort()
  for (const name of removed) await removeInstallRecord(request.profileDir, name)
  return { checked, removed }
}

/**
 * Remove the records of the plugins a profile no longer depends on.
 * @param profileDir - the profile directory.
 * @returns the plugins whose records were removed, sorted.
 * @throws LockfileError when the profile's lockfile does not read.
 */
export async function forgetRemoved(profileDir: string): Promise<string[]> {
  const lockfile = await readProfileLockfile(profileDir)
  const removed = [...(await readInstallRecords(profileDir)).keys()].filter(name => !lockfile.dependencies.has(name)).sort()
  for (const name of removed) await removeInstallRecord(profileDir, name)
  return removed
}

/**
 * Compare a profile's installed plugins from npm, a tarball or git with their records, and write the result as the
 * profile's trust status. A record whose files a hash vouched for again is rewritten with the new identities.
 * @param profileDir - the profile directory.
 * @param options - `full` hashes every file; otherwise only files whose identity changed. `now` is the clock; `maxFiles`
 *   the most files listed per package.
 * @returns the status it wrote.
 */
export async function checkProfileTrust(profileDir: string, options: { readonly full: boolean, readonly now: () => number, readonly maxFiles: number }): Promise<PluginTrustStatus> {
  const capturedAt = options.now()
  let lockfile: Lockfile
  try {
    lockfile = await readProfileLockfile(profileDir)
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error
    const status = { checkedAt: options.now(), mode: options.full ? 'full' as const : 'quick' as const, plugins: [], problem: error.message }
    await writePluginTrust(profileDir, status)
    return status
  }
  const real = realpathSync(profileDir)
  const records = await readInstallRecords(real)
  const plugins: PluginTrustEntry[] = []
  for (const [name, reference] of [...lockfile.dependencies].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isLocalFolder(lockfile, name, reference)) continue
    const record = records.get(name)
    if (record === undefined || record.source.reference !== reference) {
      plugins.push({ name, version: null, state: 'unrecorded', changedCount: 0, changedFiles: [], installFindings: 0, installedAt: null })
      continue
    }
    const { changed, refreshed } = await compareRecord(real, record, { full: options.full, capturedAt, limit: options.maxFiles })
    if (refreshed !== undefined) await writeInstallRecord(real, refreshed)
    plugins.push({ name, version: record.version ?? null, state: changed.length === 0 ? 'unchanged' : 'changed', changedCount: changed.length, changedFiles: changed.slice(0, 20), installFindings: record.findings.length, installedAt: record.installedAt })
  }
  const status: PluginTrustStatus = { checkedAt: options.now(), mode: options.full ? 'full' : 'quick', plugins }
  await writePluginTrust(real, status)
  return status
}
