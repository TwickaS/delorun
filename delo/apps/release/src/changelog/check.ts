/**
 * The changelog gate. Each commit of a range that changes product files adds a fragment under
 * `delo/changelog/unreleased/` or carries a `Changelog: none (<reason>)` trailer; every `Changelog: none` trailer
 * names its reason; and every fragment in the working tree parses. Run from the repository root:
 * `node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>`. It prints one line per violation
 * and exits 1.
 *
 * @module @delo/release/changelog/check
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CHANGELOG_NONE, FRAGMENTS } from '@delo/tools/src/check-commits.ts'
import { rangeCommits } from '@delo/tools/src/checks/gates/commit-range.ts'
import { git, repositoryRoot } from '@delo/tools/src/git.ts'
import { fragmentPaths, parseFragment } from './fragment.ts'
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
    if (none !== null && !/[A-Za-z]/.test(none[1] ?? '')) {
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
 * The violations of every fragment in the working tree's unreleased folder.
 * @param root - the repository root.
 * @returns one message per violation, each prefixed by its fragment path; empty when every fragment parses.
 */
export function fragmentFileErrors(root: string): string[] {
  return fragmentPaths(root).flatMap((path) => {
    const result = parseFragment(path, readFileSync(join(root, path), 'utf8'))
    return result.ok ? [] : result.errors.map(error => `${path}: ${error}`)
  })
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

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: 'string' } }, strict: true })
  if (values.base === undefined) {
    console.error('gates:changelog: pass --base <rev>')
    return 2
  }
  const root = repositoryRoot(process.cwd())
  const commits = rangeCommits(root, values.base).map(({ sha, message, added }) => ({ sha, message, added, changed: changedPaths(root, sha) }))
  const errors = [...changelogCommitErrors(commits), ...fragmentFileErrors(root)]
  for (const error of errors) console.error(`gates:changelog: ${error}`)
  if (errors.length > 0) {
    console.error('gates:changelog: refused; add a fragment under delo/changelog/unreleased/ or a `Changelog: none (<reason>)` trailer to each commit')
    return 1
  }
  console.log(`gates:changelog: every product change in ${values.base}..HEAD has a fragment or a reasoned trailer`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
