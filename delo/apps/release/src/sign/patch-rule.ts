/**
 * The patch rule signing applies (contract C2, R12): a release whose version is a patch of an existing release, the
 * same major and minor as a lower `v<major>.<minor>.<patch>` tag that is not a pre-release, keeps that release's
 * upstream DSH version, its data formats and its plugin-facing interface. A security fix then ships as a patch that
 * disables no plugin and needs no data copy, and a release that moves the upstream base, changes a data format or
 * changes the interface is at least a minor. Independently of patches, the draft's `dsh` must be the version of
 * `@deepseek-ai/dsh-app-boot` at the release commit, so every manifest states the base it was built on.
 *
 * A missing tag must not skip the rule, so before comparing, {@link releaseLineProblem} checks the earlier releases the
 * local tags name against git's history and the committed changelog, and a patch version with no earlier release
 * needs the signer's explicit statement that it is the first of its line.
 *
 * Every fact is read from git objects at the tags' and the release's commits, never from the checkout.
 *
 * @module @delo/release/sign/patch-rule
 */
import { execFileSync } from 'node:child_process'
import semver from 'semver'
import { z } from 'zod'
import { CHANGELOG_SCHEMA } from '../changelog/data.ts'
import { DATA_PATH } from '../changelog/paths.ts'
import { PERSISTENCE_SCHEMA_PATH } from '../closure/data-formats.ts'
import type { PluginInterface } from '@delo/contract-plugin-versions'
import { parseStrictJson, type JsonValue } from '@delo/release-formats/sign/json'
import { describeEntry, entryKey, PLUGIN_INTERFACE_PATH, readPluginInterface, sourceOffers } from './plugin-interface.ts'

/** The package whose `version` is the upstream DSH version a commit builds on (contract C17). */
export const UPSTREAM_VERSION_PATH = 'packages/boot/app-boot/package.json'

/** The versions of Delo's own records, which `@delo/update` reads as `DELO_RECORDS`. */
export const DELO_RECORDS_PATH = 'delo/packages/update/src/data-records.json'

/** What the rule needs to know about the release being signed. */
export interface PatchRuleRequest {
  /** The repository holding the release's and the earlier releases' tags. */
  readonly repository: string
  /** The release's version, from the draft. */
  readonly version: string
  /** The draft's upstream DSH version. */
  readonly dsh: string
  /** The commit the release's tag names. */
  readonly commit: string
  /**
   * The signer's statement (`sign-release.ts --first-of-line`) that this patch version, such as `0.1.3` when `0.1.0` to
   * `0.1.2` were never released, is the first release of its major and minor. Without it, a patch version with no
   * earlier release refuses, so a checkout that lacks the earlier tags never skips the rule.
   */
  readonly firstOfLine: boolean
}

/** An earlier release the version is a patch of. */
export interface EarlierRelease {
  /** Its version. */
  readonly version: string
  /** Its tag, `v<version>`. */
  readonly tag: string
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u

/**
 * The bytes of a file at a commit.
 * @param repository - the repository.
 * @param commit - the commit or tag.
 * @param path - the repository-relative path.
 * @returns the bytes, or undefined when git shows no such file there.
 */
function fileAt(repository: string, commit: string, path: string): Buffer | undefined {
  try {
    return execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (_missing) {
    // git exits non-zero when the path is not a file at the commit; the caller refuses, never treating it as equal.
    return undefined
  }
}

/**
 * The upstream DSH version a commit builds on.
 * @param repository - the repository.
 * @param commit - the commit or tag.
 * @returns the `version` of {@link UPSTREAM_VERSION_PATH} there, or undefined when the file is absent, is not JSON or
 * holds no string `version`.
 */
export function upstreamVersionAt(repository: string, commit: string): string | undefined {
  const bytes = fileAt(repository, commit, UPSTREAM_VERSION_PATH)
  if (bytes === undefined) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch (_malformed) {
    // A package.json that is not JSON names no version; the caller refuses.
    return undefined
  }
  if (manifest === null || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string') return undefined
  return manifest.version
}

/**
 * The existing releases a version is a patch of: every `v<major>.<minor>.<patch>` tag with the version's major and
 * minor, lower than the version without its pre-release suffix, and without a pre-release suffix of its own, nearest
 * first.
 * @param repository - the repository.
 * @param version - the release's version; `0.1.3-rc.1` is treated as `0.1.3`.
 * @returns the earlier releases; none for an `X.Y.0` release or the first release of a minor.
 * @throws Error when the version is not a semantic version or git cannot list the tags.
 */
export function earlierReleases(repository: string, version: string): EarlierRelease[] {
  const parsed = semver.parse(version)
  if (parsed === null) throw new Error(`${version} is not a semantic version`)
  const core = `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repository, encoding: 'utf8' }).split('\n')
  const earlier: EarlierRelease[] = []
  for (const tag of tags) {
    const match = RELEASE_TAG.exec(tag)
    const tagged = match === null ? null : semver.parse(match[1])
    if (tagged === null || tagged.prerelease.length > 0) continue
    if (tagged.major !== parsed.major || tagged.minor !== parsed.minor || !semver.lt(tagged, core)) continue
    earlier.push({ version: tagged.version, tag })
  }
  return earlier.sort((left, right) => semver.rcompare(left.version, right.version))
}

/** The changelog data file's size limit before parsing. */
const CHANGELOG_SIZE_LIMIT = 16 * 1024 * 1024

/** A version string the changelog lists: strict semantic version text. */
const listedVersion = z.string().refine(version => semver.valid(version) === version, 'a semantic version')

/** The fields of `delo/changelog/changelog.json` the rule reads: every assembled version and the previews folded into one. */
const ChangelogVersionsSchema = z.object({
  schema: z.literal(CHANGELOG_SCHEMA),
  versions: z.array(z.object({ version: listedVersion, previews: z.array(z.object({ version: listedVersion })) })),
})

/**
 * Whether git shows one commit to be an ancestor of another.
 * @param repository - the repository.
 * @param ancestor - the revision that must be an ancestor, such as `refs/tags/v0.1.2^{commit}`.
 * @param commit - the descendant commit.
 * @returns true when `git merge-base --is-ancestor` exits 0; false when it exits otherwise, including when git cannot
 * resolve either revision, so an unknown answer refuses.
 */
function isAncestor(repository: string, ancestor: string, commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: repository, stdio: ['ignore', 'ignore', 'pipe'] })
    return true
  } catch (_notAncestor) {
    // Exit 1 means "not an ancestor"; any other exit means git could not answer, which the caller refuses as well.
    return false
  }
}

/**
 * The versions `delo/changelog/changelog.json` lists at a commit.
 * @param repository - the repository.
 * @param commit - the release commit.
 * @returns every assembled version and folded preview, or why the file cannot be read there.
 */
function changelogVersionsAt(repository: string, commit: string): Set<string> | string {
  const bytes = fileAt(repository, commit, DATA_PATH)
  if (bytes === undefined) return `${DATA_PATH} is missing at the release commit ${commit}`
  let value: JsonValue
  try {
    value = parseStrictJson(bytes, CHANGELOG_SIZE_LIMIT)
  } catch (error) {
    return `${DATA_PATH} at the release commit ${commit} is not strict JSON: ${(error as Error).message}`
  }
  const parsed = ChangelogVersionsSchema.safeParse(value)
  if (!parsed.success) return `${DATA_PATH} at the release commit ${commit} is not a ${CHANGELOG_SCHEMA} version list: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`
  return new Set(parsed.data.versions.flatMap(entry => [entry.version, ...entry.previews.map(preview => preview.version)]))
}

/**
 * Whether the earlier releases the local tags name are the whole line the release continues, before the patch rule
 * compares the release with them. It applies to a patch version (patch number above 0, any pre-release suffix
 * ignored) and checks, in order:
 *
 * 1. every earlier tag's commit is an ancestor of the release commit (`git merge-base --is-ancestor`), so a tag on
 *    another line of history is refused;
 * 2. `delo/changelog/changelog.json` at the release commit, the committed record of every assembled version, lists
 *    every earlier tag's version, and every non-pre-release version of the same major and minor below the release
 *    that it lists has a tag, so a tag missing from the checkout, or one the record never assembled, is refused;
 * 3. the release has an earlier release, or the request says it is the first of its line, and not both.
 *
 * The changelog records versions, not commits, so this is the strongest cross-check the committed record supports. It
 * does not prove that an earlier tag names the commit that release was published from: a tag moved to another
 * ancestor commit passes. Both sources are written in the same repository, so a history whose changelog also omits a
 * released version passes too; the published manifests and the release log, which would show it, are not consulted.
 * @param request - the release being signed.
 * @param earlier - the earlier releases {@link earlierReleases} found.
 * @returns why signing must refuse, naming the check and the remedy; undefined when the line checks pass or the
 * version is no patch.
 * @throws Error when the version is not a semantic version.
 */
export function releaseLineProblem(request: PatchRuleRequest, earlier: readonly EarlierRelease[]): string | undefined {
  const parsed = semver.parse(request.version)
  if (parsed === null) throw new Error(`${request.version} is not a semantic version`)
  const line = `${String(parsed.major)}.${String(parsed.minor)}`
  if (parsed.patch === 0) {
    return request.firstOfLine ? `--first-of-line is only for a patch version; release ${request.version} is the first of ${line} by its version, so sign it without --first-of-line` : undefined
  }
  const fetch = 'fetch the published tags (git fetch --tags) and sign again'
  for (const release of earlier) {
    if (!isAncestor(request.repository, `refs/tags/${release.tag}^{commit}`, request.commit)) {
      return `the tag ${release.tag} does not name an ancestor of the release commit ${request.commit}, so it is not the ${release.version} that release ${request.version} continues; delete the local tag, ${fetch}`
    }
  }
  const listed = changelogVersionsAt(request.repository, request.commit)
  if (typeof listed === 'string') return `release ${request.version} is a patch version, and ${listed}, so the rule cannot cross-check the earlier releases of ${line} that the tags name with the assembled versions it records`
  for (const release of earlier) {
    if (!listed.has(release.version)) return `the tag ${release.tag} names release ${release.version}, which ${DATA_PATH} at the release commit does not list as assembled; a tag of a version never assembled is not a release, so delete the local tag, ${fetch}`
  }
  const tagged = new Set(earlier.map(release => release.version))
  const core = `${line}.${String(parsed.patch)}`
  for (const version of [...listed].sort(semver.compare)) {
    const assembled = semver.parse(version)!
    if (assembled.prerelease.length > 0 || assembled.major !== parsed.major || assembled.minor !== parsed.minor || !semver.lt(assembled, core) || tagged.has(version)) continue
    return `${DATA_PATH} at the release commit lists release ${version}, but this repository has no tag v${version}, so the patch rule cannot compare release ${request.version} with it; ${fetch}`
  }
  if (earlier.length > 0 && request.firstOfLine) return `--first-of-line states that release ${request.version} is the first of ${line}, but ${earlier.map(release => release.tag).join(', ')} is tagged; sign without --first-of-line`
  if (earlier.length === 0 && !request.firstOfLine) {
    return `release ${request.version} is a patch version, but no earlier release of ${line} is tagged here and listed in ${DATA_PATH}, so the patch rule has nothing to compare it with; a missing tag must not skip the rule: ${fetch}, or, when ${request.version} is the first release of ${line}, sign with --first-of-line`
  }
  return undefined
}

/** The version a release that may not be a patch is released as instead. */
function nextMinor(version: string): string {
  const parsed = semver.parse(version)!
  return `${String(parsed.major)}.${String(parsed.minor + 1)}.0`
}

/** One earlier release's differences from the release being signed, or undefined when it has none. */
function differenceFrom(request: PatchRuleRequest, earlier: EarlierRelease): string | undefined {
  const patch = `release ${request.version} is a patch of ${earlier.version}`
  const minor = `release it as ${nextMinor(request.version)}`
  const base = upstreamVersionAt(request.repository, earlier.tag)
  if (base === undefined) return `${patch}, and ${UPSTREAM_VERSION_PATH} at ${earlier.tag} names no version, so the rule cannot show the upstream base is unchanged; ${minor}`
  if (base !== request.dsh) return `${patch} and moves DSH from ${base} to ${request.dsh}; a release that moves the upstream base is at least a minor: ${minor}`
  for (const path of [PERSISTENCE_SCHEMA_PATH, DELO_RECORDS_PATH]) {
    const before = fileAt(request.repository, earlier.tag, path)
    const after = fileAt(request.repository, request.commit, path)
    if (before === undefined || after === undefined) {
      return `${patch}, and ${path} is missing at ${before === undefined ? earlier.tag : request.commit}, so the rule cannot show the data formats are unchanged; ${minor}`
    }
    if (!before.equals(after)) return `${patch} and changes ${path}; a release that changes a data format is at least a minor: ${minor}`
  }
  return interfaceDifference(request, earlier, patch, minor)
}

/** The plugin-facing interface's difference between an earlier release and the release being signed. */
function interfaceDifference(request: PatchRuleRequest, earlier: EarlierRelease, patch: string, minor: string): string | undefined {
  const read = (commit: string): PluginInterface | string => {
    const bytes = fileAt(request.repository, commit, PLUGIN_INTERFACE_PATH)
    if (bytes === undefined) return `${PLUGIN_INTERFACE_PATH} is missing at ${commit}`
    try {
      return readPluginInterface(bytes)
    } catch (error) {
      return `${PLUGIN_INTERFACE_PATH} at ${commit} does not read: ${(error as Error).message}`
    }
  }
  const before = read(earlier.tag)
  if (typeof before === 'string') return `${patch}, and ${before}, so the rule cannot show the plugin-facing interface is unchanged; ${minor}`
  const after = read(request.commit)
  if (typeof after === 'string') return `${patch}, and ${after}, so the rule cannot show the plugin-facing interface is unchanged; ${minor}`
  const covered = after.covered
  const keys = new Set(covered.map(entryKey))
  const earlierKeys = new Set(before.covered.map(entryKey))
  const removed = before.covered.filter(entry => !keys.has(entryKey(entry))).map(entry => `removes ${describeEntry(entry)}`)
  const added = covered.filter(entry => !earlierKeys.has(entryKey(entry))).map(entry => `adds ${describeEntry(entry)}`)
  const changes = [...removed, ...added]
  if (changes.length > 0) return `${patch} and changes the plugin-facing interface: it ${changes.join(', ')}; a release that changes the plugin-facing interface, by adding to it too, is at least a minor: ${minor}`
  for (const entry of covered) {
    const source = fileAt(request.repository, request.commit, entry.source)
    if (source === undefined || !sourceOffers(entry, source.toString('utf8'))) {
      return `${patch}, and the release commit no longer offers the ${describeEntry(entry)} that ${PLUGIN_INTERFACE_PATH} lists; a release that removes from the plugin-facing interface is at least a minor: restore it, or remove it from the inventory and ${minor}`
    }
  }
  return undefined
}

/**
 * Check the patch rule and the draft's upstream base for a release about to be signed.
 * @param request - the repository, the draft's version and `dsh`, and the commit the release's tag names.
 * @returns why signing must refuse, naming the earlier release, what differs and the remedy; undefined when the release
 * may be signed.
 * @throws Error when the version is not a semantic version or git cannot list the tags.
 */
export function patchRuleProblem(request: PatchRuleRequest): string | undefined {
  const base = upstreamVersionAt(request.repository, request.commit)
  if (base === undefined) return `${UPSTREAM_VERSION_PATH} at the release commit ${request.commit} names no version, so the draft's dsh ${request.dsh} cannot be shown to be the upstream base the release builds on`
  if (base !== request.dsh) return `the draft's dsh ${request.dsh} is not ${base}, the upstream version ${UPSTREAM_VERSION_PATH} names at the release commit ${request.commit}; draft the release with dsh ${base}`
  const releases = earlierReleases(request.repository, request.version)
  const line = releaseLineProblem(request, releases)
  if (line !== undefined) return line
  for (const earlier of releases) {
    const difference = differenceFrom(request, earlier)
    if (difference !== undefined) return difference
  }
  return undefined
}
