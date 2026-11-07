/**
 * Signing a release with the targets key (contract C2): the checks that refuse to sign without the targets-key
 * holder's rebuild, then the signed runtime file lists, the published rebuild record and the signed manifest. Signing
 * runs on the holder's machine with the release workflow's files in a local directory and the holder's rebuild
 * record and rebuild output outside it; it checks every file the manifest names, compares every runtime archive and
 * file list of the workflow's output with the holder's rebuild again, and writes nothing before every check passes.
 *
 * @module @delo/release/sign/release
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RELEASE_REPOSITORY_URL,
  RELEASE_SCHEMAS,
  RUNTIME_PLATFORMS,
  type FileRef,
  type ReleaseManifest,
  type RebuildRecord,
  type SignedEnvelope,
  type UtcTimestamp,
} from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { fileDigest } from '../archive/sink.ts'
import { sha256Hex } from '../brands.ts'
import { releaseAdvisoryCheck } from '../advisory/release.ts'
import { closureFileNames } from '../closure/tree.ts'
import { sbomName } from '../sbom/release-sbom.ts'
import { attestationProblem } from '../rebuild/attestation.ts'
import { compareOutputs, type Comparison } from '../rebuild/compare.ts'
import { ciMarkers, commitOf, isWithin, outputRefs, rebuildRecordName, recipeAt, recipeDigest, recordToolchain, REQUIRED_SOURCE, requiredOutputs, type CommittedRecipe } from '../rebuild/record.ts'
import { signEnvelope } from './envelope.ts'
import { canonicalJson, parseStrictJson, toJsonValue, type JsonValue } from './json.ts'
import { ManifestSchema, readEnvelope, readRebuildRecord } from './schemas.ts'

/** Signing refused; the message names what is missing or wrong. */
export class SigningRefusal extends Error {
  override readonly name = 'SigningRefusal'
}

/** The manifest the release workflow drafts: everything but the signing time and the rebuild, which signing adds. */
export const ManifestDraftSchema = ManifestSchema.omit({ published: true, rebuild: true })

/** {@link ManifestDraftSchema}'s parsed value. */
export type ManifestDraft = Omit<ReleaseManifest, 'published' | 'rebuild'>

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
  /** The process environment, checked for CI markers. */
  readonly env: NodeJS.ProcessEnv
  /** The signing time. */
  readonly now: Date
  /** The advisory feed the check runs against again; the command passes contract C2's feed. */
  readonly feed: string
}

/** What signing wrote. */
export interface SignedRelease {
  /** The signed manifest. */
  readonly manifest: ReleaseManifest
  /** The manifest file's name. */
  readonly manifestName: string
  /** The rebuild comparison signing ran. */
  readonly comparison: Comparison
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

/** Every file reference of a draft, with where it sits. */
function draftRefs(draft: ManifestDraft): Array<{ where: string, ref: FileRef }> {
  const refs: Array<{ where: string, ref: FileRef }> = []
  for (const platform of RUNTIME_PLATFORMS) refs.push({ where: `runtime.${platform}.archive`, ref: draft.runtime[platform].archive })
  for (const [platform, files] of Object.entries(draft.desktop)) {
    refs.push({ where: `desktop.${platform}.installer`, ref: files.installer }, { where: `desktop.${platform}.update`, ref: files.update }, { where: `desktop.${platform}.blockmap`, ref: files.blockmap })
  }
  refs.push({ where: 'sbom', ref: draft.sbom }, { where: 'install.sh', ref: draft.install.sh }, { where: 'install.ps1', ref: draft.install.ps1 }, { where: 'advisories.report', ref: draft.advisories.report })
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

async function checkRebuild(request: SigningRequest, draft: ManifestDraft): Promise<{ record: RebuildRecord, recordBytes: Buffer, comparison: Comparison }> {
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
  let tagged: string
  try {
    tagged = commitOf(request.repository, draft.source.tag)
  } catch (error) {
    refuse(`the tag ${draft.source.tag} names no commit in ${request.repository}: ${(error as Error).message}`)
  }
  if (tagged !== record.commit) refuse(`the rebuild record's commit ${record.commit} differs from the commit ${tagged} that tag ${draft.source.tag} names`)
  let recipe: CommittedRecipe
  try {
    recipe = recipeAt(request.repository, record.commit)
  } catch (error) {
    refuse(`the recipe at ${record.commit} does not read: ${(error as Error).message}`)
  }
  if (record.recipe !== recipeDigest(request.repository, record.commit)) refuse(`the rebuild record's recipe digest is not the recipe at ${record.commit}`)
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
  const missing = requiredOutputs(draft.version).filter(name => !names.has(name))
  if (missing.length > 0) refuse(`the rebuild output lacks ${missing.join(', ')}; the comparison covers every runtime archive and file list and the SBOM`)
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

/**
 * Check a release and sign it: the runtime file lists in place, then the manifest.
 * @param request - the directories, rebuild record, key and environment.
 * @returns the signed manifest and the comparison.
 * @throws SigningRefusal when any check fails; nothing is written then.
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
  for (const platform of RUNTIME_PLATFORMS) {
    const expected = closureFileNames(draft.version, platform)
    const named = draft.runtime[platform]
    if (named.archive.name !== expected.archive || named.files.name !== expected.files) {
      throw new SigningRefusal(`signing refuses: the draft names ${named.archive.name} and ${named.files.name} for ${platform}; a release's ${platform} runtime is ${expected.archive} and ${expected.files}`)
    }
  }
  if (draft.sbom.name !== sbomName(draft.version)) throw new SigningRefusal(`signing refuses: the draft names ${draft.sbom.name} as the SBOM; a release's SBOM is ${sbomName(draft.version)}`)
  const { record, recordBytes, comparison } = await checkRebuild(request, draft)
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
  const signedLists = new Map<string, string>()
  const runtime: Record<string, { archive: FileRef, files: FileRef }> = {}
  for (const platform of RUNTIME_PLATFORMS) {
    const listRef = draft.runtime[platform].files
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
    runtime[platform] = { archive: draft.runtime[platform].archive, files: { name: listRef.name, length: Buffer.byteLength(text), sha256: sha256Hex(createHash('sha256').update(text).digest('hex')) } }
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
  const outputs: Array<[string, string | Buffer]> = [...signedLists, [recordName, recordBytes], [manifestName, `${JSON.stringify(envelope, undefined, 2)}\n`]]
  await writeAll(request.release, outputs)
  return { manifest, manifestName, comparison }
}
