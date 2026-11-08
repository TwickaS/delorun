/**
 * Command-line gate for the divergence ledger. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts [--count]`. It prints one line per
 * violation and exits 1; `--count` also prints the divergence from the pinned upstream commit.
 *
 * @module @delo/tools/check-fork-boundary
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  divergence,
  forkBoundaryErrors,
  MANIFEST_PATH,
  parseManifest,
  type ChangedPath,
  type Divergence,
  type PatchManifest,
} from './fork-boundary.ts'
import { git, repositoryRoot, runGit } from './git.ts'
import { digestErrors, headDigests } from './ledger-digests.ts'

/** The outcome of checking one repository against its ledger. */
export interface CheckResult {
  /** The ledger, when it parsed. */
  readonly manifest: PatchManifest | undefined
  /** One message per violation; empty when the ledger holds. */
  readonly errors: string[]
  /** The divergence from the pinned commit, when that commit is in the clone. */
  readonly divergence: Divergence | undefined
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
 * Collect every path that differs from the upstream commit, including uncommitted and untracked files.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @returns the changed paths with their status; untracked paths are marked.
 */
export function changedSince(root: string, commit: string): ChangedPath[] {
  const tracked = nulSeparated(git(root, ['diff', '--name-status', '--no-renames', '-z', commit]))
  const changed: ChangedPath[] = []
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    const code = tracked[index] ?? ''
    const path = tracked[index + 1] ?? ''
    changed.push({ path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' })
  }
  for (const path of nulSeparated(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
    changed.push({ path, status: 'added', untracked: true })
  }
  return changed
}

/**
 * Count the hunks of one changed path against the pinned commit, as `git diff --unified=0` splits them.
 * An untracked path is shown as a new file, so its whole content is one hunk.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @param change - one changed path from {@link changedSince}.
 * @returns the number of hunk headers.
 * @throws Error when git fails; `git diff --no-index` exits 1 when the files differ, which is the expected case.
 */
export function hunkCount(root: string, commit: string, change: ChangedPath): number {
  const run = change.untracked === true
    ? runGit(root, ['diff', '--no-index', '--no-color', '--unified=0', '/dev/null', change.path])
    : runGit(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', commit, '--', change.path])
  const expected = change.untracked === true ? [0, 1] : [0]
  if (run.status === null || !expected.includes(run.status)) {
    throw new Error(`git diff for ${change.path} exited ${String(run.status)}: ${run.stderr.trim()}`)
  }
  return run.stdout.split('\n').filter(line => line.startsWith('@@')).length
}

/**
 * Measure the divergence of a ledger: the hunks of each listed patch that differs from the pinned commit.
 * @param root - the repository root.
 * @param manifest - the parsed ledger.
 * @param changed - the changed paths, from {@link changedSince}.
 * @returns the listed totals, with the retired entries credited.
 */
export function measureDivergence(root: string, manifest: PatchManifest, changed: readonly ChangedPath[]): Divergence {
  const listed = new Set(manifest.patches.map(patch => patch.path))
  const hunks = new Map<string, number>()
  for (const change of changed) {
    if (listed.has(change.path)) hunks.set(change.path, hunkCount(root, manifest.upstream.commit, change))
  }
  return divergence(manifest, hunks)
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
 * history, every changed upstream path is listed or fork-owned, every listed patch still differs from upstream, and
 * every recorded digest matches the file at HEAD.
 * @param root - the repository root.
 * @returns the ledger, the violations, and the divergence when the pinned commit is in the clone.
 */
export function checkRepository(root: string): CheckResult {
  let manifest: PatchManifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    return { manifest: undefined, errors: [errorText(error)], divergence: undefined }
  }
  const pinned = manifest.upstream.commit
  if (!commitExists(root, pinned)) {
    return {
      manifest,
      errors: [`upstream commit ${pinned} (${manifest.upstream.ref}) is not in this clone; fetch ${manifest.upstream.repository}`],
      divergence: undefined,
    }
  }
  const changed = changedSince(root, pinned)
  const files = new Set(nulSeparated(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))
  return {
    manifest,
    errors: [
      ...historyErrors(root, manifest),
      ...forkBoundaryErrors(manifest, changed, files),
      ...digestErrors(manifest, headDigests(root, manifest.patches.map(patch => patch.path))),
    ],
    divergence: measureDivergence(root, manifest, changed),
  }
}

/**
 * Format a divergence as the lines `--count` prints.
 * @param ref - the pinned upstream ref, named on the first line.
 * @param count - the divergence to format.
 * @returns the totals, then one line for the credited retired entries and one per entry.
 */
export function formatDivergence(ref: string, count: Divergence): string[] {
  const lines = [`fork divergence against ${ref}: ${counted(count.entries, 'entry', 'entries')}, ${counted(count.hunks, 'hunk')}`]
  if (count.retired.length === 0) return lines
  const credited = count.retired.reduce((total, entry) => total + entry.hunks, 0)
  lines.push(`retired as absorbed upstream (credited): ${counted(count.retired.length, 'entry', 'entries')}, ${counted(credited, 'hunk')}`)
  for (const entry of count.retired) lines.push(`  ${entry.path}: absorbed at ${entry.upstreamCommit}, ${counted(entry.hunks, 'hunk')}`)
  return lines
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
  if (values.count && result.manifest !== undefined && result.divergence !== undefined) {
    for (const line of formatDivergence(result.manifest.upstream.ref, result.divergence)) console.log(line)
  }
  for (const error of result.errors) console.error(`fork boundary: ${error}`)
  if (result.errors.length === 0 && result.manifest !== undefined) {
    console.log(`fork boundary: holds against ${result.manifest.upstream.ref} with ${String(result.manifest.patches.length)} listed patch(es)`)
  }
  return result.errors.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
