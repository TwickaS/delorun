/**
 * Signing a release with the targets key (contract C2): the checks that refuse to sign without the targets-key
 * holder's rebuild, then the signed runtime file lists and the signed manifest. Signing runs on the holder's machine
 * with the release workflow's files in a local directory; it checks every file the manifest names, compares the
 * workflow's build output with the holder's rebuild again, and writes nothing before every check passes.
 *
 * @module @delo/release/sign/release
 */
import { createHash, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
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
import type { Recipe } from '../closure/config.ts'
import { compareOutputs, type Comparison } from '../rebuild/compare.ts'
import { ciMarkers, commitOf, outputRefs, rebuildRecordName, recipeDigest, REQUIRED_SOURCE } from '../rebuild/record.ts'
import { signEnvelope } from './envelope.ts'
import { parseStrictJson, toJsonValue, type JsonValue } from './json.ts'
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
  /** The release workflow's files, which signing adds its signed files to. */
  readonly release: string
  /** The holder's rebuild output on this machine. */
  readonly rebuild: string
  /** The targets private key. */
  readonly key: KeyObject
  /** The committed recipe. */
  readonly recipe: Recipe
  /** The process environment, checked for CI markers. */
  readonly env: NodeJS.ProcessEnv
  /** The signing time. */
  readonly now: Date
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

async function checkRebuild(request: SigningRequest, draft: ManifestDraft): Promise<{ record: RebuildRecord, recordRef: FileRef, comparison: Comparison }> {
  const markers = ciMarkers(request.env)
  if (markers.length > 0) refuse(`${markers.join(' and ')} is set, so this run is a CI run`)
  const recordName = rebuildRecordName(draft.version)
  if (!existsSync(join(request.release, recordName))) refuse(`no rebuild record ${recordName} exists in ${request.release}`)
  let record: RebuildRecord
  try {
    record = readRebuildRecord(await readFile(join(request.release, recordName)))
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
  if (record.recipe !== recipeDigest(request.repository, record.commit)) refuse(`the rebuild record's recipe digest is not the recipe at ${record.commit}`)
  if (record.toolchain.node !== request.recipe.toolchain.node.version || record.toolchain.pnpm !== request.recipe.toolchain.pnpm.version) {
    refuse(`the rebuild record's toolchain (Node ${record.toolchain.node}, pnpm ${record.toolchain.pnpm}) is not the pinned toolchain`)
  }
  let rebuild: string
  try {
    rebuild = await realpath(request.rebuild)
    if (!(await lstat(rebuild)).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    refuse(`the rebuild output ${request.rebuild} is not a directory on this machine: ${(error as Error).message}`)
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
  const comparison = await compareOutputs(request.release, rebuild, request.recipe.exceptions, new Set(local.map(ref => ref.name)))
  if (comparison.differences.length > 0) {
    const first = comparison.differences[0]!
    refuse(`compare-rebuild finds ${String(comparison.differences.length)} differences between the release workflow's output and the rebuild, first ${first.file}${first.entry === undefined ? '' : `: ${first.entry}`}: ${first.detail}`)
  }
  return { record, recordRef: await refOf(request.release, recordName), comparison }
}

/**
 * Check a release and sign it: the runtime file lists in place, then the manifest.
 * @param request - the directories, key, recipe and environment.
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
  const { record, recordRef, comparison } = await checkRebuild(request, draft)
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
  for (const [name, text] of signedLists) {
    await writeFile(join(request.release, `${name}.signed`), text, { flag: 'w', mode: 0o644 })
    await rename(join(request.release, `${name}.signed`), join(request.release, name))
  }
  await writeFile(manifestPath, `${JSON.stringify(envelope, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
  return { manifest, manifestName, comparison }
}
