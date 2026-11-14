/**
 * Compares two build outputs of the same release, such as the release workflow's and the targets-key holder's
 * rebuild (contract C2, rebuild before signing). Two outputs match when they hold the same file names and every file
 * is byte-identical, except where an entry of the committed `rebuild-exceptions.json` accepts a difference. Runtime
 * archives are compared entry by entry, after checking that each is in the deterministic form; a runtime file list
 * and the SBOM must each equal the file derived from the archives beside it, so their differences are exactly the
 * archives'.
 *
 * @module @delorun/release/rebuild/compare
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { compareEntryPaths, type ArchiveFormat } from '@delorun/release-formats/archive/entry'
import { inspectArchive, type ArchiveSummary } from '@delorun/release-formats/archive/inspect'
import { fileDigest } from '@delorun/release-formats/archive/sink'
import type { ClosureRecipe, RebuildExceptions, Toolchain } from '../closure/config.ts'
import type { ImagesRecipe } from '../images/build.ts'
import { deriveSbomText } from '../sbom/release-sbom.ts'
import { closureFileNames, runtimeFileList, unsignedEnvelopeText } from '../closure/tree.ts'

/** One difference that no exception accepts. */
export interface Difference {
  /** The output file. */
  readonly file: string
  /** The archive entry, for a difference inside an archive. */
  readonly entry?: string
  /** What differs. */
  readonly detail: string
}

/** One difference an exception accepts. */
export interface AcceptedDifference {
  /** The archive. */
  readonly file: string
  /** The entry. */
  readonly entry: string
  /** The exception's id. */
  readonly exception: string
}

/** The result of a comparison. */
export interface Comparison {
  /** Differences that fail the comparison; empty when the outputs match. */
  readonly differences: readonly Difference[]
  /** Differences the exceptions accept. */
  readonly accepted: readonly AcceptedDifference[]
  /** The file names compared. */
  readonly files: readonly string[]
}

/** A runtime closure file name, split into its release and platform. */
interface ClosureName {
  readonly version: string
  readonly platform: RuntimePlatform
  readonly kind: 'archive' | 'files'
}

/**
 * Recognise a runtime archive or file-list name.
 * @param name - a release file name.
 * @returns its version, platform and kind, or `undefined` for any other file.
 */
export function closureName(name: string): ClosureName | undefined {
  for (const platform of RUNTIME_PLATFORMS) {
    for (const kind of ['archive', 'files'] as const) {
      const suffix = kind === 'files' ? `-${platform}.files.json` : `-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`
      if (name.startsWith('delorun-') && name.endsWith(suffix)) {
        const version = name.slice('delorun-'.length, -suffix.length)
        if (version.length > 0) return { version, platform, kind }
      }
    }
  }
  return undefined
}

async function regularFiles(directory: string, label: string, differences: Difference[], only: ReadonlySet<string> | undefined): Promise<Set<string>> {
  const names = new Set<string>()
  for (const name of await readdir(directory)) {
    if (only !== undefined && !only.has(name)) continue
    if ((await lstat(join(directory, name))).isFile()) names.add(name)
    else differences.push({ file: name, detail: `${label} entry is not a regular file` })
  }
  return names
}

function compareArchives(name: string, first: ArchiveSummary, second: ArchiveSummary, exceptions: RebuildExceptions, differences: Difference[], accepted: AcceptedDifference[]): void {
  if (first.problem !== undefined) differences.push({ file: name, detail: `first: ${first.problem}` })
  if (second.problem !== undefined) differences.push({ file: name, detail: `second: ${second.problem}` })
  if (first.problem !== undefined || second.problem !== undefined) return
  if (first.sha256 === second.sha256 && first.length === second.length) return
  if (first.mtime !== second.mtime) differences.push({ file: name, detail: `entry mtime ${String(first.mtime)} differs from ${String(second.mtime)}` })
  // Only the Windows closure's PE files carry the release workflow's Authenticode signatures (contract C2, R11).
  const pe = closureName(name)?.platform === 'win32-x64' ? exceptions.exceptions.find(exception => exception.applies === 'pe') : undefined
  let left = 0
  let right = 0
  while (left < first.entries.length || right < second.entries.length) {
    const a = first.entries[left]
    const b = second.entries[right]
    const order = a === undefined ? 1 : b === undefined ? -1 : compareEntryPaths(a.path, b.path)
    if (order < 0) {
      differences.push({ file: name, entry: a!.path, detail: 'only in the first output' })
      left++
      continue
    }
    if (order > 0) {
      differences.push({ file: name, entry: b!.path, detail: 'only in the second output' })
      right++
      continue
    }
    left++
    right++
    if (a!.mode !== b!.mode) differences.push({ file: name, entry: a!.path, detail: `mode ${a!.mode} differs from ${b!.mode}` })
    if (a!.sha256 === b!.sha256) continue
    if (pe !== undefined && a!.peSha256 !== undefined && a!.peSha256 === b!.peSha256) {
      accepted.push({ file: name, entry: a!.path, exception: pe.id })
      continue
    }
    differences.push({ file: name, entry: a!.path, detail: `content differs (${String(a!.length)} and ${String(b!.length)} bytes)` })
  }
}

async function fileListMatches(directory: string, name: string, parsed: ClosureName, summary: ArchiveSummary | undefined): Promise<string | undefined> {
  if (summary === undefined) return `its archive ${closureFileNames(parsed.version, parsed.platform).archive} is missing`
  if (summary.problem !== undefined) return 'its archive is not in the deterministic form'
  let expected: string
  try {
    expected = unsignedEnvelopeText(runtimeFileList(parsed.version, parsed.platform, summary.entries))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return (await readFile(join(directory, name), 'utf8')) === expected ? undefined : 'it does not equal the file list derived from its archive'
}

/**
 * Compare two output directories.
 * @param first - one output directory.
 * @param second - the other output directory.
 * @param recipe - the committed rebuild exceptions, and the pinned toolchain, release platforms and image recipe, which
 * the SBOM derives from.
 * @param only - when given, the file names to compare; other files in either directory are not compared, and a
 * named file missing from either directory is a difference.
 * @returns every difference and every accepted difference.
 */
export async function compareOutputs(first: string, second: string, recipe: { readonly exceptions: RebuildExceptions, readonly toolchain: Toolchain, readonly closure: Pick<ClosureRecipe, 'platforms'>, readonly images: ImagesRecipe }, only?: ReadonlySet<string>): Promise<Comparison> {
  const { exceptions } = recipe
  const differences: Difference[] = []
  const accepted: AcceptedDifference[] = []
  const firstNames = await regularFiles(first, 'first', differences, only)
  const secondNames = await regularFiles(second, 'second', differences, only)
  const names = [...new Set([...firstNames, ...secondNames, ...(only ?? [])])].sort(compareEntryPaths)
  const summaries = new Map<string, [ArchiveSummary, ArchiveSummary]>()
  for (const name of names) {
    if (!firstNames.has(name) || !secondNames.has(name)) {
      const where = firstNames.has(name) ? 'only in the first output' : secondNames.has(name) ? 'only in the second output' : 'missing from both outputs'
      differences.push({ file: name, detail: where })
      continue
    }
    const parsed = closureName(name)
    if (parsed?.kind === 'archive') {
      const format: ArchiveFormat = parsed.platform === 'win32-x64' ? 'zip' : 'tar.gz'
      const identical = (await fileDigest(join(first, name))).sha256 === (await fileDigest(join(second, name))).sha256
      const one = await inspectArchive(join(first, name), format)
      const pair: [ArchiveSummary, ArchiveSummary] = [one, identical ? one : await inspectArchive(join(second, name), format)]
      summaries.set(name, pair)
      compareArchives(name, pair[0], pair[1], exceptions, differences, accepted)
    }
  }
  for (const name of names) {
    if (!firstNames.has(name) || !secondNames.has(name)) continue
    const parsed = closureName(name)
    if (parsed?.kind === 'archive') continue
    if (parsed?.kind === 'files') {
      const pair = summaries.get(closureFileNames(parsed.version, parsed.platform).archive)
      for (const [index, directory] of [first, second].entries()) {
        const problem = await fileListMatches(directory, name, parsed, pair?.[index])
        if (problem !== undefined) differences.push({ file: name, detail: `${index === 0 ? 'first' : 'second'}: ${problem}` })
      }
      continue
    }
    const sbom = /^delorun-(.+)\.spdx\.json$/u.exec(name)
    if (sbom !== null) {
      for (const [index, directory] of [first, second].entries()) {
        const expected = await deriveSbomText(directory, sbom[1]!, recipe.closure.platforms, recipe.toolchain, recipe.images.base)
        const problem = expected === undefined ? 'its output lacks a release platform archive the SBOM covers' : (await readFile(join(directory, name), 'utf8')) === expected ? undefined : 'it does not equal the SBOM derived from its archives'
        if (problem !== undefined) differences.push({ file: name, detail: `${index === 0 ? 'first' : 'second'}: ${problem}` })
      }
      continue
    }
    const [a, b] = [await fileDigest(join(first, name)), await fileDigest(join(second, name))]
    if (a.sha256 !== b.sha256 || a.length !== b.length) differences.push({ file: name, detail: `content differs (${String(a.length)} and ${String(b.length)} bytes)` })
  }
  return { differences, accepted, files: names }
}
