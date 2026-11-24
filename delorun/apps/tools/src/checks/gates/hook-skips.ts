/**
 * Hook-skip gate: no script, hook or workflow in the repository passes `--no-verify` to git, and none disables
 * Lefthook with `LEFTHOOK=0`. A commit or a push that skips its hooks reaches the trunk without the checks that are the
 * only gate this repository has, because GitHub Actions does not run on it.
 *
 * The gate reads the files that run a command: every file under a `scripts/` directory, every shell script, every
 * `package.json` script, the hook configuration (`lefthook.yml`, `delorun/lefthook.yml` and a `lefthook-local.yml`),
 * and the workflow files under `.github/`. It refuses the flag and the disabling variable outside the files
 * {@link ALLOWED} names.
 *
 * Documentation is not read: a page that names the flag to forbid it states the rule, not a use of it. The gate's own
 * source and spec are not read either, because the spec's fixtures are the refusal matrix itself. A source file that
 * starts git is not read: `packages/boot/plugin-manager/src/history.ts` commits to the profile history in a person's
 * home, whose hooks are the person's own and are not this repository's checks.
 *
 * Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/hook-skips.ts`. It prints one line per refusal and exits 1.
 *
 * @module @delorun/tools/checks/gates/hook-skips
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from '../../git.ts'

/** The flag that skips a commit's or a push's hooks. */
export const SKIP_FLAG = '--no-verify'

/** The variable that disables Lefthook, and the values that do it. */
const LEFTHOOK_OFF = /\bLEFTHOOK\s*=\s*['"]?(?:0|false)\b/u

/** The files the gate does not read: its own source and spec, whose fixtures are the refusal matrix. */
export const ALLOWED: readonly string[] = [
  'delorun/apps/tools/src/checks/gates/hook-skips.ts',
  'delorun/apps/tools/tests/gates/hook-skips.spec.ts',
]

/** The hook configuration files, at the repository root or under `delorun/`. */
const HOOK_CONFIG = /^(?:delorun\/)?lefthook(?:-local)?\.ya?ml$/u

/** A shell script, wherever it sits. */
const SHELL_SCRIPT = /\.(?:sh|bash|zsh)$/u

/** A manifest whose `scripts` run commands. */
const MANIFEST = /(?:^|\/)package\.json$/u

/** The directories whose every file the gate reads, as repository-relative prefixes. */
const READ_DIRS = ['scripts/', '.github/', 'delorun/apps/tools/scripts/', 'delorun/apps/release/scripts/'] as const

/** The directories the gate never descends into. */
const SKIPPED = new Set(['node_modules', 'lib', 'dist', '.git', 'coverage', '.cache'])

/** One refusal. */
export interface Refusal {
  /** The repository-relative path. */
  readonly path: string
  /** The 1-based line. */
  readonly line: number
  /** What the line does. */
  readonly found: string
}

/**
 * Whether the gate reads a path.
 * @param path - the repository-relative path, with `/` separators.
 * @returns true for a hook configuration, a script, a manifest or a workflow the gate reads.
 */
export function isRead(path: string): boolean {
  if (ALLOWED.includes(path)) return false
  if (HOOK_CONFIG.test(path) || SHELL_SCRIPT.test(path) || MANIFEST.test(path)) return true
  return READ_DIRS.some(prefix => path.startsWith(prefix))
}

/**
 * The refusals in one file's text.
 * @param path - the repository-relative path.
 * @param text - the file's text.
 * @returns one refusal per line that skips a hook.
 */
export function textRefusals(path: string, text: string): Refusal[] {
  return text.split('\n').flatMap((line, index) => {
    const found: string[] = []
    if (line.includes(SKIP_FLAG)) found.push(`passes ${SKIP_FLAG} to git`)
    if (LEFTHOOK_OFF.test(line)) found.push('disables Lefthook with LEFTHOOK=0')
    return found.map(each => ({ path, line: index + 1, found: each }))
  })
}

/**
 * Every file the gate reads, under the given directories.
 * @param root - the repository root.
 * @returns the absolute paths, sorted.
 */
function readFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  for (const prefix of READ_DIRS) {
    const dir = join(root, prefix)
    if (existsSync(dir)) walk(dir)
  }
  for (const name of ['lefthook.yml', 'lefthook.yaml', 'lefthook-local.yml', 'lefthook-local.yaml', 'delorun/lefthook.yml', 'delorun/lefthook.yaml']) {
    const path = join(root, name)
    if (existsSync(path)) files.push(path)
  }
  // A shell script or a manifest anywhere else in the tree, outside the dependency trees and the build output.
  const walkAll = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walkAll(path)
      else if (entry.isFile() && (SHELL_SCRIPT.test(entry.name) || MANIFEST.test(entry.name))) files.push(path)
    }
  }
  walkAll(root)
  return [...new Set(files)].sort()
}

/**
 * The refusals of a repository.
 * @param root - the repository root.
 * @returns one refusal per line that skips a hook, in path order.
 */
export function hookSkipRefusals(root: string): Refusal[] {
  return readFiles(root).flatMap((absolute) => {
    const path = relative(root, absolute).split(sep).join('/')
    if (!isRead(path)) return []
    return textRefusals(path, readFileSync(absolute, 'utf8'))
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refusals = hookSkipRefusals(repositoryRoot(process.cwd()))
  for (const { path, line, found } of refusals) console.error(`gates:hook-skips: ${path}:${String(line)}: ${found}; a commit or a push reaches the trunk only through its hooks`)
  if (refusals.length === 0) console.log('gates:hook-skips: no script, hook or workflow skips a git hook')
  process.exitCode = refusals.length === 0 ? 0 : 1
}
