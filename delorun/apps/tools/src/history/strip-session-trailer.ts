/**
 * History rewrite tool for the one-time removal of `Claude-Session:` trailer lines. It rewrites only the
 * commits of a branch that no upstream ref reaches, so upstream's signed commits keep their hashes and the pinned
 * upstream commit stays an ancestor of the new tip. Each rewritten commit is rebuilt from its raw object with only
 * the message changed, so authors, committers, dates, other headers, trees and merge structure carry over exactly.
 * The default is a dry run that writes the report and updates no ref; `--apply` moves the local branch ref only
 * and never pushes. A dry run still writes the new commit objects, which stay unreferenced until a ref points at
 * them. Run: `node_modules/.bin/tsx delorun/apps/tools/src/history/strip-session-trailer.ts --repo <path> --branch <name>
 * [--exclude <rev>]... [--apply] [--report <file>]`.
 *
 * @module @delorun/tools/history/strip-session-trailer
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git } from '../git.ts'

/** The trailer lines the rewrite removes. */
const TRAILER = /^Claude-Session: /u

/** The outcome of a rewrite and its verification. */
export interface RewriteReport {
  /** The branch that was rewritten. */
  readonly branch: string
  /** The tip before the rewrite. */
  readonly oldTip: string
  /** The tip after the rewrite; equal to `oldTip` when no commit changed. */
  readonly newTip: string
  /** Commits reachable from the branch. */
  readonly totalCommits: number
  /** Commits reachable from an upstream ref, left untouched. */
  readonly upstreamCommits: number
  /** Commits whose message changed (and so whose hash changed along with every descendant's). */
  readonly strippedMessages: number
  /** Commits that received a new hash, including descendants of a stripped commit. */
  readonly rewrittenCommits: number
  /** Failures found by the verification; empty when every check passed. */
  readonly problems: readonly string[]
  /** Whether the local branch ref was moved. */
  readonly applied: boolean
}

/**
 * Remove the trailer lines from a commit message.
 * @param message - the message bytes decoded as latin1, so a round trip keeps every byte.
 * @returns the message without trailer lines and without the blank lines they leave at the end, or the input itself when it has no trailer line.
 */
export function stripTrailer(message: string): string {
  const lines = message.split('\n')
  if (!lines.some(line => TRAILER.test(line))) return message
  const kept = lines.filter(line => !TRAILER.test(line))
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  return `${kept.join('\n')}\n`
}

/**
 * Run git with raw bytes in and out.
 * @param root - the repository.
 * @param args - git's arguments.
 * @param input - bytes for standard input.
 * @returns standard output.
 * @throws Error when git fails.
 */
function gitBytes(root: string, args: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 1 << 30, ...input === undefined ? {} : { input } })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/**
 * Select the revisions that mark upstream's history.
 * @param root - the repository.
 * @param extra - additional revisions to exclude.
 * @returns the refs under `refs/remotes/upstream/` and `refs/tags/dsh-*`, then the extra revisions.
 */
function upstreamRevs(root: string, extra: readonly string[]): string[] {
  const refs = git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/upstream', 'refs/tags/dsh-*']).split('\n').filter(line => line.length > 0)
  return [...refs, ...extra]
}

/**
 * Rewrite a branch and verify the result.
 * @param root - the repository.
 * @param branch - a local branch name.
 * @param exclude - extra revisions whose history stays untouched.
 * @param apply - whether to move the local branch ref.
 * @returns the report.
 * @throws Error when git fails or the branch is missing.
 */
export function rewriteBranch(root: string, branch: string, exclude: readonly string[], apply: boolean): RewriteReport {
  const ref = `refs/heads/${branch}`
  const oldTip = git(root, ['rev-parse', '--verify', ref]).trim()
  const marks = upstreamRevs(root, exclude)
  const negatives = marks.map(rev => `^${rev}`)
  const shas = git(root, ['rev-list', '--topo-order', '--reverse', ref, ...negatives]).split('\n').filter(line => line.length > 0)
  const map = new Map<string, string>()
  const stripped = new Set<string>()
  for (const sha of shas) {
    const raw = gitBytes(root, ['cat-file', 'commit', sha]).toString('latin1')
    const split = raw.indexOf('\n\n')
    const headers = split < 0 ? raw : raw.slice(0, split)
    const message = split < 0 ? '' : raw.slice(split + 2)
    const headerLines = headers.split('\n').map(line => {
      if (!line.startsWith('parent ')) return line
      const parent = line.slice('parent '.length)
      return `parent ${map.get(parent) ?? parent}`
    })
    const newMessage = stripTrailer(message)
    if (newMessage !== message) stripped.add(sha)
    const rebuilt = `${headerLines.join('\n')}\n\n${newMessage}`
    const out = gitBytes(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], Buffer.from(rebuilt, 'latin1')).toString('utf8').trim()
    map.set(sha, out)
  }
  const newTip = map.get(oldTip) ?? oldTip
  const problems = verify(root, shas, map, oldTip, newTip, negatives)
  if (apply && problems.length === 0 && newTip !== oldTip) git(root, ['update-ref', ref, newTip, oldTip])
  const rewritten = shas.filter(sha => map.get(sha) !== sha).length
  const total = Number(git(root, ['rev-list', '--count', ref]).trim())
  const upstream = total - shas.length
  return {
    branch, oldTip, newTip, totalCommits: total, upstreamCommits: upstream,
    strippedMessages: stripped.size, rewrittenCommits: rewritten, problems, applied: apply && problems.length === 0 && newTip !== oldTip,
  }
}

/**
 * Check a rewrite against the original history.
 * @param root - the repository.
 * @param shas - the original commits that were rebuilt, parents first.
 * @param map - the old-to-new commit ids.
 * @param oldTip - the original tip.
 * @param newTip - the new tip.
 * @param negatives - the exclusion arguments for rev-list.
 * @returns the problems found; empty when all checks pass.
 */
function verify(root: string, shas: readonly string[], map: ReadonlyMap<string, string>, oldTip: string, newTip: string, negatives: readonly string[]): string[] {
  const problems: string[] = []
  const oldCount = git(root, ['rev-list', '--count', oldTip]).trim()
  const newCount = git(root, ['rev-list', '--count', newTip]).trim()
  if (oldCount !== newCount) problems.push(`commit count changed: ${oldCount} -> ${newCount}`)
  for (const sha of shas) {
    const fresh = map.get(sha)!
    const oldTree = git(root, ['rev-parse', `${sha}^{tree}`]).trim()
    const newTree = git(root, ['rev-parse', `${fresh}^{tree}`]).trim()
    if (oldTree !== newTree) problems.push(`tree of ${sha} changed in ${fresh}`)
    const oldParents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1).map(parent => map.get(parent) ?? parent)
    const newParents = git(root, ['rev-list', '--parents', '-n', '1', fresh]).trim().split(' ').slice(1)
    if (oldParents.join(' ') !== newParents.join(' ')) problems.push(`parents of ${sha} do not map to those of ${fresh}`)
    const meta = (rev: string): string => git(root, ['log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI', rev])
    if (meta(sha) !== meta(fresh)) problems.push(`author or committer data of ${sha} changed in ${fresh}`)
  }
  const remaining = git(root, ['log', '--format=%H', '--grep=^Claude-Session: ', newTip, ...negatives]).trim()
  if (remaining.length > 0) problems.push(`Claude-Session lines remain in ${String(remaining.split('\n').length)} commit(s)`)
  const pin = readPin(root, newTip)
  if (pin !== undefined && spawnSync('git', ['merge-base', '--is-ancestor', pin, newTip], { cwd: root }).status !== 0) problems.push(`the upstream pin ${pin} is not an ancestor of the new tip`)
  return problems
}

/**
 * Read the upstream commit the divergence ledger pins at a revision.
 * @param root - the repository.
 * @param rev - the revision holding the ledger.
 * @returns the pinned commit, or undefined when the revision has no ledger.
 */
function readPin(root: string, rev: string): string | undefined {
  const run = spawnSync('git', ['show', `${rev}:delorun/upstream-patches.json`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.status !== 0) return undefined
  return (JSON.parse(run.stdout) as { upstream: { commit: string } }).upstream.commit
}

/**
 * Render a report as text.
 * @param report - the report.
 * @returns the lines of the report.
 */
export function renderReport(report: RewriteReport): string {
  return [
    `branch ${report.branch}: ${report.oldTip} -> ${report.newTip}`,
    `commits on the branch: ${String(report.totalCommits)}; upstream, left untouched: ${String(report.upstreamCommits)}`,
    `messages stripped: ${String(report.strippedMessages)}; commits with a new hash: ${String(report.rewrittenCommits)}`,
    `verification: ${report.problems.length === 0 ? 'passed (count, trees, parents, identities, trailer, pin)' : `FAILED\n${report.problems.map(problem => `  ${problem}`).join('\n')}`}`,
    `ref moved: ${report.applied ? 'yes' : 'no'}`,
    '',
  ].join('\n')
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string' }, branch: { type: 'string' }, exclude: { type: 'string', multiple: true },
      apply: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, report: { type: 'string' },
    },
  })
  if (values.repo === undefined || values.branch === undefined) {
    console.error('usage: strip-session-trailer.ts --repo <path> --branch <name> [--exclude <rev>]... [--apply|--dry-run] [--report <file>]')
    return 2
  }
  if (values.apply && values['dry-run']) {
    console.error('strip-session-trailer: --apply and --dry-run exclude each other')
    return 2
  }
  const report = rewriteBranch(values.repo, values.branch, values.exclude ?? [], values.apply)
  const text = renderReport(report)
  if (values.report !== undefined) writeFileSync(values.report, text)
  console.log(text)
  return report.problems.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
