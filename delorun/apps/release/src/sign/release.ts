/**
 * Signing a release with the targets key (contract C2): the checks that refuse to sign without the targets-key
 * holder's rebuild, then the signed runtime file lists, the published rebuild record and the signed manifest. Signing
 * runs on the holder's machine with the release workflow's files in a local directory and the holder's rebuild
 * record and rebuild output outside it; it checks that the targets key is a production key and the release tag is
 * signed by a key the allowed-signers file lists, both as the release branch commits them, and that the tag names a
 * commit on the release branch (`sign/source.ts`), checks every file the manifest names, holds the
 * manifest's runtime entries to exactly the release platforms `closure.json` lists at the release's commit, refuses
 * install scripts other than zero-length placeholders, which the rebuild comparison does not cover, checks each npm
 * package's integrity, name and version against its packed tarball (`sign/npm-package.ts`), compares every runtime
 * archive and file list of the workflow's output with the holder's rebuild again, and writes nothing before every
 * check passes.
 *
 * @module @delorun/release/sign/release
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RELEASE_REPOSITORY_URL,
  RELEASE_SCHEMAS,
  RELEASE_FILE_SIZE_LIMITS,
  RUNTIME_PLATFORMS,
  isValidNotes,
  type FileRef,
  type KeyId,
  type ReleaseManifest,
  type RebuildRecord,
  type RootMetadata,
  type RuntimeArtifacts,
  type RuntimePlatform,
  type SignedEnvelope,
  type UtcTimestamp,
} from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { fileDigest } from '@delorun/release-formats/archive/sink'
import { sha256Hex } from '@delorun/release-formats/brands'
import { releaseAdvisoryCheck } from '../advisory/release.ts'
import { closureFileNames } from '../closure/tree.ts'
import { imagesName, readReleaseImages, type ReleaseImages } from '../images/build.ts'
import { sbomName } from '../sbom/release-sbom.ts'
import { attestationProblem } from '../rebuild/attestation.ts'
import { logEntryName } from '@delorun/release-formats/log/bundle'
import { entryRequest } from '@delorun/release-formats/log/entry'
import { entryKeyId, entrySigners, type LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
import { compareOutputs, type Comparison } from '../rebuild/compare.ts'
import { ciMarkers, commitOf, isWithin, outputRefs, packOutputs, rebuildRecordName, recipeAt, recipeDigest, recordToolchain, REQUIRED_SOURCE, requiredOutputs, type CommittedRecipe } from '../rebuild/record.ts'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { canonicalJson, parseStrictJson, toJsonValue, type JsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain } from '@delorun/release-formats/sign/verify'
import { DesktopSchema, ImagesSchema, InstallSchema, ManifestSchema, readEnvelope, readRebuildRecord, ReleaseSummarySchema, StrictRuntimeSchema } from '@delorun/release-formats/sign/schemas'
import { patchRuleProblem } from './patch-rule.ts'
import { npmPackageProblem } from './npm-package.ts'
import { signPacks } from './packs.ts'
import { productionKeyProblem, releaseBranchProblem, tagSignatureProblem } from './source.ts'

/** Signing refused; the message names what is missing or wrong. */
export class SigningRefusal extends Error {
  override readonly name = 'SigningRefusal'
}

/**
 * The manifest the release workflow drafts: everything but the signing time and the rebuild, which signing adds. Unlike
 * a manifest a reader accepts, a draft must carry `security` and `summary`, so every manifest signing writes holds both,
 * and a runtime platform key it does not know is refused instead of dropped.
 */
export const ManifestDraftSchema = ManifestSchema.omit({ published: true, rebuild: true }).extend({ runtime: StrictRuntimeSchema, security: z.boolean(), summary: ReleaseSummarySchema, desktop: DesktopSchema, images: ImagesSchema, install: InstallSchema })

/** {@link ManifestDraftSchema}'s parsed value. */
export type ManifestDraft = Omit<ReleaseManifest, 'published' | 'rebuild' | 'security' | 'summary' | 'desktop' | 'images' | 'install'> & Required<Pick<ReleaseManifest, 'desktop' | 'images' | 'install'>> & { readonly security: boolean, readonly summary: string }

/** The name of the release workflow's manifest draft in the release directory. */
export const MANIFEST_DRAFT_NAME = 'manifest-draft.json'

/** What signing needs. */
export interface SigningRequest {
  /** The repository checkout holding the release's tag. */
  readonly repository: string
  /** The release workflow's files, which signing adds its signed files and the rebuild record to. */
  readonly release: string
  /** The holder's rebuild output on this machine, outside {@link SigningRequest.release}. */
  readonly rebuild: string
  /** The holder's rebuild record, as `record-rebuild.ts` wrote it, outside {@link SigningRequest.release}. */
  readonly record: string
  /** The attestation `build-closure.ts` wrote for the rebuild, outside the release and rebuild directories. */
  readonly attestation: string
  /** The holder's attestation key. */
  readonly attestationKey: Buffer
  /** The targets private key. */
  readonly key: KeyObject
  /** The trusted root files, oldest first; the newest's `logEntryKeys` name the log-entry keys and their order. */
  readonly roots: readonly Uint8Array[]
  /**
   * Log-entry private keys besides the targets key, each with its entry key type, such as the ECDSA P-256 key the newest
   * root lists first. Signing writes one entry request per `active` listed key it holds, the targets key included, in
   * the root's order.
   */
  readonly logEntryKeys: readonly LogEntrySigner[]
  /** The process environment, checked for CI markers. */
  readonly env: NodeJS.ProcessEnv
  /** The signing time. */
  readonly now: Date
  /** The advisory feed the check runs against again; the command passes contract C2's feed. */
  readonly feed: string
  /** Whether the holder states that the release, a patch version, is the first of its major and minor; see `PatchRuleRequest.firstOfLine` in `patch-rule.ts`. */
  readonly firstOfLine: boolean
  /**
   * The branch the release commit must be on, as a revision of {@link SigningRequest.repository}, such as `origin/main`;
   * its commits of `delorun/release/allowed-signers` and `delorun/release/production-keys.json` list the tag signers and the
   * production keys.
   */
  readonly releaseBranch: string
}

/** What signing wrote: besides the signed files, the manifest's release-log entry requests, one per log-entry key in the order the release workflow submits them. */
export interface SignedRelease {
  /** The signed manifest. */
  readonly manifest: ReleaseManifest
  /** The manifest file's name. */
  readonly manifestName: string
  /** The rebuild comparison signing ran. */
  readonly comparison: Comparison
}

/**
 * The keys that sign the release's log entry requests: the newest trusted root's `active` log-entry keys that the
 * request holds, the targets key included, in the root's order.
 * @param request - the roots and keys.
 * @returns the signers.
 * @throws SigningRefusal when the roots do not verify, or the newest root lists no such key.
 */
function entrySignersFor(request: SigningRequest): readonly LogEntrySigner[] {
  let root: RootMetadata
  try {
    root = trustRootChain(request.roots, Math.floor(request.now.getTime() / 1000)).at(-1)!.metadata
  } catch (error) {
    throw new SigningRefusal(`signing refuses: the --root files do not verify: ${(error as Error).message}`, { cause: error })
  }
  const signers = entrySigners(root, [...request.logEntryKeys, { keyDetails: 'PKIX_ED25519_PH', key: request.key }])
  if (signers.length === 0) {
    const what = root.logEntryKeys === undefined ? 'lists no logEntryKeys' : 'lists neither a --log-entry-key nor the targets key as an active log-entry key'
    throw new SigningRefusal(`signing refuses: root ${String(root.version)} ${what}, so no log entry of this release could verify`)
  }
  return signers
}

function refuse(reason: string): never {
  throw new SigningRefusal(`signing refuses: ${reason}. Signing requires ${REQUIRED_SOURCE}.`)
}

function utc(date: Date): UtcTimestamp {
  return brandString<UtcTimestamp>(`${date.toISOString().slice(0, 19)}Z`)
}

async function refOf(directory: string, name: string): Promise<FileRef> {
  const { length, sha256 } = await fileDigest(join(directory, name))
  return { name, length, sha256: sha256Hex(sha256) }
}

/**
 * The runtime entries of a draft, by platform.
 * @param draft - the draft.
 * @returns each listed platform with its archive and file list, in the manifest's platform order.
 */
function runtimeEntries(draft: ManifestDraft): Array<[RuntimePlatform, RuntimeArtifacts]> {
  return RUNTIME_PLATFORMS.flatMap(platform => {
    const artifacts = draft.runtime[platform]
    return artifacts === undefined ? [] : [[platform, artifacts] as [RuntimePlatform, RuntimeArtifacts]]
  })
}

/** Every file reference of a draft, with where it sits. */
function draftRefs(draft: ManifestDraft): Array<{ where: string, ref: FileRef }> {
  const refs: Array<{ where: string, ref: FileRef }> = []
  for (const [platform, artifacts] of runtimeEntries(draft)) refs.push({ where: `runtime.${platform}.archive`, ref: artifacts.archive })
  for (const [platform, files] of Object.entries(draft.desktop)) {
    refs.push({ where: `desktop.${platform}.installer`, ref: files.installer }, { where: `desktop.${platform}.update`, ref: files.update }, { where: `desktop.${platform}.blockmap`, ref: files.blockmap })
  }
  for (const image of ['s2', 's3'] as const) {
    const seccomp = draft.images[image].seccomp
    if (seccomp !== undefined) refs.push({ where: `images.${image}.seccomp`, ref: seccomp })
  }
  refs.push({ where: 'sbom', ref: draft.sbom }, { where: 'install.sh', ref: draft.install.sh }, { where: 'install.ps1', ref: draft.install.ps1 }, { where: 'advisories.report', ref: draft.advisories.report })
  if (draft.notes !== undefined) refs.push({ where: 'notes', ref: draft.notes })
  return refs
}

async function realDirectory(path: string, what: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
    if (!(await lstat(real)).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    refuse(`${what} ${path} is not a directory on this machine: ${(error as Error).message}`)
  }
  return real
}

/**
 * The rebuild checks: the holder's record, rebuild output and attestation, and the comparison with the workflow's files.
 * @param request - the signing request.
 * @param draft - the manifest draft.
 * @param tagged - the commit the release tag names.
 * @returns the record, its bytes and the comparison.
 * @throws SigningRefusal when a check fails.
 */
async function checkRebuild(request: SigningRequest, draft: ManifestDraft, tagged: string): Promise<{ record: RebuildRecord, recordBytes: Buffer, comparison: Comparison }> {
  const markers = ciMarkers(request.env)
  if (markers.length > 0) refuse(`${markers.join(' and ')} is set, so this run is a CI run`)
  const recordName = rebuildRecordName(draft.version)
  const release = await realDirectory(request.release, 'the release directory')
  if (existsSync(join(release, recordName))) refuse(`the release workflow's files hold ${recordName}; the rebuild record comes from the holder's own rebuild (--record), never from the files being signed`)
  const rebuild = await realDirectory(request.rebuild, 'the rebuild output')
  if (isWithin(rebuild, release)) refuse(`the rebuild output ${rebuild} is the release directory or inside it`)
  let recordPath: string
  try {
    recordPath = await realpath(request.record)
  } catch (error) {
    refuse(`no rebuild record exists at ${request.record}: ${(error as Error).message}`)
  }
  if (isWithin(recordPath, release)) refuse(`the rebuild record ${recordPath} lies in the release directory`)
  let record: RebuildRecord
  let recordBytes: Buffer
  try {
    recordBytes = await readFile(recordPath)
    record = readRebuildRecord(recordBytes)
  } catch (error) {
    refuse(`the rebuild record does not read: ${(error as Error).message}`)
  }
  if (record.version !== draft.version) refuse(`the rebuild record is for release ${record.version}, not ${draft.version}`)
  if (record.builder.ci) refuse(`the rebuild record says it was made in CI (builder ${JSON.stringify(record.builder.name)})`)
  if (record.comparison !== 'match') refuse('the rebuild record\'s comparison found a difference')
  if (record.commit !== draft.source.commit) refuse(`the rebuild record's commit ${record.commit} differs from the release's ${draft.source.commit}`)
  if (tagged !== record.commit) refuse(`the rebuild record's commit ${record.commit} differs from the commit ${tagged} that tag ${draft.source.tag} names`)
  let recipe: CommittedRecipe
  try {
    recipe = recipeAt(request.repository, record.commit)
  } catch (error) {
    refuse(`the recipe at ${record.commit} does not read: ${(error as Error).message}`)
  }
  if (record.recipe !== recipeDigest(request.repository, record.commit)) refuse(`the rebuild record's recipe digest is not the recipe at ${record.commit}`)
  const drafted = runtimeEntries(draft).map(([platform]) => platform)
  if (JSON.stringify([...drafted].sort()) !== JSON.stringify([...recipe.closure.platforms].sort())) {
    throw new SigningRefusal(`signing refuses: the draft publishes a runtime for ${drafted.join(', ')}, but the release platforms closure.json lists at ${record.commit} are ${recipe.closure.platforms.join(', ')}`)
  }
  const pinned = recordToolchain(recipe.toolchain)
  if (JSON.stringify(record.toolchain) !== JSON.stringify(pinned)) {
    refuse(`the rebuild record's toolchain ${JSON.stringify(record.toolchain)} is not the toolchain pinned at ${record.commit}, ${JSON.stringify(pinned)}`)
  }
  let local: FileRef[]
  try {
    local = await outputRefs(rebuild)
  } catch (error) {
    refuse(`the rebuild output does not read: ${(error as Error).message}`)
  }
  if (JSON.stringify(local) !== JSON.stringify(record.outputs)) {
    refuse(`the files in ${rebuild} do not reproduce the digests the rebuild record lists`)
  }
  const names = new Set(local.map(ref => ref.name))
  const missing = [...requiredOutputs(draft.version, recipe.closure.platforms, draft.images), ...await packOutputs(release, draft.version)].filter(name => !names.has(name))
  if (missing.length > 0) refuse(`the rebuild output lacks ${missing.join(', ')}; the comparison covers every release platform's runtime archive and file list, the SBOM, the images file, the images' seccomp profiles and every pack the packs file names`)
  let attestationPath: string
  let attestation: Buffer
  try {
    attestationPath = await realpath(request.attestation)
    attestation = await readFile(attestationPath)
  } catch (error) {
    refuse(`no rebuild attestation exists at ${request.attestation}: ${(error as Error).message}; build-closure.ts writes it with --attestation-key`)
  }
  if (isWithin(attestationPath, release) || isWithin(attestationPath, rebuild)) refuse(`the rebuild attestation ${attestationPath} lies in the release or rebuild directory`)
  const unattested = attestationProblem(request.attestationKey, attestation, { version: draft.version, commit: record.commit, outputs: local })
  if (unattested !== undefined) refuse(`the rebuild attestation does not cover the rebuild in ${rebuild}: ${unattested}. The rebuild directory must be the one build-closure.ts wrote on this machine`)
  const comparison = await compareOutputs(release, rebuild, recipe, names)
  if (comparison.differences.length > 0) {
    const first = comparison.differences[0]!
    refuse(`compare-rebuild finds ${String(comparison.differences.length)} differences between the release workflow's output and the rebuild, first ${first.file}${first.entry === undefined ? '' : `: ${first.entry}`}: ${first.detail}`)
  }
  return { record, recordBytes, comparison }
}

/** The suffix of the temporary files signing writes before renaming them into place. */
const PENDING_SUFFIX = '.signing'

/**
 * Write every output under a temporary name, then rename each into place, so a failure while writing leaves the
 * release directory as it was; the manifest is renamed last.
 * @param directory - the release directory.
 * @param outputs - each output's name and content, the manifest last.
 * @throws SigningRefusal when a temporary file cannot be written; the temporary files written so far are removed.
 */
async function writeAll(directory: string, outputs: ReadonlyArray<readonly [string, string | Buffer]>): Promise<void> {
  const written: string[] = []
  try {
    for (const [name, content] of outputs) {
      await writeFile(join(directory, `${name}${PENDING_SUFFIX}`), content, { flag: 'wx', mode: 0o644 })
      written.push(name)
    }
  } catch (error) {
    await Promise.all(written.map(name => rm(join(directory, `${name}${PENDING_SUFFIX}`), { force: true })))
    throw new SigningRefusal(`signing refuses: writing the signed files failed, and nothing was changed: ${(error as Error).message}`, { cause: error })
  }
  for (const [name] of outputs) await rename(join(directory, `${name}${PENDING_SUFFIX}`), join(directory, name))
}

/** The message stem of the refusal of an install script that is not a zero-length placeholder. */
export const INSTALL_SCRIPT_REFUSAL = 'the install scripts are not in the rebuild comparison yet'

/**
 * Check a release and sign it: the runtime file lists in place, then the manifest. Besides the rebuild, the advisory
 * check and the draft's files, the checks include the release tag's signature and branch (`source.ts`), the install
 * scripts' placeholders, the npm packages' tarballs (`npm-package.ts`) and the patch rule of `patch-rule.ts`.
 * @param request - the directories, rebuild record, key, allowed signers, release branch and environment.
 * @returns the signed manifest and the comparison.
 * @throws SigningRefusal when any check fails; nothing is written then.
 * @throws Error when git cannot be started or cannot list the repository's tags for the patch rule; nothing is
 *   written then either.
 */
export async function signRelease(request: SigningRequest): Promise<SignedRelease> {
  let draft: ManifestDraft
  try {
    const parsed = ManifestDraftSchema.safeParse(parseStrictJson(await readFile(join(request.release, MANIFEST_DRAFT_NAME)), 1024 * 1024))
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replaceAll('\n', '; '))
    draft = parsed.data
  } catch (error) {
    throw new SigningRefusal(`signing refuses: the manifest draft ${MANIFEST_DRAFT_NAME} does not read: ${(error as Error).message}`)
  }
  if (draft.source.repository !== RELEASE_REPOSITORY_URL || draft.source.tag !== `v${draft.version}`) {
    throw new SigningRefusal(`signing refuses: the draft's source must be ${RELEASE_REPOSITORY_URL} at tag v${draft.version}`)
  }
  for (const [platform, named] of runtimeEntries(draft)) {
    const expected = closureFileNames(draft.version, platform)
    if (named.archive.name !== expected.archive || named.files.name !== expected.files) {
      throw new SigningRefusal(`signing refuses: the draft names ${named.archive.name} and ${named.files.name} for ${platform}; a release's ${platform} runtime is ${expected.archive} and ${expected.files}`)
    }
  }
  if (draft.sbom.name !== sbomName(draft.version)) throw new SigningRefusal(`signing refuses: the draft names ${draft.sbom.name} as the SBOM; a release's SBOM is ${sbomName(draft.version)}`)
  for (const [where, script] of [['install.sh', draft.install.sh], ['install.ps1', draft.install.ps1]] as const) {
    if (script.length !== 0) throw new SigningRefusal(`signing refuses: the draft's ${where} is ${script.name} of ${String(script.length)} bytes, but ${INSTALL_SCRIPT_REFUSAL}, so a release lists each install script only as a zero-length placeholder`)
  }
  let tagged: string
  try {
    tagged = commitOf(request.repository, `refs/tags/${draft.source.tag}`)
  } catch (error) {
    throw new SigningRefusal(`signing refuses: the tag ${draft.source.tag} names no commit in ${request.repository}: ${(error as Error).message}`)
  }
  const offBranch = await releaseBranchProblem(request.repository, tagged, request.releaseBranch)
  if (offBranch !== undefined) throw new SigningRefusal(`signing refuses: ${offBranch}`)
  const unlisted = await productionKeyProblem(request.repository, request.releaseBranch, publicKeyEntry(request.key).keyid, 'targets')
  if (unlisted !== undefined) throw new SigningRefusal(`signing refuses: ${unlisted}`)
  for (const signer of request.logEntryKeys) {
    const unlistedEntryKey = await productionKeyProblem(request.repository, request.releaseBranch, brandString<KeyId>(entryKeyId(signer.key)), `${signer.keyDetails} log-entry`)
    if (unlistedEntryKey !== undefined) throw new SigningRefusal(`signing refuses: ${unlistedEntryKey}`)
  }
  const signers = entrySignersFor(request)
  const unsigned = await tagSignatureProblem(request.repository, draft.source.tag, request.releaseBranch)
  if (unsigned !== undefined) throw new SigningRefusal(`signing refuses: ${unsigned}`)
  const { record, recordBytes, comparison } = await checkRebuild(request, draft, tagged)
  const patchProblem = patchRuleProblem({ repository: request.repository, version: draft.version, dsh: draft.dsh, commit: record.commit, firstOfLine: request.firstOfLine })
  if (patchProblem !== undefined) throw new SigningRefusal(`signing refuses: ${patchProblem}`)
  let built: ReleaseImages | undefined
  try {
    built = await readReleaseImages(request.release, draft.version)
  } catch (error) {
    throw new SigningRefusal(`signing refuses: ${imagesName(draft.version)} does not read: ${(error as Error).message}`)
  }
  if (built === undefined) throw new SigningRefusal(`signing refuses: ${imagesName(draft.version)} is not in ${request.release}`)
  if (canonicalJson(toJsonValue(draft.images)) !== canonicalJson(toJsonValue({ s2: built.s2, s3: built.s3 }))) {
    throw new SigningRefusal(`signing refuses: the draft's images are not the images ${imagesName(draft.version)} records, which the rebuild comparison checked`)
  }
  const recordName = rebuildRecordName(draft.version)
  const recordRef: FileRef = { name: recordName, length: recordBytes.byteLength, sha256: sha256Hex(createHash('sha256').update(recordBytes).digest('hex')) }
  const advisories = await releaseAdvisoryCheck(request.repository, record.commit, request.release, draft.version, request.feed)
  if (advisories.result !== 'pass') throw new SigningRefusal(`signing refuses: the dependency advisory check fails: ${advisories.problems.join('; ')}`)
  const accepted = [...new Set(advisories.findings.map(finding => finding.advisory))].sort()
  if (JSON.stringify(accepted) !== JSON.stringify([...draft.advisories.accepted].sort())) {
    throw new SigningRefusal(`signing refuses: the draft's accepted advisories (${draft.advisories.accepted.join(', ') || 'none'}) are not the ones the check accepts (${accepted.join(', ') || 'none'})`)
  }
  let published: JsonValue
  try {
    published = parseStrictJson(await readFile(join(request.release, draft.advisories.report.name)), 4 * 1024 * 1024)
  } catch (error) {
    throw new SigningRefusal(`signing refuses: the advisory report ${draft.advisories.report.name} does not read: ${(error as Error).message}`)
  }
  if (canonicalJson(published) !== canonicalJson(toJsonValue(advisories))) {
    throw new SigningRefusal(`signing refuses: the advisory report ${draft.advisories.report.name} is not the report signing's own check gives; run the check again and draft the release from its report`)
  }
  for (const { where, ref } of draftRefs(draft)) {
    if (!existsSync(join(request.release, ref.name))) throw new SigningRefusal(`signing refuses: ${where} names ${ref.name}, which is not in ${request.release}`)
    const actual = await refOf(request.release, ref.name)
    if (actual.length !== ref.length || actual.sha256 !== ref.sha256) throw new SigningRefusal(`signing refuses: ${ref.name} does not match ${where} in the draft`)
  }
  if (draft.notes !== undefined && !isValidNotes(await readFile(join(request.release, draft.notes.name)))) {
    throw new SigningRefusal(`signing refuses: ${draft.notes.name} is not valid release notes: well-formed UTF-8 of 1 to ${String(RELEASE_FILE_SIZE_LIMITS.notes)} bytes with no control (except line feed and tab), format, line-separator or lone-surrogate character`)
  }
  for (const entry of draft.npm) {
    const problem = await npmPackageProblem(request.release, entry)
    if (problem !== undefined) throw new SigningRefusal(`signing refuses: ${problem}`)
  }
  const signedLists = new Map<string, string>()
  const runtime: Record<string, { archive: FileRef, files: FileRef }> = {}
  for (const [platform, artifacts] of runtimeEntries(draft)) {
    const listRef = artifacts.files
    let list: SignedEnvelope<JsonValue>
    try {
      const envelope = readEnvelope('files', await readFile(join(request.release, listRef.name)))
      if (envelope.signed.version !== draft.version || envelope.signed.platform !== platform) throw new Error(`it is for ${envelope.signed.version} ${envelope.signed.platform}`)
      list = { signed: envelope.signedJson, signatures: envelope.signatures }
    } catch (error) {
      throw new SigningRefusal(`signing refuses: the ${platform} file list ${listRef.name} does not read: ${(error as Error).message}`)
    }
    const text = `${JSON.stringify(signEnvelope(list, [request.key]), undefined, 2)}\n`
    signedLists.set(listRef.name, text)
    runtime[platform] = { archive: artifacts.archive, files: { name: listRef.name, length: Buffer.byteLength(text), sha256: sha256Hex(createHash('sha256').update(text).digest('hex')) } }
  }
  const manifest: ReleaseManifest = {
    ...draft,
    schema: RELEASE_SCHEMAS.manifest,
    runtime: runtime as ReleaseManifest['runtime'],
    published: utc(request.now),
    rebuild: { record: recordRef, builders: [{ name: record.builder.name, ci: false }] },
  }
  const manifestName = `delorun-${draft.version}.manifest.json`
  const manifestPath = join(request.release, manifestName)
  if (existsSync(manifestPath)) throw new SigningRefusal(`signing refuses: ${manifestName} already exists`)
  const envelope = signEnvelope({ signed: toJsonValue(manifest), signatures: [] }, [request.key])
  const manifestBytes = Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`)
  const entries = signers.map((signer, position) => [logEntryName(draft.version, position), Buffer.from(`${JSON.stringify(entryRequest(manifestBytes, signer.key, signer.keyDetails), undefined, 2)}\n`)] as const)
  const packFiles = await signPacks(request.release, draft.version, manifestBytes, request.key, signers).catch((error: unknown) => {
    throw new SigningRefusal(`signing refuses: the packs file: ${(error as Error).message}`, { cause: error })
  })
  const outputs: Array<readonly [string, string | Buffer]> = [...signedLists, [recordName, recordBytes], ...entries, ...packFiles, [manifestName, manifestBytes]]
  await writeAll(request.release, outputs)
  return { manifest, manifestName, comparison }
}
