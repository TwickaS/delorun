/**
 * The dependency advisory check of contract C2: every registry package name and version in the runtime closure's
 * lockfile is checked against the GitHub Advisory Database through npm's bulk advisory API. The check fails when an
 * advisory of any severity affects a locked version and no valid acceptance in `delo/release/advisory-acceptances.yaml`
 * covers it, when an acceptance has lapsed, or when the feed cannot be reached or answers with a malformed response.
 *
 * @module @delo/release/advisory/check
 */
import { execFileSync } from 'node:child_process'
import { ADVISORY_ACCEPTANCES_PATH, METADATA_REQUEST_TIMEOUT_SECONDS, type AdvisoryAcceptance, type AdvisoryId, type SemanticVersion } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u

/** One locked registry package version. */
export interface LockedPackage {
  readonly name: string
  readonly version: string
}

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
  /** The acceptance that covers it, with the date its entry was added; absent when none does. */
  readonly accepted?: AdvisoryAcceptance & { readonly added: string }
  /** Why an acceptance with the same advisory and package does not cover it. */
  readonly lapsed?: string
}

/** The check's result, which the release publishes as `delorun-<version>.advisories.json`. */
export interface AdvisoryReport {
  readonly schema: 'delo.release-advisories/1'
  /** The release checked. */
  readonly version: SemanticVersion
  /** The feed asked. */
  readonly feed: string
  /** How many locked registry package versions were checked. */
  readonly packages: number
  /** Every advisory that affects a locked version. */
  readonly findings: readonly Finding[]
  /** `pass` when every finding is covered by a valid acceptance. */
  readonly result: 'pass' | 'fail'
  /** Why the check failed; empty on a pass. */
  readonly problems: readonly string[]
}

/** Why the check could not run to a result: the feed was unreachable or answered malformed. */
export class FeedFailure extends Error {
  override readonly name = 'FeedFailure'
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

const FeedAdvisory = z.looseObject({
  url: z.string().regex(/^https:\/\/github\.com\/advisories\/GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u),
  title: z.string(),
  severity: z.string(),
  vulnerable_versions: z.string(),
})
const FeedResponse = z.record(z.string(), z.array(FeedAdvisory))

/**
 * Ask the feed which advisories affect the locked versions.
 * @param feed - the bulk advisory endpoint.
 * @param packages - the locked versions.
 * @returns per package, the feed's advisories.
 * @throws FeedFailure when the feed is unreachable, answers with a status other than 200, or with a body that is not
 * the bulk advisory format.
 */
export async function queryFeed(feed: string, packages: readonly LockedPackage[]): Promise<z.output<typeof FeedResponse>> {
  const body: Record<string, string[]> = {}
  for (const locked of packages) (body[locked.name] ??= []).push(locked.version)
  let response: Response
  try {
    response = await fetch(feed, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_SECONDS * 1000) })
  } catch (error) {
    throw new FeedFailure(`the advisory feed ${feed} cannot be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (response.status !== 200) throw new FeedFailure(`the advisory feed ${feed} answered HTTP ${String(response.status)}`)
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    throw new FeedFailure(`the advisory feed ${feed} answered with a body that is not JSON`, { cause: error })
  }
  const result = FeedResponse.safeParse(parsed)
  if (!result.success) throw new FeedFailure(`the advisory feed ${feed} answered with a malformed response: ${z.prettifyError(result.error).replaceAll('\n', '; ')}`)
  return result.data
}

const Acceptance = z.strictObject({
  advisory: z.string().regex(GHSA).transform(value => brandString<AdvisoryId>(value)),
  package: z.string().min(1),
  range: z.string().refine(value => semver.validRange(value) !== null, 'a semantic-version range'),
  reason: z.string().trim().min(1),
  approver: z.string().regex(/^[A-Za-z0-9-]+$/u, 'a GitHub login'),
  lapsesAfter: z.string().refine(value => semver.valid(value) !== null, 'a release version').transform(value => brandString<SemanticVersion>(value)),
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
 * The date of the commit that added an acceptance's entry, from the file's history up to a commit.
 * @param repository - the repository.
 * @param advisory - the entry's advisory id.
 * @param commit - the commit whose history applies, such as the release's.
 * @returns the committer date as `YYYY-MM-DD`, or `uncommitted` when no commit added it yet.
 */
export function acceptanceDate(repository: string, advisory: string, commit: string): string {
  const dates = execFileSync('git', ['log', '--format=%cs', '--reverse', `-S${advisory}`, commit, '--', ADVISORY_ACCEPTANCES_PATH], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(line => line !== '')
  return dates[0] ?? 'uncommitted'
}

/** What one check needs. */
export interface AdvisoryCheckRequest {
  /** The release's version, compared with each acceptance's `lapsesAfter`. */
  readonly version: SemanticVersion
  /** The closure lockfiles' texts. */
  readonly lockfiles: readonly string[]
  /** The acceptances. */
  readonly acceptances: readonly AdvisoryAcceptance[]
  /** The bulk advisory endpoint. */
  readonly feed: string
  /** The date an acceptance's entry was added. */
  readonly added: (advisory: string) => string
}

/**
 * Run the advisory check.
 * @param request - the release, lockfiles, acceptances and feed.
 * @returns the report; a feed failure is a failed report naming it.
 */
export async function checkAdvisories(request: AdvisoryCheckRequest): Promise<AdvisoryReport> {
  const packages = [...new Map(request.lockfiles.flatMap(lockedPackages).map(locked => [`${locked.name}@${locked.version}`, locked])).values()]
  const base = { schema: 'delo.release-advisories/1', version: request.version, feed: request.feed, packages: packages.length } as const
  let answer: z.output<typeof FeedResponse>
  try {
    answer = await queryFeed(request.feed, packages)
  } catch (error) {
    if (!(error instanceof FeedFailure)) throw error
    return { ...base, findings: [], result: 'fail', problems: [error.message] }
  }
  const findings: Finding[] = []
  for (const locked of packages) {
    for (const advisory of answer[locked.name] ?? []) {
      if (!semver.satisfies(locked.version, advisory.vulnerable_versions, { includePrerelease: true })) continue
      const id = brandString<AdvisoryId>(advisory.url.slice('https://github.com/advisories/'.length))
      const finding = { advisory: id, package: locked.name, version: locked.version, severity: advisory.severity, title: advisory.title, vulnerable: advisory.vulnerable_versions }
      const candidates = request.acceptances.filter(acceptance => acceptance.advisory === id && acceptance.package === locked.name)
      const covering = candidates.find(acceptance => semver.satisfies(locked.version, acceptance.range, { includePrerelease: true }) && semver.lte(request.version, acceptance.lapsesAfter))
      if (covering !== undefined) {
        findings.push({ ...finding, accepted: { ...covering, added: request.added(covering.advisory) } })
        continue
      }
      const lapsed = candidates.find(acceptance => semver.gt(request.version, acceptance.lapsesAfter))
      findings.push(lapsed === undefined ? finding : { ...finding, lapsed: `its acceptance lapsed after ${lapsed.lapsesAfter}` })
    }
  }
  findings.sort((a, b) => (a.advisory === b.advisory ? (a.package < b.package ? -1 : 1) : a.advisory < b.advisory ? -1 : 1))
  const problems = findings.filter(finding => finding.accepted === undefined).map(finding => `${finding.advisory} (${finding.severity}) affects ${finding.package}@${finding.version}: ${finding.lapsed ?? 'no acceptance covers it'}`)
  return { ...base, findings, result: problems.length === 0 ? 'pass' : 'fail', problems }
}
