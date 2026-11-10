/**
 * The changelog gate. Each commit of a range that changes product files adds a fragment under
 * `delo/changelog/unreleased/` or carries a `Changelog: none (<reason>)` trailer; every `Changelog: none` trailer
 * names its reason; and every fragment in the working tree's unreleased and pending folders parses, with its area.
 * Run from the repository root: `node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>`. It prints one line per violation
 * and exits 1.
 *
 * @module @delo/release/changelog/check
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CHANGELOG_NONE, FRAGMENTS } from '@delo/tools/src/check-commits.ts'
import { rangeCommits } from '@delo/tools/src/checks/gates/commit-range.ts'
import { git, repositoryRoot } from '@delo/tools/src/git.ts'
import { fragmentPaths, pendingPaths, readFragments } from './fragment.ts'
import { messageOf, type Output } from './output.ts'
import { isFragmentPath, isProductPath } from './paths.ts'

/** One commit of a range as the changelog rule reads it. */
export interface ChangeCommit {
  /** The full commit id. */
  readonly sha: string
  /** The full commit message, including its trailers. */
  readonly message: string
  /** Paths the commit adds. */
  readonly added: readonly string[]
  /** Every path the commit changes: added, modified, deleted or type-changed. */
  readonly changed: readonly string[]
}

/** How many changed product paths a violation message names before it counts the rest. */
const NAMED_PATHS = 3

/**
 * The violations of the per-commit changelog rule.
 * @param commits - the commits of a range, in any order.
 * @returns one message per violation, each naming its short commit id; empty when every commit passes.
 */
export function changelogCommitErrors(commits: readonly ChangeCommit[]): string[] {
  return commits.flatMap((commit) => {
    const short = commit.sha.slice(0, 10)
    const none = CHANGELOG_NONE.exec(commit.message)
    if (none !== null && !/[A-Za-z]/.test(String(none[1]))) {
      return [`${short}: \`Changelog: none\` needs its reason, such as \`Changelog: none (tests only)\``]
    }
    const product = commit.changed.filter(isProductPath)
    if (product.length === 0 || none !== null || commit.added.some(isFragmentPath)) return []
    const named = product.slice(0, NAMED_PATHS).join(', ')
    const more = product.length > NAMED_PATHS ? ` and ${String(product.length - NAMED_PATHS)} more` : ''
    return [`${short}: changes product files (${named}${more}) and neither adds a fragment under ${FRAGMENTS} nor carries \`Changelog: none (<reason>)\``]
  })
}

/**
 * The violations of every fragment in the working tree's unreleased and pending folders.
 * @param root - the repository root.
 * @returns one message per violation, each prefixed by its fragment path; empty when every fragment parses.
 */
export function fragmentFileErrors(root: string): string[] {
  return [...readFragments(root, fragmentPaths(root), 'unreleased').errors, ...readFragments(root, pendingPaths(root), 'pending').errors]
}

/**
 * The changed paths of one commit, from git.
 * @param root - the repository root.
 * @param sha - the commit id.
 * @returns every path the commit changes, without rename pairing.
 */
function changedPaths(root: string, sha: string): string[] {
  return git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', sha])
    .split('\0')
    .filter(path => path.length > 0)
}

/**
 * The gate, with its repository and output given.
 * @param argv - the arguments after the script.
 * @param root - the repository root.
 * @param output - where the gate prints.
 * @returns the exit code: 0 passed, 1 violations, 2 a wrong command line.
 */
export function run(argv: readonly string[], root: string, output: Output): number {
  let base
  try {
    base = parseArgs({ args: [...argv], options: { base: { type: 'string' } }, strict: true }).values.base
  } catch (error) {
    output.error(`gates:changelog: ${messageOf(error)}`)
    return 2
  }
  if (base === undefined) {
    output.error('gates:changelog: pass --base <rev>')
    return 2
  }
  const commits = rangeCommits(root, base).map(({ sha, message, added }) => ({ sha, message, added, changed: changedPaths(root, sha) }))
  const errors = [...changelogCommitErrors(commits), ...fragmentFileErrors(root)]
  for (const error of errors) output.error(`gates:changelog: ${error}`)
  if (errors.length > 0) {
    output.error('gates:changelog: refused; add a fragment under delo/changelog/unreleased/ or a `Changelog: none (<reason>)` trailer to each commit')
    return 1
  }
  output.log(`gates:changelog: every product change in ${base}..HEAD has a fragment or a reasoned trailer`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), repositoryRoot(process.cwd()), { log: console.log, error: console.error })
}
