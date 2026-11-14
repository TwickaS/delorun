/**
 * No calendar planning in new documentation: a line a range adds to a Markdown file under `delorun/` may not carry a
 * schedule, a deadline, a quarter, a week or month estimate, or a word that promises timing such as "soon" or "next
 * week". Dates are allowed as records of when something happened or was decided, and a duration that defines behaviour,
 * such as a 72-hour wait, is allowed. Lines already in the tree are not read, so a page is held to the rule when it is
 * next edited.
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/doc-times.ts --base <rev>` exits nonzero with one line per
 * violation.
 *
 * @module @delorun/tools/checks/gates/doc-times
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git, repositoryRoot } from '../../git.ts'

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'

/** Each pattern with the name a violation reports. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\b(?:by|before|until|planned for|due|target(?:ing)?|ships? in|lands? in|scheduled for)\\s+(?:early |mid-?|late |the end of )?(?:${MONTHS})\\s+20\\d\\d\\b`, 'i'), 'a deadline'],
  [/\bQ[1-4]\s+20\d\d\b/, 'a quarter'],
  [/\b(?:in|within|about|around|over|after|~)\s*(?:a|one|two|three|four|five|six|eight|\d+)?\s*(?:-\s*)?(?:weeks?|months?|sprints?)\b/i, 'a schedule estimate'],
  [/\b(?:soon|tomorrow|next week|next month|next quarter|this quarter)\b/i, 'a word that promises timing'],
]

/**
 * The calendar planning a line carries.
 * @param line - one line of Markdown.
 * @returns the names of the patterns it matches, empty when it has none.
 */
export function timeReferences(line: string): string[] {
  // Code spans and link targets name files and commands, not time.
  const prose = line.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']')
  return PATTERNS.filter(([pattern]) => pattern.test(prose)).map(([, name]) => name)
}

/**
 * The violations in a unified diff's added lines.
 * @param diff - `git diff -U0` output.
 * @returns `path:line: name` for each violation.
 */
export function diffErrors(diff: string): string[] {
  const errors: string[] = []
  let path = ''
  let line = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) path = text.replace(/^\+\+\+ (?:b\/)?/, '')
    else if (text.startsWith('@@')) line = Number(/\+(\d+)/.exec(text)?.[1] ?? '0')
    else if (text.startsWith('+')) {
      for (const name of timeReferences(text.slice(1))) errors.push(`${path}:${String(line)}: ${name}`)
      line += 1
    }
  }
  return errors
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: 'string' } }, strict: true })
  if (values.base === undefined) {
    console.error('gates:doc-times: pass --base <rev>')
    return 2
  }
  const root = repositoryRoot(process.cwd())
  const errors = diffErrors(git(root, ['diff', '-U0', '--no-color', `${values.base}...HEAD`, '--', 'delorun/**/*.md', 'delorun/*.md']))
  for (const error of errors) console.error(error)
  if (errors.length > 0) console.error(`gates:doc-times: ${String(errors.length)} problem(s); documents carry no schedules, deadlines or time estimates (AGENTS.md, Documentation)`)
  return errors.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
