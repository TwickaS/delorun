/**
 * Command-line gate for the divergence ledger. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts [--count]`. It prints how many differing paths each
 * path rule covers, with a warning line for a rule that covers none, then one line per violation, and exits 1 on any
 * violation; `--count` also prints the divergence from the pinned upstream commit.
 *
 * @module @delo/tools/check-fork-boundary
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  divergence,
  forkBoundaryErrors,
  GENERATED_HEAD_LINES,
  GENERATED_MARKER,
  generatedSources,
  isGeneratedText,
  MANIFEST_PATH,
  parseManifest,
  ruleCoverage,
  ruledPaths,
  type ChangedPath,
  type Divergence,
  type PatchManifest,
} from './fork-boundary.ts'
import { git, repositoryRoot, runGit } from './git.ts'
import { commitDigests, digestErrors, securityPaths } from './ledger-digests.ts'

/** The outcome of checking one repository against its ledger. */
export interface CheckResult {
  /** The ledger, when it parsed. */
  readonly manifest: PatchManifest | undefined
  /** One message per violation; empty when the ledger holds. */
  readonly errors: string[]
  /** The divergence from the pinned commit, when that commit is in the clone. */
  readonly divergence: Divergence | undefined
  /** The number of differing paths each rule covers, by pattern, when the pinned commit is in the clone. */
  readonly coverage: ReadonlyMap<string, number> | undefined
}

function nulSeparated(output: string): string[] {
  return output.split('\0').filter(entry => entry.length > 0)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the divergence ledger of a repository.
 * @param root - the repository root.
 * @returns the parsed ledger.
 * @throws Error when the ledger is missing, is not JSON, or violates the ledger schema.
 */
export function readManifest(root: string): PatchManifest {
  return parseManifest(readFileSync(join(root, MANIFEST_PATH), 'utf8'))
}

/**
 * Read the pairs a NUL-separated `git diff --name-status` prints: a status code and the path it names.
 * @param tracked - the command's output, split at its NULs.
 * @returns the changed paths with their status.
 */
function nameStatus(tracked: readonly string[]): ChangedPath[] {
  const changed: ChangedPath[] = []
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    const code = tracked[index] ?? ''
    const path = tracked[index + 1] ?? ''
    changed.push({ path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' })
  }
  return changed
}

/**
 * Collect every tracked path that differs from the upstream commit, including uncommitted edits to tracked files.
 * Untracked and ignored files are not considered, so build checks writing scratch output cannot race the ledger.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @returns the changed paths with their status.
 */
export function changedSince(root: string, commit: string): ChangedPath[] {
  const changed = nameStatus(nulSeparated(git(root, ['diff', '--name-status', '--no-renames', '-z', commit])))
  return changed
}

/**
 * Collect every path that differs between two commits. A ledger written for a state a commit holds is measured this
 * way, rather than through the working tree, because the state it describes is a commit and not the checkout.
 * @param root - the repository root.
 * @param from - the older commit, the ledger's pin.
 * @param to - the newer commit, the state the ledger describes.
 * @returns the changed paths with their status.
 */
export function changedBetween(root: string, from: string, to: string): ChangedPath[] {
  return nameStatus(nulSeparated(git(root, ['diff', '--name-status', '--no-renames', '-z', from, to])))
}

/**
 * Every path one commit's tree holds.
 * @param root - the repository root.
 * @param commit - the commit to list.
 * @returns the paths, repository-relative with `/` separators.
 */
export function treeFiles(root: string, commit: string): Set<string> {
  return new Set(nulSeparated(git(root, ['ls-tree', '--name-only', '-r', '-z', commit])))
}

/**
 * Count the hunks of one changed path against the pinned commit, as `git diff --unified=0` splits them.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @param change - one changed path from {@link changedSince}.
 * @returns the number of hunk headers.
 * @throws Error when git fails.
 */
export function hunkCount(root: string, commit: string, change: ChangedPath): number {
  const run = runGit(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', commit, '--', change.path])
  if (run.status !== 0) {
    throw new Error(`git diff for ${change.path} exited ${String(run.status)}: ${run.stderr.trim()}`)
  }
  return run.stdout.split('\n').filter(line => line.startsWith('@@')).length
}

/**
 * Measure the divergence of a ledger: the hunks of each listed patch and of each rule-covered path that differs from
 * the pinned commit.
 * @param root - the repository root.
 * @param manifest - the parsed ledger.
 * @param changed - the changed paths, from {@link changedSince}.
 * @returns the listed and rule-covered totals, with the retired entries credited.
 */
export function measureDivergence(root: string, manifest: PatchManifest, changed: readonly ChangedPath[]): Divergence {
  const ruled = ruledPaths(manifest, changed)
  const measured = new Set([...manifest.patches.map(patch => patch.path), ...ruled])
  const hunks = new Map<string, number>()
  for (const change of changed) {
    if (measured.has(change.path)) hunks.set(change.path, hunkCount(root, manifest.upstream.commit, change))
  }
  return divergence(manifest, hunks, ruled)
}

/**
 * Check each upstream source file that an exact `generated` rule covers: the file in the working tree must name its
 * generator within its first lines, so a `generated` rule cannot stand in for an entry for hand-written source.
 * @param root - the repository root.
 * @param manifest - the parsed ledger.
 * @param changed - the changed paths, from {@link changedSince}.
 * @returns one message per covered file that is absent or does not name its generator.
 */
export function generatedErrors(root: string, manifest: PatchManifest, changed: readonly ChangedPath[]): string[] {
  return generatedSources(manifest, changed).flatMap(path => {
    const file = join(root, path)
    if (existsSync(file) && statSync(file).isFile() && isGeneratedText(readFileSync(file, 'utf8'))) return []
    return [`${path}: a generated rule covers this source file, but its first ${String(GENERATED_HEAD_LINES)} lines do not hold "${GENERATED_MARKER}"; list it as an entry`]
  })
}

function commitExists(root: string, commit: string): boolean {
  return runGit(root, ['cat-file', '-e', `${commit}^{commit}`]).status === 0
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const run = runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant])
  if (run.status === 0 || run.status === 1) return run.status === 0
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} exited ${String(run.status)}: ${run.stderr.trim()}`)
}

/**
 * Check the ledger's commit references against the clone's history: the pinned commit must be an ancestor of
 * HEAD, and each absorbing commit must exist and be an ancestor of the pinned commit.
 * @param root - the repository root.
 * @param manifest - the parsed ledger; its pinned commit must be in the clone.
 * @returns one message per violation; empty when the references hold.
 */
export function historyErrors(root: string, manifest: PatchManifest): string[] {
  const errors: string[] = []
  const pinned = manifest.upstream.commit
  if (!isAncestor(root, pinned, 'HEAD')) {
    errors.push(`HEAD does not contain upstream ${manifest.upstream.ref}; record the merged upstream commit in ${MANIFEST_PATH}`)
  }
  for (const entry of manifest.retired) {
    if (!commitExists(root, entry.upstreamCommit)) {
      errors.push(`${entry.path}: absorbing commit ${entry.upstreamCommit} is not in this clone`)
    } else if (!isAncestor(root, entry.upstreamCommit, pinned)) {
      errors.push(`${entry.path}: absorbing commit ${entry.upstreamCommit} is not in the history of upstream ${manifest.upstream.ref}`)
    }
  }
  return errors
}

/**
 * Run every ledger rule against a repository: the ledger parses, its pinned commit is in the clone and in HEAD's
 * history, every changed upstream path is fork-owned, listed or covered by a path rule, every listed patch still
 * differs from upstream, every source file a `generated` rule covers names its generator, every security entry records
 * a digest, and every recorded digest matches the file at HEAD.
 * @param root - the repository root.
 * @returns the ledger, the violations, and the divergence and rule coverage when the pinned commit is in the clone.
 */
export function checkRepository(root: string): CheckResult {
  let manifest: PatchManifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    return { manifest: undefined, errors: [errorText(error)], divergence: undefined, coverage: undefined }
  }
  const pinned = manifest.upstream.commit
  if (!commitExists(root, pinned)) {
    return {
      manifest,
      errors: [`upstream commit ${pinned} (${manifest.upstream.ref}) is not in this clone; fetch ${manifest.upstream.repository}`],
      divergence: undefined,
      coverage: undefined,
    }
  }
  const changed = changedSince(root, pinned)
  const files = new Set(nulSeparated(git(root, ['ls-files', '--cached', '-z'])))
  return {
    manifest,
    errors: [
      ...historyErrors(root, manifest),
      ...forkBoundaryErrors(manifest, changed, files),
      ...generatedErrors(root, manifest, changed),
      ...digestErrors(manifest, commitDigests(root, 'HEAD', securityPaths(manifest))),
    ],
    divergence: measureDivergence(root, manifest, changed),
    coverage: ruleCoverage(manifest, changed),
  }
}

/**
 * Format a divergence as the lines `--count` prints.
 * @param ref - the pinned upstream ref, named on the first line.
 * @param count - the divergence to format.
 * @returns the listed totals, the rule-covered totals, then one line for the credited retired entries and one per entry.
 */
export function formatDivergence(ref: string, count: Divergence): string[] {
  const lines = [
    `fork divergence against ${ref}: ${counted(count.entries, 'entry', 'entries')}, ${counted(count.hunks, 'hunk')}`,
    `covered by path rules: ${counted(count.ruled.paths, 'path')}, ${counted(count.ruled.hunks, 'hunk')}`,
  ]
  if (count.retired.length === 0) return lines
  const credited = count.retired.reduce((total, entry) => total + entry.hunks, 0)
  lines.push(`retired as absorbed upstream (credited): ${counted(count.retired.length, 'entry', 'entries')}, ${counted(credited, 'hunk')}`)
  for (const entry of count.retired) lines.push(`  ${entry.path}: absorbed at ${entry.upstreamCommit}, ${counted(entry.hunks, 'hunk')}`)
  return lines
}

/**
 * Format the rule coverage as the lines the gate prints.
 * @param manifest - the parsed ledger, whose rules name the kinds.
 * @param coverage - the number of differing paths each rule covers, by pattern.
 * @returns one line per rule, and one warning line per rule that covers no differing path.
 */
export function formatCoverage(manifest: PatchManifest, coverage: ReadonlyMap<string, number>): string[] {
  return manifest.rules.flatMap(rule => {
    const covered = coverage.get(rule.pattern) ?? 0
    const line = `rule ${rule.pattern} (${rule.kind}): covers ${counted(covered, 'differing path')}`
    return covered > 0 ? [line] : [line, `warning: rule ${rule.pattern} covers no differing path; remove it`]
  })
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { count: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  })
  const root = repositoryRoot(process.cwd())
  const result = checkRepository(root)
  if (result.manifest !== undefined && result.coverage !== undefined) {
    for (const line of formatCoverage(result.manifest, result.coverage)) console.log(`fork boundary: ${line}`)
  }
  if (values.count && result.manifest !== undefined && result.divergence !== undefined) {
    for (const line of formatDivergence(result.manifest.upstream.ref, result.divergence)) console.log(line)
  }
  for (const error of result.errors) console.error(`fork boundary: ${error}`)
  if (result.errors.length === 0 && result.manifest !== undefined) {
    const { patches, rules, upstream } = result.manifest
    console.log(`fork boundary: holds against ${upstream.ref} with ${String(patches.length)} listed patch(es) and ${String(rules.length)} path rule(s)`)
  }
  return result.errors.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
