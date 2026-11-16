/**
 * Assembles a version's changelog fragments into the changelog data file, `CHANGELOG.md` and the release notes, then
 * moves the consumed fragments into `delorun/changelog/releases/<version>/`. Run from the repository root:
 * `node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --version <version> [--date <YYYY-MM-DD>] [--dry-run]
 * [--headline <sentence>]... [--first-public-release] [--advisories <delorun-<version>.advisories.json> --manifest <delorun-<version>.manifest.json>]`,
 * or `... --list-unreleased` to print the unreleased fragments by area and the pending ones with what they wait for.
 * Each `--headline` is one plain sentence saying what a person can now do; up to three open the version's notes, are
 * recorded as the entry's `headlines`, and feed the sites' "What's new" strip. A version with none has no strip.
 * The version is a release (`0.1.0`) or a preview sub-version (`0.1.0-preview.2`); assembling `0.1.0` folds the entries
 * of its previews into it.
 *
 * `delorun/changelog/changelog.json` is the record: the standing comparison with the upstream release and every assembled
 * version. `CHANGELOG.md` is rendered from it, so the two cannot disagree, and the release notes from the new entry.
 * With `--advisories`, the notes end with every advisory the release ships with under an acceptance: its id, package,
 * range, reason, approver, the date its entry records and its lapse release. The report must be the one the signed
 * manifest names by length and SHA-256, with the accepted ids the manifest lists, so the notes come from the report
 * signing checked. `--dry-run` prints the entry and the notes and writes nothing. The command exits 1 with one line
 * per refusal.
 *
 * `--version <version> --highlights <file>` writes the release notes the studio's "What's new" dialog shows, from the
 * version's entry in the data file: its bullets as plain text, within the 64 KiB limit of the manifest's `notes`.
 * Pass the file to `local-release.ts --notes` (or draft its reference into a production manifest).
 *
 * The "From upstream" section names the upstream release in `delorun/upstream-patches.json`, `upstream.ref`.
 * `CHANGELOG.md` is Delorun's own file at the repository root: upstream's tag has none, so the assembly creates it, and
 * the first release that commits it adds its ledger entry. Pending fragments are validated and never assembled.
 *
 * @module @delorun/release/changelog/assemble
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readManifest } from '@delorun/tools/src/check-fork-boundary.ts'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { RELEASE_FILE_SIZE_LIMITS, type AdvisoryAcceptance, type FileRef } from '@delorun/contract-release-manifest'
import type { AdvisoryReport } from '../advisory/check.ts'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { addVersion, buildCompared, buildEntry, foldedPreviews, headlineErrors, parseData, renderChangelog, renderEntry, renderHighlights, renderNotes, replacesErrors, type ChangelogData, type VersionEntry } from './data.ts'
import { fragmentPaths, readFragments, releasedPaths, type Fragment } from './fragment.ts'
import { listUnreleased } from './list.ts'
import { messageOf, type Output } from './output.ts'
import { CHANGELOG_PATH, DATA_PATH, RELEASES_DIR } from './paths.ts'
import { isPreview, releaseOf, versionErrors } from './version.ts'

/** One advisory the release ships with under an acceptance, as the advisory report records it. */
export type AcceptedAdvisory = AdvisoryAcceptance & { readonly added: string }

/**
 * The release notes' section of accepted advisories.
 * @param accepted - the accepted advisories.
 * @returns the section's lines, each block followed by one blank line; empty when none is accepted.
 */
function advisoryLines(accepted: readonly AcceptedAdvisory[]): string[] {
  if (accepted.length === 0) return []
  const lines = ['## Accepted advisories', '', 'This release ships with these dependency advisories under a reviewed acceptance:', '']
  for (const item of accepted) {
    lines.push(`- ${item.advisory} in \`${item.package}\` \`${item.range}\`: ${item.reason} Approved by ${item.approver} on ${item.added}; the acceptance lapses after ${item.lapsesAfter}.`)
  }
  return [...lines, '']
}

/** What the signed manifest records of the advisory report. */
export interface SignedAdvisories {
  /** The report file's reference. */
  readonly report: FileRef
  /** The accepted advisory ids. */
  readonly accepted: readonly string[]
}

/**
 * The accepted advisories of an advisory report, for the notes of the release it checked.
 * @param bytes - the report file.
 * @param version - the release being assembled.
 * @param signed - the signed manifest's `advisories`.
 * @returns each accepted advisory once, by id and package.
 * @throws Error when the report is not the file the manifest names, is for another release, did not pass, or accepts
 * other advisories than the manifest lists.
 */
export function acceptedAdvisories(bytes: Uint8Array, version: string, signed: SignedAdvisories): AcceptedAdvisory[] {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== signed.report.length || sha256 !== signed.report.sha256) throw new Error(`the advisory report is not ${signed.report.name}, the report the signed manifest names`)
  const report = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<AdvisoryReport>
  if (report.schema !== 'delorun.release-advisories/1' || report.version !== version) throw new Error(`the advisory report is not the report of release ${version}`)
  if (report.result !== 'pass') throw new Error('the advisory report did not pass')
  const accepted = new Map<string, AcceptedAdvisory>()
  for (const finding of report.findings ?? []) {
    if (finding.accepted !== undefined) accepted.set(`${finding.accepted.advisory} ${finding.accepted.package}`, finding.accepted)
  }
  const ids = [...new Set([...accepted.values()].map(item => item.advisory))].sort()
  if (JSON.stringify(ids) !== JSON.stringify([...signed.accepted].sort())) throw new Error('the advisory report accepts other advisories than the signed manifest lists')
  return [...accepted.values()]
}

/** One assembled version, ready to write or to print. */
export interface Assembly {
  /** The version. */
  readonly version: string
  /** The upstream release the version is based on. */
  readonly upstreamRef: string
  /** The version's entry, as the data file records it. */
  readonly entry: VersionEntry
  /** The data file after this version. */
  readonly data: ChangelogData
  /** The `CHANGELOG.md` text after this version. */
  readonly changelog: string
  /** The release notes file text. */
  readonly notes: string
  /** The fragments the version consumes, in the order they print. */
  readonly fragments: readonly Fragment[]
}

/** The date to record for a version assembled now: today in UTC, `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Build a version's assembly from its fragments and the data file before it.
 * @param version - the version, already validated.
 * @param upstream - the upstream release and commit from the divergence ledger.
 * @param fragments - the parsed fragments the version consumes.
 * @param options - `accepted` lists the advisories the version ships with under an acceptance, which the notes list;
 * `date` is the date to record, today in UTC by default; `headlines` are the version's headline sentences; `existing` is the data file before this version; `released`
 * are the fragments earlier versions consumed, oldest first, which the standing comparison keeps.
 * @returns the entry, the data after it, the `CHANGELOG.md` and notes texts, and the fragments.
 */
export function renderAssembly(
  version: string,
  upstream: string | ChangelogData['upstream'],
  fragments: readonly Fragment[],
  accepted: readonly AcceptedAdvisory[] = [],
  options: { readonly date?: string | undefined, readonly headlines?: readonly string[] | undefined, readonly existing?: ChangelogData | undefined, readonly released?: readonly Fragment[] | undefined } = {},
): Assembly {
  const ledger = typeof upstream === 'string' ? { ref: upstream, commit: '' } : upstream
  const entry = buildEntry(version, options.date ?? today(), ledger.ref, fragments, foldedPreviews(options.existing, version), options.headlines)
  const data = addVersion(options.existing, ledger, entry, buildCompared([...options.released ?? [], ...fragments]))
  const advisories = advisoryLines(accepted)
  const notes = advisories.length === 0 ? renderNotes(entry) : `${renderNotes(entry)}\n${advisories.join('\n').trimEnd()}\n`
  return { version, upstreamRef: ledger.ref, entry, data, changelog: renderChangelog(data), notes, fragments }
}

/**
 * The data file of a repository.
 * @param root - the repository root.
 * @returns the parsed data; undefined when no version was assembled yet.
 * @throws Error when the file exists and is not a data file.
 */
export function readData(root: string): ChangelogData | undefined {
  const path = join(root, DATA_PATH)
  return existsSync(path) ? parseData(readFileSync(path, 'utf8')) : undefined
}

/**
 * Assemble a version from a repository's unreleased fragments.
 * @param root - the repository root.
 * @param version - the version.
 * @param options - `firstPublicRelease` admits `1.0.0`; `accepted` lists the version's accepted advisories; `date` is
 * the date to record, today in UTC by default; `headlines` are the version's headline sentences, at most three.
 * @returns the assembly; nothing is written.
 * @throws Error listing every refusal, when the version is not accepted, is already assembled or follows its final
 * release, a fragment does not parse or replaces nothing, a fragment name repeats, there is nothing to assemble, or
 * the upstream ledger or the data file does not read.
 */
export function assembleRelease(root: string, version: string, options: { readonly firstPublicRelease: boolean, readonly accepted?: readonly AcceptedAdvisory[] | undefined, readonly date?: string | undefined, readonly headlines?: readonly string[] | undefined }): Assembly {
  const errors = [...versionErrors(version, options.firstPublicRelease), ...headlineErrors(options.headlines ?? [])]
  const current = readFragments(root, fragmentPaths(root), 'unreleased')
  const released = readFragments(root, releasedPaths(root), 'unreleased')
  errors.push(...current.errors, ...released.errors, ...replacesErrors([...released.fragments, ...current.fragments]))
  const notesPath = join(root, RELEASES_DIR, `${version}.md`)
  if (existsSync(notesPath) || existsSync(join(root, RELEASES_DIR, version))) errors.push(`release ${version} already has notes under ${RELEASES_DIR}`)
  const existing = readData(root)
  const assembled = existing?.versions.map(entry => entry.version) ?? []
  if (errors.length === 0 && assembled.includes(version)) errors.push(`${DATA_PATH} already has version ${version}`)
  if (errors.length === 0 && isPreview(version) && assembled.includes(releaseOf(version))) errors.push(`${releaseOf(version)} is already assembled; a preview of it would follow its release`)
  if (errors.length === 0 && current.fragments.length === 0 && foldedPreviews(existing, version).length === 0) errors.push('there is nothing to assemble: no unreleased fragment and no preview to fold')
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const { ref, commit } = readManifest(root).upstream
  return renderAssembly(version, { ref, commit }, current.fragments, options.accepted, { date: options.date, headlines: options.headlines, existing, released: released.fragments })
}

/**
 * Write an assembly: the notes, the data file, `CHANGELOG.md`, and the moved fragments.
 * @param root - the repository root.
 * @param assembly - the assembly to write.
 * @returns the repository-relative paths written, in order.
 */
export function writeAssembly(root: string, assembly: Assembly): string[] {
  const releaseDir = join(root, RELEASES_DIR, assembly.version)
  mkdirSync(releaseDir, { recursive: true })
  const notesRel = `${RELEASES_DIR}/${assembly.version}.md`
  writeFileSync(join(root, notesRel), assembly.notes)
  writeFileSync(join(root, DATA_PATH), `${JSON.stringify(assembly.data, undefined, 2)}\n`)
  writeFileSync(join(root, CHANGELOG_PATH), assembly.changelog)
  for (const fragment of assembly.fragments) {
    renameSync(join(root, fragment.path), join(releaseDir, basename(fragment.path)))
  }
  return [notesRel, DATA_PATH, CHANGELOG_PATH, ...assembly.fragments.map(fragment => `${RELEASES_DIR}/${assembly.version}/${basename(fragment.path)}`)]
}

/**
 * The command, with its repository and output given.
 * @param argv - the arguments after the script.
 * @param root - the repository root.
 * @param output - where the command prints.
 * @returns the exit code: 0 done, 1 a refusal, 2 a wrong command line.
 */
export function run(argv: readonly string[], root: string, output: Output): number {
  let values
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        version: { type: 'string' },
        date: { type: 'string' },
        headline: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean', default: false },
        'list-unreleased': { type: 'boolean', default: false },
        'first-public-release': { type: 'boolean', default: false },
        advisories: { type: 'string' },
        highlights: { type: 'string' },
        manifest: { type: 'string' },
      },
      strict: true,
    }).values
  } catch (error) {
    output.error(`assemble: ${messageOf(error)}`)
    return 2
  }
  if (values['list-unreleased']) {
    const overview = listUnreleased(root)
    output.log(overview.text.trimEnd())
    for (const error of overview.errors) output.error(`assemble: ${error}`)
    return overview.errors.length === 0 ? 0 : 1
  }
  if (values.version === undefined) {
    output.error('assemble: pass --version <version>, or --list-unreleased')
    return 2
  }
  if (values.highlights !== undefined) {
    try {
      const entry = parseData(readFileSync(join(root, DATA_PATH), 'utf8')).versions.find(candidate => candidate.version === values.version)
      if (entry === undefined) throw new Error(`${DATA_PATH} has no entry for ${values.version}; assemble it first`)
      writeFileSync(values.highlights, renderHighlights(entry, RELEASE_FILE_SIZE_LIMITS.notes))
      output.log(`assemble: wrote ${values.highlights}`)
      return 0
    } catch (error) {
      output.error(`assemble: ${messageOf(error)}`)
      return 1
    }
  }
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    output.error('assemble: --date must be YYYY-MM-DD')
    return 2
  }
  let assembly: Assembly
  try {
    if ((values.advisories === undefined) !== (values.manifest === undefined)) throw new Error('pass --advisories and --manifest together')
    const accepted = values.advisories === undefined || values.manifest === undefined
      ? []
      : acceptedAdvisories(readFileSync(values.advisories), values.version, readEnvelope('manifest', readFileSync(values.manifest)).signed.advisories)
    assembly = assembleRelease(root, values.version, { firstPublicRelease: values['first-public-release'], accepted, date: values.date, headlines: values.headline })
  } catch (error) {
    output.error(`assemble: ${messageOf(error)}`)
    return 1
  }
  if (values['dry-run']) {
    output.log(`--- ${CHANGELOG_PATH} (the entry for ${assembly.version}; the standing comparison above it is regenerated) ---\n${renderEntry(assembly.entry)}`)
    output.log(`--- ${RELEASES_DIR}/${assembly.version}.md ---\n${assembly.notes}`)
    output.log(`standing comparison: ${String(assembly.data.compared.length)} bullets; fragments to move: ${String(assembly.fragments.length)}`)
    return 0
  }
  for (const path of writeAssembly(root, assembly)) output.log(`assemble: wrote ${path}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), repositoryRoot(process.cwd()), { log: console.log, error: console.error })
}
