/**
 * History scan for the one-time history rewrite: runs the personal-data, secrets and infrastructure gates over every non-merge
 * commit of a branch that no upstream ref reaches. Personal-data and infrastructure read the lines each commit adds,
 * the personal-data gate also reads each commit's identities and message; the secrets gate scans the union of the
 * distinct blobs the commits add or change. A line upstream's pinned copy holds word for word is upstream's and
 * passes, as in the gates. Findings name the commit, the path and the kind and never print a matched value. Run from
 * a checkout of the branch: `node_modules/.bin/tsx delorun/apps/tools/src/history/scan-history.ts --branch <name>`.
 *
 * @module @delorun/tools/history/scan-history
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { HASHES_PATH, addedRuns, personalDataErrors, readHashes, type Source } from '../checks/gates/personal-data.ts'
import { ALLOWLIST_PATH, lineFindings, readAllowlist } from '../checks/gates/infrastructure.ts'
import { scanSecrets } from '../checks/gates/secrets.ts'
import { rangeCommits } from '../checks/gates/commit-range.ts'
import { git, repositoryRoot, runGit } from '../git.ts'
import { identityProblem, readTerms, readinessMatches, type ReadinessKind, type ReadinessTerm } from './public-readiness.ts'

/** One finding: the gate, the commit, the location and the kind of match, without the matched value. */
export interface HistoryFinding {
  /** The gate that reported it. */
  readonly gate: 'personal-data' | 'secrets' | 'infrastructure' | 'public-readiness'
  /** The commit that introduced it, or the first commit that added the blob for the secrets gate. */
  readonly commit: string
  /** The path and line, or the commit field. */
  readonly where: string
  /** What matched. */
  readonly kind: string
  /** The matched text of a public-readiness finding, for the replacement map; reports never print it. */
  readonly value?: string
}

/**
 * Scan the non-upstream commits of a branch.
 * @param root - a checkout of the repository (it holds the hashes file and the allowlist).
 * @param branch - the branch to scan.
 * @param pin - the pinned upstream commit, against which a line counts as upstream's.
 * @param terms - literal names the public-readiness gate looks for as well as its generic classes.
 * @returns the findings.
 */
export async function scanHistory(root: string, branch: string, pin: string, terms: readonly ReadinessTerm[] = []): Promise<HistoryFinding[]> {
  const shas = git(root, ['rev-list', '--reverse', '--no-merges', branch, `^${pin}`, '^refs/remotes/upstream/master']).split('\n').filter(line => line.length > 0)
  const hashes = readHashes(join(root, HASHES_PATH))
  const allowlist = new Set(readAllowlist(join(root, ALLOWLIST_PATH)).entries.map(entry => `${entry.path}\0${entry.value}`))
  const findings: HistoryFinding[] = []
  const blobs = new Map<string, { commit: string; path: string }>()
  for (const sha of shas) {
    const short = sha.slice(0, 10)
    const diff = git(root, ['-c', 'core.quotePath=false', 'show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', sha])
    for (const error of personalDataErrors(hashes, addedRuns(diff))) findings.push({ gate: 'personal-data', commit: short, where: error.split(' ')[0] ?? '', kind: 'personal-data pattern or postal address' })
    let path = ''
    let line = 0
    for (const text of diff.split('\n')) {
      if (text.startsWith('+++ ')) { path = text.slice(4); continue }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(text)
      if (hunk !== null) { line = Number(hunk[1]); continue }
      if (!text.startsWith('+') || path === '/dev/null' || path === ALLOWLIST_PATH) continue
      for (const match of readinessMatches(text.slice(1), terms)) findings.push(readinessFinding(short, `${path}:${String(line)}`, match))
      for (const found of lineFindings(text.slice(1), line)) {
        if (!allowlist.has(`${path}\0${found.value}`)) findings.push({ gate: 'infrastructure', commit: short, where: `${path}:${String(line)}`, kind: found.kind })
      }
      line += 1
    }
    for (const entry of git(root, ['diff-tree', '-r', '--no-renames', '--diff-filter=AM', '--no-commit-id', sha]).split('\n').filter(row => row.length > 0)) {
      const [meta, file] = entry.split('\t')
      const blob = meta?.split(' ')[3]
      if (blob !== undefined && file !== undefined && !blobs.has(`${blob}\0${file}`)) blobs.set(`${blob}\0${file}`, { commit: short, path: file })
    }
  }
  for (const commit of rangeCommits(root, pin)) {
    const runs: Source[][] = [
      [{ where: `commit ${commit.sha.slice(0, 10)} author`, text: `${commit.author.name} <${commit.author.email}>`, patterns: true }],
      [{ where: `commit ${commit.sha.slice(0, 10)} committer`, text: `${commit.committer.name} <${commit.committer.email}>`, patterns: true }],
      commit.message.split('\n').map((text, index) => ({ where: `commit ${commit.sha.slice(0, 10)} message:${String(index + 1)}`, text, patterns: text.startsWith('Signed-off-by:') })),
    ]
    for (const [field, identity] of [['author', commit.author], ['committer', commit.committer]] as const) {
      const problem = identityProblem(identity)
      if (problem !== undefined) findings.push({ gate: 'public-readiness', commit: commit.sha.slice(0, 10), where: `commit ${field}`, kind: problem })
    }
    for (const [index, text] of [commit.author.name, commit.committer.name, ...commit.message.split('\n')].entries()) {
      for (const match of readinessMatches(text, terms)) findings.push(readinessFinding(commit.sha.slice(0, 10), index < 2 ? `commit ${index === 0 ? 'author' : 'committer'} name` : `commit message:${String(index - 1)}`, match))
    }
    for (const error of personalDataErrors(hashes, runs)) findings.push({ gate: 'personal-data', commit: commit.sha.slice(0, 10), where: error.split(' ').slice(0, 3).join(' '), kind: 'personal-data pattern or postal address' })
  }
  findings.push(...await scanBlobs(root, blobs, pin))
  return findings
}

/**
 * Make a public-readiness finding.
 * @param commit - the commit, or `tree` for a scan of the working tree.
 * @param where - the path and line, or the commit field.
 * @param match - what matched.
 * @returns the finding, carrying the matched text for the replacement map.
 */
function readinessFinding(commit: string, where: string, match: ReadinessKind): HistoryFinding {
  return { gate: 'public-readiness', commit, where, kind: match.kind, value: match.value }
}

/**
 * Scan every tracked text file of the working tree for the public-readiness classes.
 * @param root - a checkout of the repository.
 * @param terms - literal names to look for as well.
 * @param skip - tracked path prefixes to leave out, such as vendored sources.
 * @returns the findings, with `commit` set to `tree`.
 */
export function scanTree(root: string, terms: readonly ReadinessTerm[] = [], skip: readonly string[] = ['vendor/', 'pnpm-lock.yaml']): HistoryFinding[] {
  const findings: HistoryFinding[] = []
  for (const path of git(root, ['ls-files', '-z']).split('\0').filter(entry => entry.length > 0 && !skip.some(prefix => entry.startsWith(prefix)))) {
    if (!lstatSync(join(root, path)).isFile()) continue
    const bytes = readFileSync(join(root, path))
    if (bytes.includes(0)) continue
    for (const [index, text] of bytes.toString('utf8').split('\n').entries()) {
      for (const match of readinessMatches(text, terms)) findings.push(readinessFinding('tree', `${path}:${String(index + 1)}`, match))
    }
  }
  return findings
}

/**
 * Count the distinct matched texts of the public-readiness findings.
 * @param findings - the findings.
 * @returns tab-separated `kind`, `value`, `count` lines, most frequent first.
 */
export function readinessValues(findings: readonly HistoryFinding[]): string[] {
  const counts = new Map<string, number>()
  for (const finding of findings) if (finding.value !== undefined) counts.set(`${finding.kind}\t${finding.value}`, (counts.get(`${finding.kind}\t${finding.value}`) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => `${key}\t${String(count)}`)
}

/**
 * Run the secrets gate over distinct blobs written to a scratch directory.
 * @param root - the repository.
 * @param blobs - blob id and path keys to the first commit that added them.
 * @param pin - the pinned upstream commit.
 * @returns the secrets findings.
 */
async function scanBlobs(root: string, blobs: ReadonlyMap<string, { commit: string; path: string }>, pin: string): Promise<HistoryFinding[]> {
  const dir = mkdtempSync(join(tmpdir(), 'delorun-history-scan-'))
  try {
    const paths: string[] = []
    const origin = new Map<string, { commit: string; path: string }>()
    let index = 0
    for (const [key, value] of blobs) {
      const blob = key.split('\0')[0]!
      const content = runGit(root, ['cat-file', 'blob', blob])
      if (content.status !== 0) continue
      const stored = `${String(index++)}/${value.path}`
      mkdirSync(dirname(join(dir, stored)), { recursive: true })
      writeFileSync(join(dir, stored), content.stdout)
      paths.push(stored)
      origin.set(stored, value)
    }
    const upstreamLinesOf = (stored: string): ReadonlySet<string> | undefined => {
      const real = origin.get(stored)?.path ?? stored
      const shown = runGit(root, ['show', `${pin}:${real}`])
      return shown.status === 0 ? new Set(shown.stdout.split('\n')) : undefined
    }
    const result = await scanSecrets(dir, paths, upstreamLinesOf)
    if (result.ok) return []
    const found: HistoryFinding[] = []
    let current = ''
    for (const line of result.output.split('\n')) {
      if (line.length === 0) continue
      if (!line.startsWith(' ')) { current = line; continue }
      const entry = origin.get(current)
      const kind = line.trim().split(/\s{2,}/u)[2] ?? 'secret'
      found.push({ gate: 'secrets', commit: entry?.commit ?? '?', where: `${entry?.path ?? current}:${line.trim().split(/\s+/u)[0] ?? ''}`, kind })
    }
    return found
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The command line.
 * @param argv - `--branch <name>`, `--pin <commit>`, `--terms <file>` (kind<TAB>value lines kept outside the repository), `--tree` to scan the working tree instead of history, `--values-out <file>` to write the distinct matched texts of the public-readiness gate.
 * @returns the exit code: 0 for no findings.
 */
async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { branch: { type: 'string' }, pin: { type: 'string' }, terms: { type: 'string' }, tree: { type: 'boolean' }, 'values-out': { type: 'string' } } })
  const root = repositoryRoot(process.cwd())
  const pin = values.pin ?? '38a6a5c965aa99ab525161efb7cc5cf1fe62fced'
  const terms = values.terms === undefined ? [] : readTerms(values.terms)
  const findings = values.tree === true ? scanTree(root, terms) : await scanHistory(root, values.branch ?? 'HEAD', pin, terms)
  for (const finding of findings) console.log(`${finding.gate}\t${finding.commit}\t${finding.where}\t${finding.kind}`)
  if (values['values-out'] !== undefined) writeFileSync(values['values-out'], `${readinessValues(findings).join('\n')}\n`)
  console.log(`history scan: ${String(findings.length)} finding(s)`)
  return findings.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
