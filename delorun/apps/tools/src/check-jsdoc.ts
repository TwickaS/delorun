/**
 * Command-line gate that applies upstream's JSDoc rules
 * (`scripts/verify-export-jsdoc.ts`, which `AGENTS.md` describes) to the
 * fork's sources: every export of a `src` tree under `delorun/` has description
 * prose, and every function-like export documents its parameters and
 * non-void return. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/check-jsdoc.ts`.
 * Exits nonzero with one line per violation.
 *
 * @module @delorun/tools/check-jsdoc
 */
import { pathToFileURL } from 'node:url'
import { collectExportJsdocViolations } from '../../../../scripts/verify-export-jsdoc.ts'
import { repositoryRoot } from './git.ts'

/** The fork's sources the rules read. */
export const FORK_SOURCES = ['delorun/**/src/**/*.ts'] as const

/**
 * Whether a source is left out: git-ignored `*.tmp.ts` scratch probes are not part of the fork, and installed packages are not its sources.
 * @param rel - the path relative to the repository.
 * @returns true to skip it.
 */
export function isExcluded(rel: string): boolean {
  return rel.endsWith('.tmp.ts') || rel.split('/').includes('node_modules')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = collectExportJsdocViolations(repositoryRoot(process.cwd()), { patterns: FORK_SOURCES, exclude: isExcluded })
  for (const violation of violations) process.stderr.write(`${violation}\n`)
  if (violations.length > 0) {
    process.stderr.write(`delorun jsdoc: ${String(violations.length)} export(s) without complete JSDoc\n`)
    process.exit(1)
  }
}
