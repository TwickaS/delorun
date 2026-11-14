/**
 * Documentation gate: runs upstream's documentation checks over the repository, which cover Delorun's pages under
 * `delorun/docs/` in the same scopes as doc-sync. Each check's failures print from the script that found them, and the
 * gate exits 1 when any check fails, except a report-only check, whose failure only prints. Run from anywhere
 * inside the repository: `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/docs.ts`.
 *
 * @module @delorun/tools/checks/gates/docs
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from '../../git.ts'

/** One upstream documentation check: the scripts that run in order, each as the arguments of `tsx`. */
export interface DocCheck {
  /** The check's name in the gate's output. */
  readonly title: string
  /** The `tsx` arguments of each script; the check fails at the first script that fails. */
  readonly scripts: readonly (readonly string[])[]
  /**
   * A report-only check runs and prints its findings, and its failure does not fail the gate. The gate prints
   * `reported` for it instead of `failed`.
   */
  readonly reportOnly?: true
}

/** The verdict the gate prints for one check. */
export type Outcome = 'passed' | 'failed' | 'reported'

/**
 * The gate's verdict on one check that has run.
 * @param check - the check that ran.
 * @param status - the exit status of the script that failed first, or 0 when every script passed.
 * @returns `passed` when `status` is 0, `reported` when a report-only check exits non-zero, and `failed` otherwise.
 */
export function outcome(check: DocCheck, status: number): Outcome {
  if (status === 0) return 'passed'
  return check.reportOnly === true ? 'reported' : 'failed'
}

/**
 * The upstream checks, in doc-sync's order. `doc-typecheck` runs after the referenced projects compile, as the
 * package script `doc-typecheck` does. The bilingual-pair check is report-only while authoring is English-only: its
 * counterparts are written in one translation pass.
 */
export const DOC_CHECKS: readonly DocCheck[] = [
  { title: 'bilingual pairs', scripts: [['scripts/verify-translation-pairing.ts']], reportOnly: true },
  { title: 'word budgets', scripts: [['scripts/verify-doc-budgets.ts']] },
  { title: 'hard-wrapped paragraphs', scripts: [['scripts/verify-md-wrap.ts']] },
  { title: 'relative links and anchors', scripts: [['scripts/verify-md-links.ts']] },
  {
    title: 'TypeScript fences',
    scripts: [['scripts/compile-referenced-projects.ts', 'host-contracts'], ['scripts/doc-typecheck.ts']],
  },
]

function main(): number {
  const root = repositoryRoot(process.cwd())
  const tsx = join(root, 'node_modules/.bin/tsx')
  const failed: string[] = []
  for (const check of DOC_CHECKS) {
    let status = 0
    for (const args of check.scripts) {
      status = spawnSync(tsx, args, { cwd: root, stdio: 'inherit' }).status ?? 1
      if (status !== 0) break
    }
    const verdict = outcome(check, status)
    const label =
      verdict === 'reported' ? 'reported (not failing; the translation pass writes the counterparts)' : verdict
    console.log(`gates:docs: ${check.title}: ${label}`)
    if (verdict === 'failed') failed.push(check.title)
  }
  if (failed.length > 0) {
    console.error(`gates:docs: failed: ${failed.join(', ')}`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
