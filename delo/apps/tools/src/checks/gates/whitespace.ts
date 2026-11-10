/**
 * No whitespace error in the files a change touches: no trailing whitespace, space before a tab in the indent or blank
 * line at the end on a line the change adds (`git diff --check`), and every changed text file ends with exactly one
 * newline. The change is everything that differs from the merge base with `--base`, committed or not, and the untracked
 * files git does not ignore.
 *
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/whitespace.ts --base <rev> [--fix]` exits 1 with one line per
 * problem; `--fix` removes the trailing whitespace git reports, ends each changed text file with exactly one newline, and
 * exits 0 when nothing is left to fix by hand.
 *
 * @module @delo/tools/checks/gates/whitespace
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git, repositoryRoot, runGit } from '../../git.ts'

/** One problem in one file. */
export interface WhitespaceProblem {
  readonly path: string
  /** The 1-based line, or undefined for a problem of the file's end. */
  readonly line?: number
  readonly problem: string
}

/**
 * The problems `git diff --check` reports, from its output: `<path>:<line>: <problem>.` followed by the offending line.
 * @param output - the command's standard output.
 * @returns the problems, in order.
 */
export function parseDiffCheck(output: string): WhitespaceProblem[] {
  return output.split('\n').flatMap((text) => {
    const match = /^(.+):(\d+): (.+)\.$/.exec(text)
    return match === null ? [] : [{ path: String(match[1]), line: Number(match[2]), problem: String(match[3]) }]
  })
}

/**
 * The end-of-file problem of a text file's content.
 * @param content - the file's bytes.
 * @returns the problem, or undefined for an empty or binary file and one that ends with exactly one newline.
 */
export function endProblem(content: Buffer): string | undefined {
  if (content.length === 0 || content.subarray(0, 8000).includes(0)) return undefined
  if (content.at(-1) !== 0x0a) return 'no newline at the end of the file'
  return content.length > 1 && content.at(-2) === 0x0a ? 'more than one newline at the end of the file' : undefined
}

/**
 * A text file with the git-reported lines' trailing whitespace removed and exactly one final newline.
 * @param text - the file's text.
 * @param lines - the 1-based lines whose trailing whitespace git reported.
 * @returns the fixed text.
 */
export function fixText(text: string, lines: ReadonlySet<number>): string {
  const fixed = text.split('\n').map((line, index) => lines.has(index + 1) ? line.replace(/[ \t]+$/, '') : line).join('\n')
  return `${fixed.replace(/\n+$/, '')}\n`
}

/**
 * Check, and with `fix` repair, the files that differ from the merge base with `base`.
 * @param root - the repository root.
 * @param base - the revision the change is measured from.
 * @param fix - whether to rewrite the files.
 * @returns the problems left after any fix.
 */
export function checkWhitespace(root: string, base: string, fix: boolean): WhitespaceProblem[] {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim()
  const changed = git(root, ['diff', '--name-only', '--diff-filter=ACMR', '-z', mergeBase]).split('\0')
  const untracked = git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')
  const paths = [...new Set([...changed, ...untracked].filter(path => path.length > 0 && existsSync(join(root, path))))].sort()
  // `git diff --check` exits 2 with findings; its output is the record either way.
  const reported = parseDiffCheck(runGit(root, ['-c', 'core.whitespace=trailing-space,space-before-tab', 'diff', '--check', '--no-color', mergeBase]).stdout)
  const problems: WhitespaceProblem[] = [...reported]
  for (const path of paths) {
    const problem = endProblem(readFileSync(join(root, path)))
    if (problem !== undefined && !reported.some(each => each.path === path && each.problem === 'new blank line at EOF')) problems.push({ path, problem })
  }
  if (!fix) return problems
  const left: WhitespaceProblem[] = []
  for (const path of [...new Set(problems.map(problem => problem.path))]) {
    const lines = new Set(problems.filter(problem => problem.path === path && problem.problem === 'trailing whitespace').map(problem => Number(problem.line)))
    const absolute = join(root, path)
    writeFileSync(absolute, fixText(readFileSync(absolute, 'utf8'), lines))
    left.push(...problems.filter(problem => problem.path === path && problem.problem !== 'trailing whitespace' && problem.problem !== 'new blank line at EOF' && problem.line !== undefined))
  }
  return left
}

/**
 * The gate's command line.
 * @param argv - the arguments.
 * @param cwd - the directory inside the repository.
 * @returns the exit status.
 */
export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: 'string' }, fix: { type: 'boolean', default: false } }, strict: true })
  if (values.base === undefined) {
    console.error('gates:whitespace: pass --base <rev>')
    return 2
  }
  const problems = checkWhitespace(repositoryRoot(cwd), values.base, values.fix)
  for (const each of problems) console.error(`${each.path}${each.line === undefined ? '' : `:${String(each.line)}`}: ${each.problem}`)
  if (problems.length > 0) {
    console.error(`gates:whitespace: ${String(problems.length)} problem(s); \`node_modules/.bin/tsx delo/apps/tools/src/checks/gates/whitespace.ts --base ${values.base} --fix\` repairs trailing whitespace and final newlines`)
    return 1
  }
  console.log(values.fix ? 'gates:whitespace: fixed; review and commit the changes' : 'gates:whitespace: no whitespace error in the changed files')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
