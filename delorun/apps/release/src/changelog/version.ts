/**
 * The versions the assembly accepts: `0.x.y` with an optional `-alpha.N`, `-beta.N`, `-rc.N` or `-preview.N`
 * pre-release, and `1.0.0` only when the first public release is named. A preview sub-version `0.x.y-preview.N`
 * (N from 1) is one batch of changes on the way to `0.x.y` and sorts before it. The pattern is strict semver with no
 * leading zeros, so a version is always safe as a path segment.
 *
 * @module @delorun/release/changelog/version
 */

/** Strict semver for the accepted forms; group 1 is the major number, group 5 the pre-release tag, group 6 its number. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc|preview)\.(0|[1-9]\d*))?$/

/** The numbers and the pre-release of a version that {@link versionErrors} accepts. */
interface ParsedVersion {
  /** The numbers before the pre-release. */
  readonly core: { readonly major: number; readonly minor: number; readonly patch: number }
  /** The pre-release tag and number; undefined for a release version. */
  readonly pre: { readonly tag: string; readonly number: number } | undefined
}

/**
 * Split an accepted version into its numbers.
 * @param version - a version for which {@link versionErrors} returns no violation.
 * @returns the parsed version.
 * @throws Error when the version does not match the accepted forms.
 */
function parse(version: string): ParsedVersion {
  const match = VERSION.exec(version)
  if (match === null) throw new Error(`version "${version}" is not semver of the accepted forms`)
  const pre = match[5] === undefined ? undefined : { tag: match[5], number: Number(match[6]) }
  return { core: { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }, pre }
}

/**
 * The violations of a release version.
 * @param version - the version the release names, without a leading `v`.
 * @param firstPublicRelease - true when the caller passed `--first-public-release`, which admits `1.0.0`.
 * @returns one message per violation; empty when the version is accepted.
 */
export function versionErrors(version: string, firstPublicRelease: boolean): string[] {
  const match = VERSION.exec(version)
  if (match === null) return [`version "${version}" is not semver of the form 0.x.y, 0.x.y-preview.N, 0.x.y-alpha.N, 0.x.y-beta.N or 0.x.y-rc.N`]
  if (match[5] === 'preview' && match[6] === '0') return [`version "${version}" starts previews at 1: use 0.x.y-preview.1`]
  if (match[1] === '0') return []
  if (version !== '1.0.0') return [`version "${version}" is past the pre-release line; only 0.x.y and 1.0.0 are assembled`]
  return firstPublicRelease ? [] : ['1.0.0 is the first public release; pass --first-public-release to assemble it']
}

/**
 * Whether a version is a preview sub-version `x.y.z-preview.N`.
 * @param version - an accepted version.
 * @returns true for a preview.
 */
export function isPreview(version: string): boolean {
  return parse(version).pre?.tag === 'preview'
}

/**
 * The release version a preview leads to.
 * @param version - an accepted version.
 * @returns `x.y.z` for `x.y.z-preview.N`; the version itself otherwise.
 */
export function releaseOf(version: string): string {
  const { major, minor, patch } = parse(version).core
  return `${String(major)}.${String(minor)}.${String(patch)}`
}

/**
 * Order two accepted versions by semver precedence: a pre-release sorts before its release, and pre-release tags sort
 * alphabetically (`alpha`, `beta`, `preview`, `rc`) before their numbers, which compare as numbers.
 * @param a - the first version.
 * @param b - the second version.
 * @returns a negative number when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  if (left.core.major !== right.core.major) return left.core.major - right.core.major
  if (left.core.minor !== right.core.minor) return left.core.minor - right.core.minor
  if (left.core.patch !== right.core.patch) return left.core.patch - right.core.patch
  if (left.pre === undefined) return right.pre === undefined ? 0 : 1
  if (right.pre === undefined) return -1
  if (left.pre.tag !== right.pre.tag) return left.pre.tag < right.pre.tag ? -1 : 1
  return left.pre.number - right.pre.number
}
