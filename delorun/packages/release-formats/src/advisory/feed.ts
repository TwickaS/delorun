/**
 * The client of npm's bulk advisory API, which answers from the GitHub Advisory Database: one `POST` names package
 * versions, and the answer lists, per package name, the advisories with their GHSA URL, severity, title and vulnerable
 * range. The release's advisory check (contract C2) and the plugin install check both read it, so it lives with the
 * formats both sides read. A feed that cannot be reached, answers another status, or answers anything but the bulk
 * format is a {@link FeedFailure}; a vulnerable range that is not a semantic-version range fails the answer rather than
 * matching nothing.
 *
 * @module @delorun/release-formats/advisory/feed
 */
import semver from 'semver'
import { z } from 'zod'

/** One package version to ask about. */
export interface LockedPackage {
  readonly name: string
  readonly version: string
}

/** Why a feed request has no answer: the feed was unreachable, or answered with a status or body it may not. */
export class FeedFailure extends Error {
  override readonly name = 'FeedFailure'
}

/** One advisory of the feed's answer. */
export const FeedAdvisory = z.looseObject({
  url: z.string().regex(/^https:\/\/github\.com\/advisories\/GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u),
  title: z.string(),
  severity: z.string(),
  vulnerable_versions: z.string().refine(value => semver.validRange(value) !== null, 'a semantic-version range; a range the check cannot read fails it rather than matching nothing'),
})

/** The feed's answer: per package name, the advisories it knows. */
export const FeedResponse = z.record(z.string(), z.array(FeedAdvisory))

/** The feed's answer, parsed. */
export type FeedAnswer = z.output<typeof FeedResponse>

/** How long one request may take, and what ends it early. */
export interface FeedRequestOptions {
  /** The request's time limit in milliseconds, from the send to the end of the body. */
  readonly timeoutMs: number
  /** Ends the request early, as a {@link FeedFailure}. */
  readonly signal?: AbortSignal
}

/**
 * The GHSA id of an advisory, from its URL.
 * @param advisory - one advisory of an answer.
 * @returns the id, such as `GHSA-xxxx-xxxx-xxxx`.
 */
export function advisoryId(advisory: z.output<typeof FeedAdvisory>): string {
  return advisory.url.slice('https://github.com/advisories/'.length)
}

/**
 * Ask the feed which advisories it knows for these package versions.
 * @param feed - the bulk advisory endpoint.
 * @param packages - the package versions.
 * @param options - the time limit and the signal.
 * @returns per package name, the feed's advisories, in an object with no prototype; the caller matches each vulnerable range against its versions.
 * @throws FeedFailure when the feed is unreachable, the time limit passes or the signal fires, or the feed answers with
 * a status other than 200 or a body that is not the bulk advisory format.
 */
export async function queryFeed(feed: string, packages: readonly LockedPackage[], options: FeedRequestOptions): Promise<FeedAnswer> {
  // No prototype, so a package named `constructor` or `toString` is an ordinary key.
  const body: Record<string, string[]> = Object.create(null)
  for (const locked of packages) (body[locked.name] ??= []).push(locked.version)
  const signal = options.signal === undefined ? AbortSignal.timeout(options.timeoutMs) : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal])
  let response: Response
  let parsed: unknown
  try {
    response = await fetch(feed, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  } catch (error) {
    throw new FeedFailure(`the advisory feed ${feed} cannot be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (response.status !== 200) throw new FeedFailure(`the advisory feed ${feed} answered HTTP ${String(response.status)}`)
  try {
    parsed = await response.json()
  } catch (error) {
    throw new FeedFailure(`the advisory feed ${feed} answered with a body that is not JSON`, { cause: error })
  }
  const result = FeedResponse.safeParse(parsed)
  if (!result.success) throw new FeedFailure(`the advisory feed ${feed} answered with a malformed response: ${z.prettifyError(result.error).replaceAll('\n', '; ')}`)
  // The answer is read by package name: without a prototype, a name the feed left out is absent, not `Object`'s member.
  return Object.assign(Object.create(null) as FeedAnswer, result.data)
}
