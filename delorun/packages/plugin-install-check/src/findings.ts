/**
 * The install check's findings for the packages one installation brings: a package without a lockfile integrity or
 * with a git commit that is not a full 40-hex id; a GitHub advisory that affects a locked version, read from npm's bulk
 * advisory API; a version the registry published less than the configured age ago; a name close to a name the
 * profile or the installation already holds; a registry, tarball or git source reached over plain `http:`, through
 * which a package could be altered in transit; and, for an installation a mirror resolved, a lockfile integrity that the
 * primary registry's package document does not confirm. A lookup that fails is a finding that says which check could
 * not run, so no check is skipped silently. A `critical` advisory, and a mirror-resolved integrity the primary registry
 * could not confirm, block until the person accepts them; an integrity the primary registry contradicts refuses the
 * installation; every other finding is a warning.
 *
 * @module @delorun/plugin-install-check/findings
 */
import { advisoryId, FeedFailure, queryFeed, type LockedPackage } from '@delorun/release-formats/advisory/feed'
import semver from 'semver'
import type { ClosurePackage } from './lockfile.ts'

/** Every rule the install check can record, in the order a record lists them. */
export const FINDING_RULES = [
  'missing-integrity',
  'unpinned-commit',
  'advisory',
  'advisory-unchecked',
  'recent-publish',
  'publish-time-unchecked',
  'similar-name',
  'insecure-source',
  'changed-files',
  'integrity-mismatch',
  'integrity-unconfirmed',
] as const

/** What a finding is about. */
export type FindingRule = typeof FINDING_RULES[number]

/** One finding of the install check. */
export interface InstallFinding {
  readonly rule: FindingRule
  /** One line a person reads. */
  readonly title: string
  /** The package it is about, or the plugin for a finding about the whole check. */
  readonly package: string
  /** The package's locked version or source, when it has one. */
  readonly version?: string
  /** The finding's file, relative to the profile: `pnpm-lock.yaml`, or a package's file for `changed-files`. */
  readonly path: string
  /** The 1-based line of `path` it is read at; 0 when it names the whole file. */
  readonly line: number
  /**
   * `critical` for a critical advisory or an integrity the primary registry did not confirm, which blocks until allowed,
   * and for an integrity it contradicts, which refuses; `warning` otherwise.
   */
  readonly severity: 'critical' | 'warning'
  /** The GHSA id, for `advisory`. */
  readonly advisory?: string
}

/** The settings the findings read. */
export interface FindingSettings {
  /** npm's bulk advisory endpoint. */
  readonly advisoryFeed: string
  /**
   * The primary registry, ending in `/`: its package documents give publish times, and confirm the integrity of a
   * package a mirror resolved.
   */
  readonly registry: string
  /** A version published less than this many hours ago is a warning. */
  readonly minimumAgeHours: number
  /** The largest edit distance between two names that counts as close; 0 checks only names spelled the same apart from punctuation and scope. */
  readonly similarNameDistance: number
  /** Names shorter than this are not compared. */
  readonly similarNameMinLength: number
  /** Each request's time limit in milliseconds. */
  readonly requestTimeoutMs: number
  /** How many package documents are read at once. */
  readonly requestConcurrency: number
  /** The largest package document read, in bytes. */
  readonly metadataMaxBytes: number
}

/** What the findings are computed from. */
export interface FindingInput {
  /** The packages to check: the plugin and every package its installation added to the lockfile. */
  readonly packages: readonly ClosurePackage[]
  /** Names already in the profile or the installation, which a new name is compared with. */
  readonly knownNames: ReadonlySet<string>
  /** The registries the installation asked, as URLs; a plain `http:` one is a finding. */
  readonly registries: readonly string[]
  /** The clock, in milliseconds. */
  readonly now: number
  /** Ends every request early. */
  readonly signal?: AbortSignal
  /**
   * Whether a mirror, not the primary registry, resolved the installation, so each registry package's lockfile integrity
   * is compared with the primary registry's.
   */
  readonly confirmIntegrity?: boolean
}

const LOCKFILE_PATH = 'pnpm-lock.yaml'
const FULL_COMMIT = /^[0-9a-f]{40}$/u

/**
 * The findings for the packages one installation brings.
 * @param input - the packages, the known names and the clock.
 * @param settings - the endpoints, thresholds and limits.
 * @returns the findings, in a stable order: integrity, advisories, publish times, names.
 */
export async function findingsFor(input: FindingInput, settings: FindingSettings): Promise<InstallFinding[]> {
  const registryPackages = input.packages.flatMap(pkg => registryVersion(pkg) === undefined ? [] : [pkg])
  const [advisories, documents] = await Promise.all([advisoryFindings(registryPackages, settings, input.signal), readDocuments(registryPackages, settings, input.signal)])
  const confirmations = input.confirmIntegrity === true ? confirmationFindings(registryPackages, documents, settings) : []
  return [...insecureFindings(input), ...input.packages.flatMap(integrityFindings), ...confirmations, ...advisories, ...ageFindings(registryPackages, documents, settings, input.now), ...nameFindings(input.packages, input.knownNames, settings)]
}

/** A URL over plain HTTP, `git+http:` included. */
const PLAIN_HTTP = /^(?:git\+)?http:\/\//iu

/**
 * The plain-HTTP findings: a registry the installation asked, and each package fetched from a tarball or git URL, over
 * `http:`. Such a source is used, as stock does. A lockfile integrity hash does not protect the resolution that records
 * it, because that resolution reads the hash over the same plain-HTTP connection; it only holds a later installation to
 * the bytes this one received.
 * @param input - the packages and the registries.
 * @returns one finding per plain-HTTP registry and package.
 */
function insecureFindings(input: FindingInput): InstallFinding[] {
  const plugin = input.packages[0]?.name ?? ''
  const registries = [...new Set(input.registries.filter(url => PLAIN_HTTP.test(url)))].map((url): InstallFinding => ({
    rule: 'insecure-source', package: plugin, path: LOCKFILE_PATH, line: 0, severity: 'warning',
    title: `The registry ${url} is plain http, so a package and its integrity hash could be altered in transit; a lockfile hash only holds later installs to the bytes this one received`,
  }))
  const packages = input.packages.flatMap((pkg): InstallFinding[] => {
    const url = pkg.entry?.resolution.tarball ?? pkg.entry?.resolution.repo
    if (url === undefined || !PLAIN_HTTP.test(url)) return []
    return [{
      rule: 'insecure-source', package: pkg.name, version: pkg.reference, path: LOCKFILE_PATH, line: pkg.entry?.line ?? 0, severity: 'warning',
      title: `${pkg.name} is downloaded over plain http (${url}), so it could be altered in transit${pkg.entry?.resolution.integrity === undefined ? '' : '; its lockfile integrity hash only holds later installs to the bytes this one received'}`,
    }]
  })
  return [...registries, ...packages]
}

/**
 * The registry version of a package the registry served by its own path, which the advisory feed and the package
 * document describe.
 * @param pkg - the package.
 * @returns the version, or `undefined` for a git, tarball, directory or link source, or a version that is not exact.
 */
function registryVersion(pkg: ClosurePackage): string | undefined {
  const resolution = pkg.entry?.resolution
  if (resolution === undefined || resolution.tarball !== undefined || resolution.type !== undefined) return undefined
  return semver.valid(pkg.entry?.version ?? '') ?? undefined
}

/**
 * The integrity findings of one package.
 * @param pkg - the package.
 * @returns a finding when the lockfile records no integrity for it, or pins its git source to less than a full commit.
 */
function integrityFindings(pkg: ClosurePackage): InstallFinding[] {
  const at = { package: pkg.name, version: pkg.reference, path: LOCKFILE_PATH, line: pkg.entry?.line ?? 0, severity: 'warning' as const }
  if (pkg.entry === undefined) return [{ ...at, rule: 'missing-integrity', title: `${pkg.name} has no entry in the profile's lockfile, so nothing pins what was installed` }]
  const { resolution } = pkg.entry
  if (resolution.type === 'git') {
    return resolution.commit !== undefined && FULL_COMMIT.test(resolution.commit)
      ? []
      : [{ ...at, rule: 'unpinned-commit', title: `${pkg.name} comes from git without a full 40-character commit, so the same name can fetch other code later` }]
  }
  if (resolution.integrity === undefined) return [{ ...at, rule: 'missing-integrity', title: `${pkg.name} has no integrity hash in the lockfile, so a later install is not held to the same bytes` }]
  return []
}

/**
 * The advisory findings of the registry packages.
 * @param packages - the registry packages.
 * @param settings - the feed and its time limit.
 * @param signal - ends the request early.
 * @returns one finding per advisory that affects a locked version, `critical` for a critical one, or one finding that
 *   the check could not run.
 */
async function advisoryFindings(packages: readonly ClosurePackage[], settings: FindingSettings, signal: AbortSignal | undefined): Promise<InstallFinding[]> {
  if (packages.length === 0) return []
  const locked: LockedPackage[] = packages.map(pkg => ({ name: pkg.entry!.name, version: pkg.entry!.version }))
  let answer
  try {
    answer = await queryFeed(settings.advisoryFeed, locked, { timeoutMs: settings.requestTimeoutMs, ...signal === undefined ? {} : { signal } })
  } catch (error) {
    if (!(error instanceof FeedFailure)) throw error
    return [{ rule: 'advisory-unchecked', title: `The advisory check could not run, so known vulnerabilities were not looked up: ${error.message}`, package: packages[0]!.name, path: LOCKFILE_PATH, line: 0, severity: 'warning' }]
  }
  const findings: InstallFinding[] = []
  for (const pkg of packages) {
    const entry = pkg.entry!
    for (const advisory of answer[entry.name] ?? []) {
      if (!semver.satisfies(entry.version, advisory.vulnerable_versions, { includePrerelease: true })) continue
      const id = advisoryId(advisory)
      findings.push({
        rule: 'advisory', advisory: id, package: entry.name, version: entry.version, path: LOCKFILE_PATH, line: entry.line,
        severity: advisory.severity.toLowerCase() === 'critical' ? 'critical' : 'warning',
        title: `${id} (${advisory.severity}) affects ${entry.name}@${entry.version}: ${advisory.title}`,
      })
    }
  }
  return findings.sort((a, b) => (a.advisory! < b.advisory! ? -1 : a.advisory! > b.advisory! ? 1 : 0))
}

/**
 * The registry's document URL for a package.
 * @param registry - the registry, ending in `/`.
 * @param name - the package's name.
 * @returns the URL, with a scoped name's `/` encoded as the registry expects.
 */
export function documentUrl(registry: string, name: string): string {
  return `${registry}${name.replace('/', '%2f')}`
}

/** A package document the primary registry answered, or why it could not be read. */
type DocumentRead = { readonly document: Record<string, unknown> } | { readonly error: string }

/**
 * Read one package document.
 * @param url - the document's URL.
 * @param settings - the time limit and size limit.
 * @param signal - ends the request early.
 * @returns the document.
 * @throws Error naming the URL when the registry cannot be reached, answers another status, or a body too large or not
 *   a JSON object.
 */
async function packageDocument(url: string, settings: FindingSettings, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(settings.requestTimeoutMs)
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) })
  if (response.status !== 200) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > settings.metadataMaxBytes) throw new Error(`${url} is larger than ${String(settings.metadataMaxBytes)} bytes`)
  const text = await response.text()
  if (Buffer.byteLength(text) > settings.metadataMaxBytes) throw new Error(`${url} is larger than ${String(settings.metadataMaxBytes)} bytes`)
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`${url} answered with a body that is not JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new Error(`${url} answered with a body that is not a JSON object`)
  return document as Record<string, unknown>
}

/**
 * Read the primary registry's document of each registry package, a few at once.
 * @param packages - the registry packages.
 * @param settings - the registry, the concurrency and the limits.
 * @param signal - ends the requests early.
 * @returns each package's document, or why it could not be read.
 */
async function readDocuments(packages: readonly ClosurePackage[], settings: FindingSettings, signal: AbortSignal | undefined): Promise<Map<ClosurePackage, DocumentRead>> {
  const documents = new Map<ClosurePackage, DocumentRead>()
  const queue = [...packages]
  const worker = async (): Promise<void> => {
    for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
      try {
        documents.set(pkg, { document: await packageDocument(documentUrl(settings.registry, pkg.entry!.name), settings, signal) })
      } catch (error) {
        documents.set(pkg, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.requestConcurrency, packages.length) }, worker))
  return documents
}

/**
 * A field of a JSON object that is itself a JSON object.
 * @param value - the object, or anything else.
 * @param key - the field.
 * @returns the field's object, or `undefined` when either is not an object.
 */
function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'object' && field !== null && !Array.isArray(field) ? field as Record<string, unknown> : undefined
}

/**
 * The publish-time findings of the registry packages.
 * @param packages - the registry packages.
 * @param documents - their documents.
 * @param settings - the age.
 * @param now - the clock, in milliseconds.
 * @returns one finding per version younger than the configured age, and one finding naming the lookups that failed.
 */
function ageFindings(packages: readonly ClosurePackage[], documents: ReadonlyMap<ClosurePackage, DocumentRead>, settings: FindingSettings, now: number): InstallFinding[] {
  const findings: InstallFinding[] = []
  const failures: string[] = []
  for (const pkg of packages) {
    const entry = pkg.entry!
    const read = documents.get(pkg)!
    const url = documentUrl(settings.registry, entry.name)
    const time = 'document' in read ? objectField(read.document, 'time')?.[entry.version] : undefined
    const published = typeof time === 'string' ? Date.parse(time) : Number.NaN
    if (Number.isNaN(published)) {
      failures.push(`${entry.name}@${entry.version}: ${'error' in read ? read.error : `${url} names no publish time for ${entry.version}`}`)
      continue
    }
    const hours = (now - published) / 3_600_000
    if (hours < settings.minimumAgeHours) {
      findings.push({ rule: 'recent-publish', package: entry.name, version: entry.version, path: LOCKFILE_PATH, line: entry.line, severity: 'warning', title: `${entry.name}@${entry.version} was published ${hours < 1 ? 'less than an hour' : `${String(Math.floor(hours))} hours`} ago; a hijacked release is often caught in its first day` })
    }
  }
  findings.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0))
  if (failures.length > 0) {
    failures.sort()
    findings.push({ rule: 'publish-time-unchecked', package: packages[0]!.name, path: LOCKFILE_PATH, line: 0, severity: 'warning', title: `The publish time of ${String(failures.length)} ${failures.length === 1 ? 'package' : 'packages'} could not be checked: ${failures[0]!}${failures.length > 1 ? ', and others' : ''}` })
  }
  return findings
}

/**
 * The integrity confirmations of the registry packages a mirror resolved: each lockfile integrity is compared with the
 * one the primary registry's document lists for the version.
 * @param packages - the registry packages.
 * @param documents - their primary registry documents.
 * @param settings - the primary registry.
 * @returns per package, a critical `integrity-mismatch` when the two differ, which refuses, or a critical
 *   `integrity-unconfirmed` when either is missing or the document could not be read, which needs acceptance.
 */
function confirmationFindings(packages: readonly ClosurePackage[], documents: ReadonlyMap<ClosurePackage, DocumentRead>, settings: FindingSettings): InstallFinding[] {
  return packages.flatMap((pkg): InstallFinding[] => {
    const entry = pkg.entry!
    const at = { package: entry.name, version: entry.version, path: LOCKFILE_PATH, line: entry.line, severity: 'critical' as const }
    const read = documents.get(pkg)!
    const primary = 'document' in read ? objectField(objectField(objectField(read.document, 'versions'), entry.version), 'dist')?.integrity : undefined
    const locked = entry.resolution.integrity
    if (typeof primary === 'string' && locked !== undefined && primary !== locked) {
      return [{ ...at, rule: 'integrity-mismatch', title: `${entry.name}@${entry.version} came through a mirror whose integrity ${locked} differs from ${primary}, which the primary registry ${settings.registry} lists, so it is refused` }]
    }
    if (typeof primary === 'string' && locked !== undefined) return []
    const why = 'error' in read ? read.error : typeof primary !== 'string' ? `${settings.registry} lists no integrity for ${entry.version}` : 'the lockfile records no integrity for it'
    return [{ ...at, rule: 'integrity-unconfirmed', title: `The integrity of ${entry.name}@${entry.version}, which came through a mirror, is not confirmed against the primary registry: ${why}` }]
  })
}

/**
 * A name with its scope's `@` and its punctuation folded, so `@delorun/bundle-local`, `delorun-bundle-local` and
 * `delorun_bundle.local` read alike.
 * @param name - the package's name.
 * @returns the folded name.
 */
function folded(name: string): string {
  return name.toLowerCase().replace(/^@/u, '').replace(/[/._]/gu, '-')
}

/**
 * The optimal string alignment distance of two names: insertions, deletions, substitutions and swaps of neighbours.
 * @param a - one name.
 * @param b - the other.
 * @param limit - the distance beyond which the exact value does not matter.
 * @returns the distance, or `limit + 1` when it exceeds the limit.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_value, index) => index)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1)
      row.push(value)
    }
    rows.push(row)
  }
  return rows[a.length]![b.length]!
}

/**
 * The name findings: a new package whose name is close to, but not, a known one.
 * @param packages - the new packages.
 * @param known - the known names.
 * @param settings - the distance and the shortest name compared.
 * @returns one finding per new name, naming the first close known name.
 */
function nameFindings(packages: readonly ClosurePackage[], known: ReadonlySet<string>, settings: FindingSettings): InstallFinding[] {
  const findings: InstallFinding[] = []
  const reported = new Set<string>()
  for (const pkg of packages) {
    if (known.has(pkg.name) || reported.has(pkg.name) || pkg.name.length < settings.similarNameMinLength) continue
    const mine = folded(pkg.name)
    const close = [...known].sort().find(other => other.length >= settings.similarNameMinLength
      && (folded(other) === mine || editDistance(folded(other), mine, settings.similarNameDistance) <= settings.similarNameDistance))
    if (close === undefined) continue
    reported.add(pkg.name)
    findings.push({ rule: 'similar-name', package: pkg.name, version: pkg.reference, path: LOCKFILE_PATH, line: pkg.entry?.line ?? 0, severity: 'warning', title: `${pkg.name} is named like ${close}, which this profile or Delorun already has; check that it is the package you meant` })
  }
  return findings
}
