/**
 * Work-brief issues: it validates a briefs file and prints each issue body (`--dry-run`), creates the issues that the
 * briefs describe and locks them (`--create`), or creates and updates the labels of `.github/labels.yml`
 * (`--sync-labels`).
 *
 * Run from the repository root:
 *
 * - `node_modules/.bin/tsx delo/apps/tools/src/issues/issues.ts --input <briefs.json> --dry-run`
 * - `node_modules/.bin/tsx delo/apps/tools/src/issues/issues.ts --input <briefs.json> --create --repo <owner/name>`
 * - `node_modules/.bin/tsx delo/apps/tools/src/issues/issues.ts --sync-labels --repo <owner/name>`
 *
 * A problem prints one line to standard error and exits 1 before any GitHub call. `--create` and `--sync-labels` refuse
 * unless the signed-in gh user holds maintain or admin permission on the repository. For each brief, `--create` creates
 * and locks its issue, or, when an issue already carries the brief's title, locks that issue if it is unlocked and skips
 * it if it is locked. It stops at the first failed call, so a rerun completes an interrupted run.
 *
 * @module @delo/tools/issues/issues
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git, repositoryRoot } from '../git.ts'
import { briefErrors, parseBriefs, renderBody, type Brief, type BriefContext } from './brief.ts'
import { createIssue, issueListing, issueLocked, lockIssue, maintainerRefusal, syncLabel, type IssueSummary } from './gh.ts'
import { LABELS_PATH, parseLabels, type LabelDefinition } from './labels.ts'
import { referenceContext, type ReferenceContext } from './references.ts'

const USAGE = [
  'usage: issues.ts --input <briefs.json> --dry-run',
  '       issues.ts --input <briefs.json> --create --repo <owner/name>',
  '       issues.ts --sync-labels --repo <owner/name>',
].join('\n')

/** A command line that names no valid mode or repeats an option the mode does not take. */
class UsageError extends Error {}

/** The work a run performs, with its arguments checked. */
type Mode =
  | { readonly kind: 'dry-run'; readonly input: string }
  | { readonly kind: 'create'; readonly input: string; readonly repository: string }
  | { readonly kind: 'sync-labels'; readonly repository: string }

/** What `--create` does for one brief, decided before any write. */
type Step =
  | { readonly kind: 'create'; readonly brief: Brief; readonly index: number }
  | { readonly kind: 'existing'; readonly brief: Brief; readonly issue: IssueSummary }

/**
 * The repository argument, which must name `owner/name`.
 * @param repo - the value of `--repo`, if the option was given.
 * @returns the repository.
 * @throws UsageError when the option is missing or malformed.
 */
function repositoryOf(repo: string | undefined): string {
  if (repo === undefined) throw new UsageError('this mode needs --repo <owner/name>')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new UsageError(`--repo expects owner/name, not "${repo}"`)
  return repo
}

/**
 * The mode a command line selects.
 * @param values - the parsed options.
 * @returns the mode, with its input file and repository.
 * @throws UsageError when zero or several modes are selected, or an option the mode does not take is given.
 */
function modeOf(values: { readonly input?: string; readonly repo?: string; readonly 'dry-run'?: boolean; readonly create?: boolean; readonly 'sync-labels'?: boolean }): Mode {
  const selected = [values['dry-run'], values.create, values['sync-labels']].filter(flag => flag === true).length
  if (selected !== 1) throw new UsageError('choose exactly one mode: --dry-run, --create or --sync-labels')
  if (values['sync-labels'] === true) {
    if (values.input !== undefined) throw new UsageError('--sync-labels takes no --input')
    return { kind: 'sync-labels', repository: repositoryOf(values.repo) }
  }
  if (values.input === undefined) throw new UsageError(`${values.create === true ? '--create' : '--dry-run'} needs --input <briefs.json>`)
  if (values.create === true) return { kind: 'create', input: values.input, repository: repositoryOf(values.repo) }
  if (values.repo !== undefined) throw new UsageError('--dry-run takes no --repo')
  return { kind: 'dry-run', input: values.input }
}

/**
 * The paths the repository tracks, which the brief references resolve against.
 * @param root - the repository root.
 * @returns the tracked paths, as `git ls-files` lists them.
 */
function trackedPaths(root: string): string[] {
  return git(root, ['ls-files', '-z']).split('\0').filter(path => path !== '')
}

/**
 * The test for a directory in the working tree, tracked or not, under the repository root.
 * @param root - the repository root.
 * @returns a function that reports whether a repository-relative directory exists as a directory.
 */
function workingTreeDirectories(root: string): (directory: string) => boolean {
  return directory => existsSync(join(root, directory)) && statSync(join(root, directory)).isDirectory()
}

/**
 * Print the problems to standard error, and the outcome that the run did not reach.
 * @param errors - one message per problem.
 * @param outcome - what did not happen, such as "no issue was created".
 * @returns the exit status, 1.
 */
function reportProblems(errors: readonly string[], outcome: string): number {
  for (const error of errors) console.error(`issues: ${error}`)
  console.error(`issues: ${String(errors.length)} problem(s); ${outcome}`)
  return 1
}

/**
 * Print each brief's title, labels, milestone and issue body, separated by a blank line.
 * @param briefs - the validated briefs, in file order.
 * @param context - the tree's files and directories, which link the body's references.
 */
function printBodies(briefs: readonly Brief[], context: ReferenceContext): void {
  for (const brief of briefs) {
    console.log(`== ${brief.title} ==`)
    console.log(`labels: ${brief.labels.join(', ')}`)
    console.log(`milestone: ${brief.milestone}`)
    console.log('')
    console.log(renderBody(brief, context))
  }
}

/**
 * Decide, for each brief, whether `--create` creates its issue or finds an issue with its title. The decisions come
 * before any write, so a title that two issues share stops the run before it changes anything.
 * @param briefs - the validated briefs, in file order.
 * @param listing - the repository's issues.
 * @returns one step per brief.
 * @throws Error when two issues carry the title of one brief.
 */
function planSteps(briefs: readonly Brief[], listing: readonly IssueSummary[]): Step[] {
  return briefs.map((brief, index): Step => {
    const matches = listing.filter(issue => issue.title === brief.title)
    if (matches.length > 1) {
      const numbers = matches.map(issue => `#${String(issue.number)}`).join(' and ')
      throw new Error(`"${brief.title}" is the title of issues ${numbers}; the run cannot tell which one is the brief`)
    }
    const [issue] = matches
    return issue === undefined ? { kind: 'create', brief, index } : { kind: 'existing', brief, issue }
  })
}

/**
 * Create the issues of the briefs that have none, lock each one, and lock the existing issues that are unlocked.
 * @param repository - the repository as `owner/name`.
 * @param briefs - the validated briefs, in file order.
 * @param context - the tree's files and directories, which link the bodies' references.
 * @returns the exit status: 0 when every brief is handled; a failed call throws instead.
 * @throws Error when the signed-in user may not file briefs, when two issues share a brief's title, or when a `gh` call fails.
 */
function createBriefs(repository: string, briefs: readonly Brief[], context: ReferenceContext): number {
  const refusal = maintainerRefusal(repository)
  if (refusal !== undefined) throw new Error(refusal)
  const steps = planSteps(briefs, issueListing(repository))
  const directory = mkdtempSync(join(tmpdir(), 'delo-briefs-'))
  try {
    for (const step of steps) {
      if (step.kind === 'existing') {
        const { issue, brief } = step
        if (issueLocked(repository, issue.number)) {
          console.log(`skipped: "${brief.title}" already exists as #${String(issue.number)} and is locked`)
        } else {
          lockIssue(repository, issue.number)
          console.log(`locked: #${String(issue.number)} "${brief.title}" already existed`)
        }
        continue
      }
      const bodyFile = join(directory, `brief-${String(step.index)}.md`)
      writeFileSync(bodyFile, renderBody(step.brief, context))
      const created = createIssue(repository, { title: step.brief.title, labels: step.brief.labels, milestone: step.brief.milestone, bodyFile })
      console.log(`created: #${String(created)} "${step.brief.title}"`)
      lockIssue(repository, created)
      console.log(`locked: #${String(created)}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return 0
}

/**
 * Create or update each label of the label file.
 * @param repository - the repository as `owner/name`.
 * @param labels - the validated label entries.
 * @returns the exit status: 0 when every label is synced; a failed call throws instead.
 * @throws Error when the signed-in user may not sync labels, or when a `gh` call fails.
 */
function syncLabels(repository: string, labels: readonly LabelDefinition[]): number {
  const refusal = maintainerRefusal(repository)
  if (refusal !== undefined) throw new Error(refusal)
  for (const label of labels) {
    syncLabel(repository, label)
    console.log(`synced: ${label.name}`)
  }
  return 0
}

/**
 * Run one command line.
 * @param argv - the arguments after the script name.
 * @param cwd - the directory the run starts in, inside the repository.
 * @returns the exit status.
 * @throws UsageError for a malformed command line, and Error for a failed check or call; {@link main} reports both.
 */
function run(argv: readonly string[], cwd: string): number {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      repo: { type: 'string' },
      'dry-run': { type: 'boolean' },
      create: { type: 'boolean' },
      'sync-labels': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }
  const mode = modeOf(values)
  const root = repositoryRoot(cwd)
  const labelFile = parseLabels(readFileSync(join(root, LABELS_PATH), 'utf8'))
  if (labelFile.errors.length > 0) return reportProblems(labelFile.errors, 'no label was synced')
  if (mode.kind === 'sync-labels') return syncLabels(mode.repository, labelFile.labels)

  const briefFile = parseBriefs(readFileSync(resolve(cwd, mode.input), 'utf8'))
  const outcome = mode.kind === 'create' ? 'no issue was created' : 'no body was printed'
  const context: BriefContext = {
    ...referenceContext(trackedPaths(root), workingTreeDirectories(root)),
    labels: new Set(labelFile.labels.map(label => label.name)),
  }
  const errors = briefFile.errors.length > 0 ? briefFile.errors : briefErrors(briefFile.briefs, context)
  if (errors.length > 0) return reportProblems(errors, outcome)
  if (mode.kind === 'dry-run') {
    printBodies(briefFile.briefs, context)
    return 0
  }
  return createBriefs(mode.repository, briefFile.briefs, context)
}

/**
 * The command-line entry point: run one command line and report any failure on standard error.
 * @param argv - the arguments after the script name.
 * @param cwd - the directory the run starts in.
 * @returns the exit status: 0 on success, 1 on any problem or failed call.
 */
export function main(argv: readonly string[], cwd: string): number {
  try {
    return run(argv, cwd)
  } catch (error) {
    console.error(`issues: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof UsageError) console.error(USAGE)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2), process.cwd())
