/**
 * The fork's commit standard, run by the `commit-msg` hook on one message and by the gates on every commit a push adds:
 * a Conventional Commits subject, a DCO sign-off, and for each change people can perceive a changelog fragment under
 * `delo/changelog/unreleased/`, otherwise a `Changelog: none` trailer that gives its reason.
 *
 * `node_modules/.bin/tsx delo/apps/tools/src/check-commits.ts --message <file>` checks one message;
 * `--base <rev>` checks each commit from `rev` to `HEAD`. Exits nonzero with one line per violation.
 *
 * @module @delo/tools/check-commits
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { rangeCommits } from './checks/gates/commit-range.ts'
import { repositoryRoot } from './git.ts'

/** The Conventional Commits types the fork uses. */
export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert', 'style'] as const

const SUBJECT = new RegExp(`^(?:${COMMIT_TYPES.join('|')})(?:\\([a-z0-9][a-z0-9.,/ -]*\\))?!?: \\S`)
const SIGN_OFF = /^Signed-off-by: .+ <[^<>@\s]+@[^<>\s]+>$/m
const CHANGELOG_NONE = /^Changelog: none\b(.*)$/m

/** Where changelog fragments live, one Markdown file per perceptible change. */
export const FRAGMENTS = 'delo/changelog/unreleased/'

/** One commit as the range check reads it. */
export interface Commit {
  /** The full commit id. */
  readonly sha: string
  /** The full commit message. */
  readonly message: string
  /** Paths the commit adds. */
  readonly added: readonly string[]
}

/**
 * The violations of one commit message, without the range's changelog rule.
 * Comment lines (`#`), which git strips, are ignored; a merge or a
 * `Revert "…"` subject is exempt from the subject rule.
 * @param message - the full commit message.
 * @returns one line per violation, empty when the message conforms.
 */
export function messageErrors(message: string): string[] {
  const text = message.split('\n').filter(line => !line.startsWith('#')).join('\n').trim()
  const subject = text.split('\n')[0] ?? ''
  const errors: string[] = []
  if (!/^(?:Merge |Revert ")/.test(subject)) {
    if (!SUBJECT.test(subject)) errors.push(`subject "${subject}" is not \`type(scope): summary\` with a type of ${COMMIT_TYPES.join(', ')}`)
    else if (subject.length > 100) errors.push(`subject is ${String(subject.length)} characters; keep it within 100`)
  }
  if (!SIGN_OFF.test(text)) errors.push('no DCO `Signed-off-by: Name <email>` line (commit with -s)')
  const none = CHANGELOG_NONE.exec(text)
  if (none !== null && !/[A-Za-z]/.test(none[1] ?? '')) errors.push('`Changelog: none` needs its reason, such as `Changelog: none (tests only)`')
  return errors
}

/**
 * The violations of a range of commits: each message's, and the changelog
 * rule, which a commit meets with a `Changelog: none` trailer or the range
 * meets by adding a fragment.
 * @param commits - the commits a push adds, oldest first.
 * @returns one line per violation, each naming its commit.
 */
export function rangeErrors(commits: readonly Commit[]): string[] {
  const fragment = commits.some(commit => commit.added.some(path => path.startsWith(FRAGMENTS) && path.endsWith('.md') && !path.endsWith('/README.md')))
  const errors: string[] = []
  for (const commit of commits) {
    const short = commit.sha.slice(0, 10)
    errors.push(...messageErrors(commit.message).map(error => `${short}: ${error}`))
    if (!fragment && !CHANGELOG_NONE.test(commit.message) && !/^Merge /.test(commit.message)) errors.push(`${short}: no changelog fragment under ${FRAGMENTS} in this push and no \`Changelog: none\` trailer`)
  }
  return errors
}

function main(): number {
  const { values } = parseArgs({ options: { message: { type: 'string' }, base: { type: 'string' } } })
  const errors = values.message !== undefined
    ? messageErrors(readFileSync(values.message, 'utf8'))
    : values.base !== undefined
      ? rangeErrors(rangeCommits(repositoryRoot(process.cwd()), values.base).map(({ sha, message, added }) => ({ sha, message, added })))
      : ['gates:commits: pass --message <file> or --base <rev>']
  for (const error of errors) console.error(error)
  if (errors.length > 0) console.error(`gates:commits: ${String(errors.length)} problem(s); see AGENTS.md (Conventions, Commits)`)
  return errors.length === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main()
