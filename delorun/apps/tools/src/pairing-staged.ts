/**
 * The pre-commit and pre-merge-commit bilingual-pairing check: strict for new drift, tolerant of drift that
 * `HEAD` already carries.
 *
 * Upstream's `scripts/verify-translation-pairing.ts --cached` refuses any staged record whose pair has a violation.
 * About 43 pairs already drift on the train (left for the translation pass), so a commit that re-records
 * them, such as a directory move, would be refused for drift it did not cause. This wrapper runs
 * the upstream checker twice, as a child process, because the checker exports nothing: once on the staged records
 * (`--cached`), and once on the same pairs as `HEAD` holds them, read through a temporary index file selected with
 * `GIT_INDEX_FILE`. A pair that a staged rename moved is looked up under its old path.
 *
 * A stale record at `HEAD` makes the checker stop at "out of sync" before it compares structure, so `HEAD`'s
 * structural drift (headings, tables, link anchors) would be missing from the baseline and a commit that re-records
 * the pair, such as a move, would be refused for drift it did not cause. The baseline therefore re-records every
 * `HEAD` pair in the temporary index first. A pair nothing in the commit touches stays reported as it is today.
 *
 * It parses the checker's output by two stable keys: exit status 0 means no violation, 1 means violations listed on
 * standard error, one per line indented by two spaces, 2 means a usage error. Violation lines are compared after
 * the old path of a renamed pair becomes its new path and `:<line>:` numbers are removed. A violation fails the
 * commit when the staged side has more of that line than `HEAD` had. A pair with no `HEAD` version is checked
 * strictly. A usage error (status 2) always fails the commit.
 *
 * @module @delorun/tools/pairing-staged
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGit } from './git.ts'

/** The upstream checker, relative to the repository root. */
const CHECKER = 'scripts/verify-translation-pairing.ts'

/** How many existing violations the report lists before it summarises the rest. */
const LISTED_EXISTING = 10

/**
 * A quoted value of at least 60 characters. The checker cuts long values at a fixed length and ends them with an
 * ellipsis, and an edit that lengthens a value makes the checker cut it where it was whole before. Only its first
 * 60 characters identify it.
 */
const LONG_QUOTE = /"([^"…]{60})[^"…]*[…"]/g

/** One run of the upstream checker. */
interface CheckerRun {
  /** The exit status; 2 is a usage error. */
  readonly status: number
  /** The violation lines (indented on standard error) when the status is 1. */
  readonly violations: readonly string[]
  /** The checker's whole standard error, for a usage error. */
  readonly stderr: string
}

/**
 * Run the upstream checker in index mode.
 * @param root - the repository root.
 * @param anchors - the record paths to check.
 * @param env - extra environment variables.
 * @param cached - whether to check the index (`--cached`) or the files on disk under `root`.
 * @returns the exit status and the violation lines.
 */
function runChecker(root: string, anchors: readonly string[], env: NodeJS.ProcessEnv, cached = true): CheckerRun {
  const result = spawnSync(join(root, 'node_modules/.bin/tsx'), [CHECKER, ...cached ? ['--cached'] : [], ...anchors], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  const violations = (result.stderr ?? '').split('\n').filter(line => line.startsWith('  ')).map(line => line.slice(2))
  return { status: result.status ?? 2, violations, stderr: result.stderr ?? '' }
}

/**
 * Map each staged path to the path it had in `HEAD`.
 * @param root - the repository root.
 * @returns new path → old path for every staged rename, as git detects it.
 */
export function stagedRenames(root: string): Map<string, string> {
  const renames = new Map<string, string>()
  const fields = runGit(root, ['diff', '--cached', '-M', '-l0', '--name-status', '-z']).stdout.split('\0')
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? ''
    if (status === '') break
    if (status.startsWith('R') || status.startsWith('C')) {
      const old = fields[i + 1] ?? ''
      const next = fields[i + 2] ?? ''
      if (status.startsWith('R')) renames.set(next, old)
      i += 3
    } else {
      i += 2
    }
  }
  return renames
}

/**
 * The extension-less path of a record's pair.
 * @param record - a `.i18n.yaml` path.
 * @returns the path without `.i18n.yaml`.
 */
function baseOf(record: string): string {
  return record.slice(0, -'.i18n.yaml'.length)
}

/**
 * The base a pair had in `HEAD`: its own, or the old base of whichever of its three files a staged rename moved.
 * @param base - the staged base.
 * @param renames - new path → old path for the staged renames.
 * @returns the `HEAD` base.
 */
export function headBase(base: string, renames: ReadonlyMap<string, string>): string {
  for (const suffix of ['.i18n.yaml', '.md', '.zh.md']) {
    const old = renames.get(`${base}${suffix}`)
    if (old?.endsWith(suffix) === true) return old.slice(0, -suffix.length)
  }
  return base
}

/**
 * A violation line reduced to what identifies it across a rename and unrelated edits.
 * @param line - one violation line.
 * @param pathMap - old base → new base for renamed pairs, applied longest first.
 * @returns the comparable key: paths mapped, line numbers removed, and a value the checker truncated reduced to its
 * first 60 characters.
 */
export function violationKey(line: string, pathMap: ReadonlyMap<string, string>): string {
  let key = line
  for (const [oldBase, newBase] of [...pathMap].sort((a, b) => b[0].length - a[0].length)) {
    key = key.split(oldBase).join(newBase)
  }
  return key.replace(/:\d+:/g, ':').replace(LONG_QUOTE, '"$1…')
}

/** The result of comparing the staged violations with `HEAD`'s. */
export interface PairingVerdict {
  /** Violations the staged side has more of than `HEAD` had. */
  readonly added: readonly string[]
  /** Violations `HEAD` already carried and the commit leaves in place. */
  readonly existing: readonly string[]
}

/**
 * Split the staged violations into new and existing ones.
 * @param staged - the staged side's violation lines.
 * @param head - `HEAD`'s violation lines, with paths already mapped to the staged paths.
 * @param pathMap - old base → new base for renamed pairs.
 * @returns the new and the existing violations, in the staged side's order.
 */
export function compareViolations(
  staged: readonly string[],
  head: readonly string[],
  pathMap: ReadonlyMap<string, string>,
): PairingVerdict {
  const budget = new Map<string, number>()
  for (const line of head) {
    const key = violationKey(line, pathMap)
    budget.set(key, (budget.get(key) ?? 0) + 1)
  }
  const added: string[] = []
  const existing: string[] = []
  for (const line of staged) {
    const key = violationKey(line, new Map())
    const left = budget.get(key) ?? 0
    if (left > 0) {
      budget.set(key, left - 1)
      existing.push(line)
    } else {
      added.push(line)
    }
  }
  return { added, existing }
}

/**
 * The upstream checker on `HEAD`'s versions of the pairs, run from a checkout of `HEAD` so that `HEAD`'s own checker
 * and scope rules judge `HEAD`'s files. Each pair is re-recorded there first, so the checker compares its structure
 * instead of stopping at a stale record.
 * @param root - the repository root.
 * @param anchors - the `HEAD` record paths.
 * @returns the violation lines of the freshly recorded pairs, empty when `HEAD` has no such pair, no commit, or the
 * checker rejects the paths.
 */
function headViolations(root: string, anchors: readonly string[]): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), 'delorun-pairing-'))
  try {
    const tree = join(dir, 'tree')
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
    if (spawnSync('git', ['-C', root, 'read-tree', 'HEAD'], { env }).status !== 0) return []
    const checkout = spawnSync('git', ['-C', root, 'checkout-index', '-a', `--prefix=${tree}/`], { env })
    if (checkout.status !== 0) throw new Error(`git checkout-index failed: ${checkout.stderr.toString()}`)
    symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'))
    const tsx = join(root, 'node_modules/.bin/tsx')
    const rerecord = spawnSync(tsx, [join(import.meta.dirname, 'pairing-rerecord.ts'), tree, ...anchors], { encoding: 'utf8' })
    if (rerecord.status !== 0) throw new Error(`pairing-rerecord failed: ${rerecord.stderr}`)
    const present = rerecord.stdout.split('\n').filter(line => line !== '')
    if (present.length === 0) return []
    const run = runChecker(tree, present, {}, false)
    return run.status === 1 ? run.violations : []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Check the staged records: fail on a violation that `HEAD` did not have.
 * @param records - the staged `.i18n.yaml` paths, as Lefthook's `{staged_files}` gives them.
 * @param root - the repository root.
 * @returns the exit status: 0 to proceed, 1 for new violations, 2 for a usage error.
 */
export function main(records: readonly string[], root: string): number {
  if (records.length === 0) return 0
  const staged = runChecker(root, records, {})
  if (staged.status === 0) return 0
  if (staged.status !== 1) {
    process.stderr.write(staged.stderr)
    return 2
  }
  const renames = stagedRenames(root)
  const pathMap = new Map<string, string>()
  const anchors: string[] = []
  for (const record of records) {
    const base = baseOf(record)
    const old = headBase(base, renames)
    if (old !== base) pathMap.set(old, base)
    anchors.push(`${old}.i18n.yaml`)
  }
  const { added, existing } = compareViolations(staged.violations, headViolations(root, anchors), pathMap)
  if (existing.length > 0) {
    console.error(`pairing: existing drift, not blocking: ${existing.length} violation(s)`)
    for (const line of existing.slice(0, LISTED_EXISTING)) console.error(`  ${line}`)
    if (existing.length > LISTED_EXISTING) console.error(`  … and ${existing.length - LISTED_EXISTING} more`)
  }
  if (added.length === 0) return 0
  console.error(`pairing: ${added.length} new bilingual-pairing violation(s) (see docs/i18n/README.md):`)
  for (const line of added) console.error(`  ${line}`)
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), resolve(import.meta.dirname, '../../../..')))
}
