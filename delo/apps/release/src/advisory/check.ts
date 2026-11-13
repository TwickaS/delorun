/**
 * The dependency advisory check of contract C2: every registry package name and version in the runtime closure's
 * lockfile, every installed package version the SBOM lists (bundled dependencies among them) and the staged pnpm are
 * checked against the GitHub Advisory Database through npm's bulk advisory API. The check fails when an advisory of
 * any severity affects a checked version and no valid acceptance in `delo/release/advisory-acceptances.yaml` covers
 * it, when an acceptance has lapsed or its approver is not a CODEOWNERS owner of that file, or when the feed cannot be
 * reached or answers with a malformed response, including a vulnerable range the check cannot read.
 *
 * @module @delo/release/advisory/check
 */
import { ADVISORY_ACCEPTANCES_PATH, METADATA_REQUEST_TIMEOUT_SECONDS, type AdvisoryAcceptance, type AdvisoryId, type SemanticVersion } from '@delo/contract-release-manifest'
import { advisoryId, FeedFailure, queryFeed, type FeedAnswer, type LockedPackage } from '@delo/release-formats/advisory/feed'
import { brandString } from '@deepseek-ai/dsh-brand'
import ignore from 'ignore'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export { FeedFailure, queryFeed, type LockedPackage } from '@delo/release-formats/advisory/feed'

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u

/** One advisory that affects a locked version. */
export interface Finding {
  /** The GHSA id. */
  readonly advisory: AdvisoryId
  /** The affected package and locked version. */
  readonly package: string
  readonly version: string
  /** The feed's severity and title. */
  readonly severity: string
  readonly title: string
  /** The feed's vulnerable range. */
  readonly vulnerable: string
  /** The acceptance that covers it; absent when none does. */
  readonly accepted?: AdvisoryAcceptance
  /** Why an acceptance with the same advisory and package does not cover it. */
  readonly lapsed?: string
  /** Why an acceptance that would cover it is refused: its approver is not a CODEOWNERS owner of the file. */
  readonly unapproved?: string
}

/** The check's result, which the release publishes as `delorun-<version>.advisories.json`. */
export interface AdvisoryReport {
  readonly schema: 'delo.release-advisories/1'
  /** The release checked. */
  readonly version: SemanticVersion
  /** The feed asked. */
  readonly feed: string
  /** How many package versions were checked. */
  readonly packages: number
  /** Every advisory that affects a locked version. */
  readonly findings: readonly Finding[]
  /** `pass` when every finding is covered by a valid acceptance. */
  readonly result: 'pass' | 'fail'
  /** Why the check failed; empty on a pass. */
  readonly problems: readonly string[]
}

/**
 * The names of the local packages a pnpm lockfile (version 9) records, as `file:` or `link:` versions: the release's
 * own workspace packages, which no registry advisory names.
 * @param text - the lockfile's text.
 * @returns the names.
 */
export function localPackageNames(text: string): Set<string> {
  const lock = z.looseObject({ packages: z.record(z.string(), z.unknown()).optional() }).parse(parseYaml(text))
  const names = new Set<string>()
  for (const key of Object.keys(lock.packages ?? {})) {
    const at = key.indexOf('@', 1)
    const version = key.slice(at + 1)
    if (at > 0 && (version.startsWith('file:') || version.startsWith('link:'))) names.add(key.slice(0, at))
  }
  return names
}

/**
 * The registry packages a pnpm lockfile (version 9) locks. Local `file:` and `link:` packages are left out: they are
 * the release's own source, which no registry advisory names.
 * @param text - the lockfile's text.
 * @returns each name and version once, sorted.
 * @throws Error when the text is not a version 9 pnpm lockfile.
 */
export function lockedPackages(text: string): LockedPackage[] {
  const lock = z.looseObject({ lockfileVersion: z.literal('9.0'), packages: z.record(z.string(), z.unknown()).optional() }).parse(parseYaml(text))
  const found = new Map<string, LockedPackage>()
  for (const key of Object.keys(lock.packages ?? {})) {
    const at = key.indexOf('@', 1)
    if (at < 0) throw new Error(`lockfile package key ${JSON.stringify(key)} has no version`)
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (version.startsWith('file:') || version.startsWith('link:')) continue
    if (semver.valid(version) === null) throw new Error(`lockfile package ${JSON.stringify(key)} has no exact version`)
    found.set(`${name}@${version}`, { name, version })
  }
  return [...found.values()].sort((a, b) => (a.name === b.name ? semver.compare(a.version, b.version) : a.name < b.name ? -1 : 1))
}

const Acceptance = z.strictObject({
  advisory: z.string().regex(GHSA).transform(value => brandString<AdvisoryId>(value)),
  package: z.string().min(1),
  range: z.string().refine(value => semver.validRange(value) !== null, 'a semantic-version range'),
  reason: z.string().trim().min(1),
  approver: z.string().regex(/^[A-Za-z0-9-]+$/u, 'a GitHub login'),
  lapsesAfter: z.string().refine(value => semver.valid(value) !== null, 'a release version').transform(value => brandString<SemanticVersion>(value)),
  added: z.iso.date(),
})

/** The acceptances file's schema; unknown fields fail it. */
export const AcceptancesSchema = z.strictObject({ acceptances: z.array(Acceptance) })

/**
 * Read the acceptances file.
 * @param text - the YAML text.
 * @returns the acceptances.
 * @throws Error on malformed YAML, a duplicate key, an unknown field or an invalid value.
 */
export function readAcceptances(text: string): AdvisoryAcceptance[] {
  const parsed = AcceptancesSchema.safeParse(parseYaml(text, { uniqueKeys: true }) ?? { acceptances: [] })
  if (!parsed.success) throw new Error(`${ADVISORY_ACCEPTANCES_PATH}: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  return parsed.data.acceptances
}

/**
 * The owners a CODEOWNERS file gives a path: the owners of the last rule whose pattern matches it, with gitignore
 * pattern semantics, as GitHub applies them.
 * @param text - the CODEOWNERS text.
 * @param path - the repository-relative path.
 * @returns the owners' logins without `@`; teams and e-mail owners are left out.
 */
export function codeOwners(text: string, path: string): string[] {
  let owners: string[] = []
  for (const line of text.split('\n')) {
    const [pattern, ...rest] = line.trim().split(/\s+/u)
    if (pattern === undefined || pattern === '' || pattern.startsWith('#')) continue
    if (ignore().add(pattern).ignores(path)) owners = rest.filter(owner => /^@[A-Za-z0-9-]+$/u.test(owner)).map(owner => owner.slice(1))
  }
  return owners
}

/** What one check needs. */
export interface AdvisoryCheckRequest {
  /** The release's version, compared with each acceptance's `lapsesAfter`. */
  readonly version: SemanticVersion
  /** Every package version to check. */
  readonly packages: readonly LockedPackage[]
  /** The acceptances. */
  readonly acceptances: readonly AdvisoryAcceptance[]
  /** The CODEOWNERS owners of the acceptances file, the only valid approvers. */
  readonly owners: readonly string[]
  /** The bulk advisory endpoint. */
  readonly feed: string
}

/**
 * Run the advisory check.
 * @param request - the release, packages, acceptances, approvers and feed.
 * @returns the report; a feed failure, or a package version the check cannot read, is a failed report naming it.
 */
export async function checkAdvisories(request: AdvisoryCheckRequest): Promise<AdvisoryReport> {
  const packages = [...new Map(request.packages.map(locked => [`${locked.name}@${locked.version}`, locked])).values()]
    .sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) : a.name < b.name ? -1 : 1))
  const base = { schema: 'delo.release-advisories/1', version: request.version, feed: request.feed, packages: packages.length } as const
  const unreadable = packages.filter(locked => semver.valid(locked.version) === null)
  if (unreadable.length > 0) return { ...base, findings: [], result: 'fail', problems: unreadable.map(locked => `${locked.name}@${locked.version} has no exact version the check can compare`) }
  let answer: FeedAnswer
  try {
    answer = await queryFeed(request.feed, packages, { timeoutMs: METADATA_REQUEST_TIMEOUT_SECONDS * 1000 })
  } catch (error) {
    if (!(error instanceof FeedFailure)) throw error
    return { ...base, findings: [], result: 'fail', problems: [error.message] }
  }
  const findings: Finding[] = []
  for (const locked of packages) {
    for (const advisory of answer[locked.name] ?? []) {
      if (!semver.satisfies(locked.version, advisory.vulnerable_versions, { includePrerelease: true })) continue
      const id = brandString<AdvisoryId>(advisoryId(advisory))
      const finding = { advisory: id, package: locked.name, version: locked.version, severity: advisory.severity, title: advisory.title, vulnerable: advisory.vulnerable_versions }
      const candidates = request.acceptances.filter(acceptance => acceptance.advisory === id && acceptance.package === locked.name)
      const valid = candidates.filter(acceptance => semver.satisfies(locked.version, acceptance.range, { includePrerelease: true }) && semver.lte(request.version, acceptance.lapsesAfter))
      const covering = valid.find(acceptance => request.owners.includes(acceptance.approver))
      if (covering !== undefined) {
        findings.push({ ...finding, accepted: covering })
        continue
      }
      const unapproved = valid[0]
      if (unapproved !== undefined) {
        findings.push({ ...finding, unapproved: `its acceptance's approver ${unapproved.approver} is not a CODEOWNERS owner of ${ADVISORY_ACCEPTANCES_PATH}` })
        continue
      }
      const lapsed = candidates.find(acceptance => semver.gt(request.version, acceptance.lapsesAfter))
      findings.push(lapsed === undefined ? finding : { ...finding, lapsed: `its acceptance lapsed after ${lapsed.lapsesAfter}` })
    }
  }
  findings.sort((a, b) => (a.advisory === b.advisory ? (a.package < b.package ? -1 : 1) : a.advisory < b.advisory ? -1 : 1))
  const problems = findings.filter(finding => finding.accepted === undefined).map(finding => `${finding.advisory} (${finding.severity}) affects ${finding.package}@${finding.version}: ${finding.unapproved ?? finding.lapsed ?? 'no acceptance covers it'}`)
  return { ...base, findings, result: problems.length === 0 ? 'pass' : 'fail', problems }
}
