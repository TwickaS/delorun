/**
 * The release versions the assembly accepts: `0.x.y` with an optional `-alpha.N`, `-beta.N` or `-rc.N` pre-release,
 * and `1.0.0` only when the first public release is named. The pattern is strict semver with no leading zeros, so a
 * version is always safe as a path segment.
 *
 * @module @delo/release/changelog/version
 */

/** Strict semver for the accepted forms; group 1 is the major number. */
const VERSION = /^(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/

/**
 * The violations of a release version.
 * @param version - the version the release names, without a leading `v`.
 * @param firstPublicRelease - true when the caller passed `--first-public-release`, which admits `1.0.0`.
 * @returns one message per violation; empty when the version is accepted.
 */
export function versionErrors(version: string, firstPublicRelease: boolean): string[] {
  const match = VERSION.exec(version)
  if (match === null) return [`version "${version}" is not semver of the form 0.x.y, 0.x.y-alpha.N, 0.x.y-beta.N or 0.x.y-rc.N`]
  if (match[1] === '0') return []
  if (version !== '1.0.0') return [`version "${version}" is past the pre-release line; only 0.x.y and 1.0.0 are assembled`]
  return firstPublicRelease ? [] : ['1.0.0 is the first public release; pass --first-public-release to assemble it']
}
