/**
 * The history rewrite for the public opening: for every commit of a branch that no upstream ref reaches, replaces
 * named private strings (a home path, a Windows user name) in file contents and commit messages, optionally removes
 * private planning labels from messages, and removes `Claude-Session:` trailer lines. Upstream's commits keep their
 * hashes. Each rewritten commit is rebuilt from its raw object: authors, committers, dates, other headers, parents
 * (mapped) and merge structure carry over. The replacement strings are read from a file kept outside the repository,
 * one `text<TAB>replacement` per line, so the repository never holds the strings it removes.
 *
 * The result goes to a new local ref (`--out`); the source ref is never moved and nothing is pushed. Verification:
 * commit count, parents, identities and dates; the tip tree must be identical; every other tree may differ only in the
 * paths listed in the report; no replaced string remains in a rewritten message; no `Claude-Session:` line remains.
 * Run: `node delorun/apps/tools/src/history/rewrite-opening.ts --repo <path> --branch <name> --out <name>
 * --replacements <file> [--exclude <rev>]... [--labels] [--report <file>]`.
 *
 * @module @delorun/tools/history/rewrite-opening
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { git } from '../git.ts'

/** One literal replacement. */
export interface Replacement {
  /** The exact text to find. */
  readonly from: string
  /** The text that takes its place. */
  readonly to: string
}

/** The outcome of one rewrite and its verification. */
export interface OpeningReport {
  /** The source branch. */
  readonly branch: string
  /** The source tip. */
  readonly oldTip: string
  /** The rewritten tip. */
  readonly newTip: string
  /** Commits reachable from the source tip. */
  readonly totalCommits: number
  /** Commits left untouched because an upstream ref reaches them. */
  readonly upstreamCommits: number
  /** Commits with a new hash. */
  readonly rewrittenCommits: number
  /** Commits whose message changed. */
  readonly changedMessages: number
  /** Messages that lost a `Claude-Session:` line. */
  readonly strippedTrailers: number
  /** Messages changed by a replacement. */
  readonly replacedInMessages: number
  /** Messages changed by the label rules. */
  readonly labelsRemoved: number
  /** Old commit, new commit and path of each file whose contents changed, one entry per first appearance. */
  readonly changedFiles: readonly { readonly commit: string; readonly path: string }[]
  /** Commits whose tree differs from the original (with the count of replaced blobs each). */
  readonly changedTrees: number
  /** Label-like text still in the rewritten messages, with its commit; for a human to read. */
  readonly leftoverLabels: readonly { readonly commit: string; readonly text: string }[]
  /** Failures found by verification; empty when all checks passed. */
  readonly problems: readonly string[]
}

const TRAILER = /^Claude-Session: /u

/** Parenthesised or comma-trailing citations made only of planning labels, removed by `--labels`. */
const LABEL_TOKEN = String.raw`(?:A[0-9]{2,3}[a-z]?|WP[0-9]+(?:\.[0-9]+)?|ST[0-9]{1,3}|PC[0-9]{1,2}|C[0-9]{1,2}|(?:owner ruling|ruling|decision) A[0-9]{2,3}[a-z]?)`
const LABEL_PAREN = new RegExp(String.raw`\s*\(\s*${LABEL_TOKEN}(?:\s*(?:,|;|/|and|&)\s*${LABEL_TOKEN})*\s*\)`, 'gu')
const LABEL_LEFT = /(?<![-\w.])(?:A[0-9]{2,3}[a-z]?|ST[0-9]{1,3}|PC[0-9]{1,2})(?![-\w])|\b[Ww]ave ?[0-9]\b|docs\/plans\/[\w./*-]*|[Ww]hat is built so far|\bV4\.5\b/gu

/**
 * Read the replacement file.
 * @param path - a file of `text<TAB>replacement` lines; blank lines and `#` lines are skipped.
 * @returns the replacements, longest text first so a longer path wins over a bare name inside it.
 * @throws Error when a line has no tab or an empty text.
 */
export function readReplacements(path: string): Replacement[] {
  const out: Replacement[] = []
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const tab = line.indexOf('\t')
    if (tab < 1) throw new Error(`${path}:${String(index + 1)}: a replacement is text<TAB>replacement`)
    out.push({ from: line.slice(0, tab), to: line.slice(tab + 1) })
  }
  return out.sort((a, b) => b.from.length - a.from.length)
}

/**
 * Apply literal replacements.
 * @param text - the text, decoded as latin1 so a round trip keeps every byte.
 * @param replacements - the replacements, longest first.
 * @returns the text with every occurrence replaced.
 */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  let result = text
  for (const { from, to } of replacements) if (result.includes(from)) result = result.split(from).join(to)
  return result
}

/**
 * Remove `Claude-Session:` lines from a message.
 * @param message - the message decoded as latin1.
 * @returns the message without them and without the blank lines they leave at the end.
 */
export function stripTrailer(message: string): string {
  const lines = message.split('\n')
  if (!lines.some(line => TRAILER.test(line))) return message
  const kept = lines.filter(line => !TRAILER.test(line))
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
  return `${kept.join('\n')}\n`
}

/**
 * Remove private planning labels written as a parenthesised citation, such as `(A381)` or `(owner ruling A443)`.
 * Bare labels inside a sentence are left for a human to read; {@link leftoverLabels} lists them.
 * @param message - the message.
 * @returns the message without those citations.
 */
export function removeLabelCitations(message: string): string {
  return message.replace(LABEL_PAREN, '')
}

/**
 * List planning labels that remain in text.
 * @param message - the message.
 * @returns each matched text.
 */
export function leftoverLabels(message: string): string[] {
  return [...message.matchAll(LABEL_LEFT)].map(match => match[0])
}

/**
 * Read an object as raw bytes.
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

/** Tree entries as git stores them: mode, type, object, name bytes. */
interface Entry { readonly mode: string; readonly type: string; readonly sha: string; readonly name: Buffer }

/**
 * Parse `git ls-tree -z` output.
 * @param raw - the bytes.
 * @returns the entries in git's order.
 */
function parseTree(raw: Buffer): Entry[] {
  const entries: Entry[] = []
  let start = 0
  while (start < raw.length) {
    const end = raw.indexOf(0, start)
    const record = raw.subarray(start, end)
    const tab = record.indexOf(9)
    const [mode, type, sha] = record.subarray(0, tab).toString('latin1').split(/[ ]+/u)
    entries.push({ mode: mode!, type: type!, sha: sha!, name: Buffer.from(record.subarray(tab + 1)) })
    start = end + 1
  }
  return entries
}

/**
 * Rewrite a branch.
 * @param root - the repository (a mirror clone; objects are added, the source ref is untouched).
 * @param branch - the source local branch.
 * @param out - the local branch to create for the result.
 * @param exclude - extra revisions whose history stays untouched.
 * @param replacements - the literal replacements for file contents and messages.
 * @param labels - whether to remove parenthesised planning-label citations from messages.
 * @returns the report.
 * @throws Error when git fails or the branch is missing.
 */
export function rewriteForOpening(root: string, branch: string, out: string, exclude: readonly string[], replacements: readonly Replacement[], labels: boolean): OpeningReport {
  const oldTip = git(root, ['rev-parse', '--verify', `refs/heads/${branch}`]).trim()
  const marks = git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes/upstream', 'refs/tags/dsh-*']).split('\n').filter(line => line.length > 0)
  const negatives = [...marks, ...exclude].map(rev => `^${rev}`)
  const shas = git(root, ['rev-list', '--topo-order', '--reverse', oldTip, ...negatives]).split('\n').filter(line => line.length > 0)
  const blobMemo = new Map<string, string>()
  const treeMemo = new Map<string, string>()
  const changedFiles: { commit: string; path: string }[] = []
  let currentCommit = ''
  const newTree = (tree: string, prefix: string): string => {
    const known = treeMemo.get(tree)
    if (known !== undefined) return known
    let changed = false
    const entries = parseTree(gitBytes(root, ['ls-tree', '-z', tree])).map(entry => {
      if (entry.type === 'commit') return entry
      const path = `${prefix}${entry.name.toString('utf8')}`
      let sha: string
      if (entry.type === 'tree') sha = newTree(entry.sha, `${path}/`)
      else {
        const memo = blobMemo.get(entry.sha)
        if (memo !== undefined) sha = memo
        else {
          const body = gitBytes(root, ['cat-file', 'blob', entry.sha])
          const text = body.toString('latin1')
          const next = applyReplacements(text, replacements)
          sha = next === text ? entry.sha : gitBytes(root, ['hash-object', '-t', 'blob', '-w', '--stdin'], Buffer.from(next, 'latin1')).toString('utf8').trim()
          blobMemo.set(entry.sha, sha)
          if (sha !== entry.sha) changedFiles.push({ commit: currentCommit, path })
        }
      }
      if (sha !== entry.sha) changed = true
      return { ...entry, sha }
    })
    let result = tree
    if (changed) {
      const lines = entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.type} ${entry.sha}\t`, 'latin1'), entry.name, Buffer.from([0])]))
      result = gitBytes(root, ['mktree', '-z', '--missing'], Buffer.concat(lines)).toString('utf8').trim()
    }
    treeMemo.set(tree, result)
    return result
  }
  const map = new Map<string, string>()
  let changedMessages = 0
  let strippedTrailers = 0
  let replacedInMessages = 0
  let labelsRemoved = 0
  const leftovers: { commit: string; text: string }[] = []
  for (const sha of shas) {
    currentCommit = sha
    const raw = gitBytes(root, ['cat-file', 'commit', sha]).toString('latin1')
    const split = raw.indexOf('\n\n')
    const headerText = split < 0 ? raw : raw.slice(0, split)
    const message = split < 0 ? '' : raw.slice(split + 2)
    let next = stripTrailer(message)
    if (next !== message) strippedTrailers += 1
    const replaced = applyReplacements(next, replacements)
    if (replaced !== next) replacedInMessages += 1
    next = replaced
    if (labels) {
      const cleaned = removeLabelCitations(next)
      if (cleaned !== next) labelsRemoved += 1
      next = cleaned
    }
    if (next !== message) changedMessages += 1
    for (const text of leftoverLabels(next)) leftovers.push({ commit: sha, text })
    const oldTree = /^tree ([0-9a-f]+)/mu.exec(headerText)![1]!
    const fresh = newTree(oldTree, '')
    const lines = headerText.split('\n')
    const headers: string[] = []
    let inSignature = false
    for (const line of lines) {
      if (line.startsWith('tree ')) { headers.push(`tree ${fresh}`); inSignature = false; continue }
      if (line.startsWith('parent ')) { const parent = line.slice(7); headers.push(`parent ${map.get(parent) ?? parent}`); inSignature = false; continue }
      if (line.startsWith('gpgsig')) { inSignature = true; continue }
      if (inSignature && line.startsWith(' ')) continue
      inSignature = false
      headers.push(line)
    }
    const rebuilt = `${headers.join('\n')}\n\n${next}`
    const id = gitBytes(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], Buffer.from(rebuilt, 'latin1')).toString('utf8').trim()
    map.set(sha, id)
  }
  const newTip = map.get(oldTip) ?? oldTip
  git(root, ['update-ref', `refs/heads/${out}`, newTip])
  const problems = verify(root, shas, map, oldTip, newTip, negatives, replacements)
  const total = Number(git(root, ['rev-list', '--count', oldTip]).trim())
  const changedTrees = shas.filter(sha => git(root, ['rev-parse', `${sha}^{tree}`]).trim() !== git(root, ['rev-parse', `${map.get(sha)!}^{tree}`]).trim()).length
  return {
    branch, oldTip, newTip, totalCommits: total, upstreamCommits: total - shas.length,
    rewrittenCommits: shas.filter(sha => map.get(sha) !== sha).length, changedMessages, strippedTrailers, replacedInMessages, labelsRemoved,
    changedFiles, changedTrees, leftoverLabels: leftovers, problems,
  }
}

/**
 * Check a rewrite against the source history.
 * @param root - the repository.
 * @param shas - the source commits that were rebuilt, parents first.
 * @param map - source commit to new commit.
 * @param oldTip - the source tip.
 * @param newTip - the new tip.
 * @param negatives - exclusion arguments for rev-list.
 * @param replacements - the replacements; none of their texts may remain in a rewritten message.
 * @returns the problems found.
 */
function verify(root: string, shas: readonly string[], map: ReadonlyMap<string, string>, oldTip: string, newTip: string, negatives: readonly string[], replacements: readonly Replacement[]): string[] {
  const problems: string[] = []
  const oldCount = git(root, ['rev-list', '--count', oldTip]).trim()
  const newCount = git(root, ['rev-list', '--count', newTip]).trim()
  if (oldCount !== newCount) problems.push(`commit count changed: ${oldCount} -> ${newCount}`)
  const treeOf = (rev: string): string => git(root, ['rev-parse', `${rev}^{tree}`]).trim()
  if (treeOf(oldTip) !== treeOf(newTip)) problems.push(`the tip tree changed: ${treeOf(oldTip)} -> ${treeOf(newTip)}`)
  for (const sha of shas) {
    const fresh = map.get(sha)!
    const oldParents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1).map(parent => map.get(parent) ?? parent)
    const newParents = git(root, ['rev-list', '--parents', '-n', '1', fresh]).trim().split(' ').slice(1)
    if (oldParents.join(' ') !== newParents.join(' ')) problems.push(`parents of ${sha} do not map to those of ${fresh}`)
    const meta = (rev: string): string => git(root, ['log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI', rev])
    if (meta(sha) !== meta(fresh)) problems.push(`author or committer data of ${sha} changed in ${fresh}`)
  }
  const remaining = git(root, ['log', '--format=%H', '--grep=^Claude-Session: ', newTip, ...negatives]).trim()
  if (remaining.length > 0) problems.push(`Claude-Session lines remain in ${String(remaining.split('\n').length)} commit(s)`)
  const messages = git(root, ['log', '--format=%B', newTip, ...negatives])
  for (const { from } of replacements) if (messages.includes(from)) problems.push('a replaced text remains in a commit message')
  return problems
}

/**
 * Render a report for the owner.
 * @param report - the report.
 * @returns the lines.
 */
export function renderOpeningReport(report: OpeningReport): string {
  const files = new Map<string, number>()
  for (const file of report.changedFiles) files.set(file.path, (files.get(file.path) ?? 0) + 1)
  return [
    `branch ${report.branch}: ${report.oldTip} -> ${report.newTip}`,
    `commits on the branch: ${String(report.totalCommits)}; upstream, left untouched: ${String(report.upstreamCommits)}; with a new hash: ${String(report.rewrittenCommits)}`,
    `messages changed: ${String(report.changedMessages)} (trailer lines removed: ${String(report.strippedTrailers)}; text replaced: ${String(report.replacedInMessages)}; label citations removed: ${String(report.labelsRemoved)})`,
    `commits whose tree changed: ${String(report.changedTrees)}; distinct files whose contents changed: ${String(files.size)}`,
    ...[...files].map(([path, count]) => `  ${path} (${String(count)} version${count === 1 ? '' : 's'})`),
    `planning labels still in messages: ${String(report.leftoverLabels.length)}`,
    ...report.leftoverLabels.map(item => `  ${item.commit.slice(0, 10)}: ${item.text}`),
    `verification: ${report.problems.length === 0 ? 'passed (count, parents, identities, tip tree, trailer, replaced text)' : `FAILED\n${report.problems.map(problem => `  ${problem}`).join('\n')}`}`,
    '',
  ].join('\n')
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: 'string' }, branch: { type: 'string' }, out: { type: 'string' }, replacements: { type: 'string' },
      exclude: { type: 'string', multiple: true }, labels: { type: 'boolean', default: false }, report: { type: 'string' },
    },
  })
  if (values.repo === undefined || values.branch === undefined || values.out === undefined || values.replacements === undefined) {
    console.error('usage: rewrite-opening.ts --repo <path> --branch <name> --out <name> --replacements <file> [--exclude <rev>]... [--labels] [--report <file>]')
    return 2
  }
  const report = rewriteForOpening(values.repo, values.branch, values.out, values.exclude ?? [], readReplacements(values.replacements), values.labels)
  const text = renderOpeningReport(report)
  if (values.report !== undefined) writeFileSync(values.report, text)
  console.log(text)
  return report.problems.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
