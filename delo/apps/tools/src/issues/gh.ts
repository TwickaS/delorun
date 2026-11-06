/**
 * The GitHub CLI calls that the issue generator makes: the maintainer check, the listing of issue titles, issue creation
 * and locking, and label creation. Each call runs `gh` with explicit arguments and throws with the command and its
 * error text when `gh` cannot run or exits nonzero, so a failed write stops the run.
 *
 * @module @delo/tools/issues/gh
 */
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import type { LabelDefinition } from './labels.ts'

/** The output buffer for one `gh` call. */
const MAX_BUFFER = 64 * 1024 * 1024

/** How many issues the title check reads. A listing that reaches this count could hide a duplicate, so it is refused. */
export const TITLE_LIMIT = 1000

/**
 * Run `gh` and return its standard output.
 * @param args - the arguments after `gh`.
 * @returns the standard output as text.
 * @throws Error when `gh` is not on PATH or exits nonzero, with its error text.
 */
export function gh(args: readonly string[]): string {
  const result = spawnSync('gh', [...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  if (result.error !== undefined) throw new Error(`gh ${args.join(' ')} could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.trim()}`)
  return result.stdout
}

/**
 * Why the signed-in gh user may not file briefs or sync labels in the repository, if they may not.
 * @param repository - the repository as `owner/name`.
 * @returns the refusal, or undefined when the user holds maintain or admin permission.
 * @throws Error when gh cannot read the user or the repository, or the replies do not have the expected fields.
 */
export function maintainerRefusal(repository: string): string | undefined {
  const user = z.object({ login: z.string().min(1) }).parse(JSON.parse(gh(['api', 'user'])))
  const info = z.object({
    permissions: z.object({ admin: z.boolean().optional(), maintain: z.boolean().optional() }).optional(),
  }).parse(JSON.parse(gh(['api', `repos/${repository}`])))
  const permissions = info.permissions ?? {}
  if (permissions.maintain === true || permissions.admin === true) return undefined
  return `gh is signed in as ${user.login}, which holds neither maintain nor admin permission on ${repository}; only a maintainer files briefs and syncs labels`
}

/**
 * The titles of the repository's issues in every state, each with its number.
 * @param repository - the repository as `owner/name`.
 * @returns a map from each issue title to its number.
 * @throws Error when the listing reaches TITLE_LIMIT issues, because the title check could then miss a duplicate.
 */
export function issueTitles(repository: string): Map<string, number> {
  const issues = z.array(z.object({ number: z.number().int(), title: z.string() })).parse(JSON.parse(gh([
    'issue', 'list', '--repo', repository, '--state', 'all', '--limit', String(TITLE_LIMIT), '--json', 'number,title',
  ])))
  if (issues.length >= TITLE_LIMIT) {
    throw new Error(`${repository} has at least ${String(TITLE_LIMIT)} issues; the title check reads only that many`)
  }
  return new Map(issues.map(issue => [issue.title, issue.number]))
}

/** The fields that an issue is created with. */
export interface NewIssue {
  /** The issue title. */
  readonly title: string
  /** The labels to apply, each already defined in the repository. */
  readonly labels: readonly string[]
  /** The milestone's title, which the repository already defines. */
  readonly milestone: string
  /** The file holding the Markdown body. */
  readonly bodyFile: string
}

/**
 * Create an issue and return its number.
 * @param repository - the repository as `owner/name`.
 * @param issue - the title, labels, milestone and body file.
 * @returns the number of the new issue, read from the URL that `gh` prints.
 * @throws Error when `gh` fails, or when its output holds no issue URL.
 */
export function createIssue(repository: string, issue: NewIssue): number {
  const labels = issue.labels.flatMap(label => ['--label', label])
  const output = gh(['issue', 'create', '--repo', repository, '--title', issue.title, '--body-file', issue.bodyFile, ...labels, '--milestone', issue.milestone])
  const match = /\/issues\/(\d+)\s*$/mu.exec(output)
  if (match === null) throw new Error(`gh issue create printed no issue URL: ${output.trim()}`)
  return Number(match[1])
}

/**
 * Lock an issue's conversation, so that only collaborators can comment on it.
 * @param repository - the repository as `owner/name`.
 * @param number - the issue number.
 * @throws Error when `gh` fails.
 */
export function lockIssue(repository: string, number: number): void {
  gh(['issue', 'lock', String(number), '--repo', repository])
}

/**
 * Create a label, or update its colour and description when it exists.
 * @param repository - the repository as `owner/name`.
 * @param label - the label's name, colour and description.
 * @throws Error when `gh` fails.
 */
export function syncLabel(repository: string, label: LabelDefinition): void {
  gh(['label', 'create', label.name, '--repo', repository, '--color', label.color, '--description', label.description, '--force'])
}
