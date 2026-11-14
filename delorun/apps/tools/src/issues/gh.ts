/**
 * The GitHub CLI calls that the issue generator makes: the maintainer check, the listing of issues, issue creation,
 * locking, the lock state of one issue, and label creation. Each call runs `gh` with explicit arguments and throws with
 * the command and its error text when `gh` cannot run or exits nonzero, so a failed write stops the run.
 *
 * @module @delorun/tools/issues/gh
 */
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import type { LabelDefinition } from './labels.ts'

/** The output buffer for one `gh` call. */
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * How many issues the listing reads. A listing that reaches this count could hide an issue that carries a brief's
 * title, so the run refuses it.
 */
export const LISTING_LIMIT = 1000

/** One issue as the listing reports it. */
export interface IssueSummary {
  /** The issue number. */
  readonly number: number
  /** The issue title. */
  readonly title: string
}

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
 * The repository's issues in every state, with their numbers and titles.
 * @param repository - the repository as `owner/name`.
 * @returns the issues that the listing reports.
 * @throws Error when the listing reaches LISTING_LIMIT issues, because it could then hide an issue with a brief's title.
 */
export function issueListing(repository: string): IssueSummary[] {
  const issues = z.array(z.object({ number: z.number().int(), title: z.string() })).parse(JSON.parse(gh([
    'issue', 'list', '--repo', repository, '--state', 'all', '--limit', String(LISTING_LIMIT), '--json', 'number,title',
  ])))
  if (issues.length >= LISTING_LIMIT) {
    throw new Error(`${repository} has at least ${String(LISTING_LIMIT)} issues; the title check reads only that many`)
  }
  return issues
}

/**
 * Whether an issue's conversation is locked.
 * @param repository - the repository as `owner/name`.
 * @param number - the issue number.
 * @returns true when the issue is locked.
 * @throws Error when `gh` fails, or the reply has no `locked` flag.
 */
export function issueLocked(repository: string, number: number): boolean {
  return z.object({ locked: z.boolean() }).parse(JSON.parse(gh(['api', `repos/${repository}/issues/${String(number)}`]))).locked
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
