/**
 * Personal-data gate. Plain patterns (names, email addresses, phone numbers) live only in a local file outside the
 * repository, `~/.config/delo/personal-data.txt`. The repository stores each pattern as a salted SHA-256 hash in
 * `personal-data.hashes.json`, with the salt beside the hashes. The gate fails on a hash match in the lines a change
 * adds, and it refuses a postal address by shape in those lines and in commit messages, without storing any address.
 * A line that upstream holds word for word is not an added line, so a range or staged check does not read it. A failure
 * names the location and never prints the pattern. Run from anywhere inside the repository:
 *
 * - `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/personal-data.ts --base <rev> [paths...]` reads the lines
 *   that `<rev>...HEAD` adds, the Author, Committer and Signed-off-by lines and messages of its commits, and the lines
 *   the staged changes add to the paths;
 * - `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/personal-data.ts [paths...]` reads the lines the staged
 *   changes add to the paths, which the runner passes at pre-commit;
 * - `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/personal-data.ts` with neither reads every whole file that
 *   differs from the pinned upstream commit;
 * - `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/personal-data.ts --rehash` regenerates the hashes file
 *   from the local patterns file, and exits 1 when that file does not exist.
 *
 * @module @delo/tools/checks/gates/personal-data
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { git, repositoryRoot } from '../../git.ts'
import { rangeCommits, type Identity, type RangeCommit } from './commit-range.ts'
import { regularFiles, scanTarget } from './paths.ts'
import { startsPostalAddress } from './postal-address.ts'

/** The committed hashes file, relative to the repository root. */
export const HASHES_PATH = 'delo/apps/tools/src/checks/gates/personal-data.hashes.json'

/** Phone-like digit runs with at least this many digits are normalised as phone numbers. */
const MIN_PHONE_DIGITS = 7

/** The longest pattern, in words, that the gate matches; a longer name is refused when it is hashed. */
const MAX_WORDS = 8

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const PHONE_TEXT = /^\+?[\d\s().-]+$/u
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu
const DIGIT_RUN = /\+?\d[\d\s().-]*\d/gu

const hashesFile = z.strictObject({
  $comment: z.string().optional(),
  algorithm: z.literal('sha256'),
  salt: z.string().regex(/^[0-9a-f]{32,}$/u, { error: 'the salt is hexadecimal, at least 128 bits' }),
  hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/u, { error: 'each hash is a lowercase SHA-256 hex digest' })),
})

/** The hashes file: the salt and the salted hash of each pattern. */
export type HashesFile = z.infer<typeof hashesFile>

/** One line of text the gate reads, with the location a finding names. */
export interface Source {
  /** The location a finding names, such as `path:12` or `commit 1a2b3c4d5e author`. */
  readonly where: string
  /** The line's text. */
  readonly text: string
  /** False for lines the gate scans for postal addresses only, such as a commit message's body. */
  readonly patterns: boolean
}

/**
 * The canonical form of one pattern line: `email:` plus the lowercased address, `phone:` plus the digits, or
 * `words:` plus the lowercased words joined by one space.
 * @param line - one line of the local patterns file.
 * @returns the canonical form, or undefined for a blank line or a comment.
 * @throws Error when the line has no letters or digits, or more than {@link MAX_WORDS} words; the message never
 *   repeats the line.
 */
export function canonicalPattern(line: string): string | undefined {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return undefined
  if (EMAIL_PATTERN.test(text)) return `email:${text.toLowerCase()}`
  const digits = text.replace(/\D/gu, '')
  if (PHONE_TEXT.test(text) && digits.length >= MIN_PHONE_DIGITS) return `phone:${digits}`
  const words = wordsOf(text)
  if (words.length === 0) throw new Error('a pattern has no letters or digits')
  if (words.length > MAX_WORDS) throw new Error(`a pattern has more than ${String(MAX_WORDS)} words`)
  return `words:${words.join(' ')}`
}

/**
 * The lowercased words of a text, split at every character that is neither a letter nor a digit.
 * @param text - the text to split.
 * @returns the words, in order.
 */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The salted SHA-256 digest of one canonical form.
 * @param salt - the salt from the hashes file.
 * @param canonical - a canonical form from {@link canonicalPattern}.
 * @returns the lowercase hexadecimal digest.
 */
export function hashCanonical(salt: string, canonical: string): string {
  return createHash('sha256').update(`${salt}\n${canonical}`).digest('hex')
}

/**
 * The canonical forms a line of text carries: its email addresses, its phone-like digit runs, and every run of up
 * to {@link MAX_WORDS} consecutive words.
 * @param line - one line of text.
 * @returns the distinct canonical forms.
 */
export function lineCandidates(line: string): string[] {
  const candidates = new Set<string>()
  for (const match of line.matchAll(EMAIL_IN_TEXT)) candidates.add(`email:${match[0].toLowerCase()}`)
  for (const match of line.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/\D/gu, '')
    if (digits.length >= MIN_PHONE_DIGITS) candidates.add(`phone:${digits}`)
  }
  const words = wordsOf(line)
  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= MAX_WORDS && start + length <= words.length; length += 1) {
      candidates.add(`words:${words.slice(start, start + length).join(' ')}`)
    }
  }
  return [...candidates]
}

/**
 * Read and validate the committed hashes file.
 * @param path - the absolute path of the hashes file.
 * @returns the salt and the hashes.
 * @throws Error when the file is missing, is not JSON, or does not match the hashes schema.
 */
export function readHashes(path: string): HashesFile {
  return hashesFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * The personal-data violations in runs of consecutive lines: a line whose tokens match a hashed pattern, and a line that
 * starts a postal address shape, which may continue on the next line of its run.
 * @param hashes - the salt and the hashed patterns.
 * @param runs - runs of consecutive lines, each in file or message order.
 * @returns one message per violation, naming the location; empty when the lines are clean.
 */
export function personalDataErrors(hashes: HashesFile, runs: readonly (readonly Source[])[]): string[] {
  const known = new Set(hashes.hashes)
  return runs.flatMap(run => run.flatMap((source, index) => {
    const errors: string[] = []
    if (source.patterns && known.size > 0 && lineCandidates(source.text).some(candidate => known.has(hashCanonical(hashes.salt, candidate)))) {
      errors.push(`${source.where}: matches a personal-data pattern (the pattern is not printed)`)
    }
    if (startsPostalAddress(source.text, run[index + 1]?.text)) errors.push(`${source.where}: carries a postal address`)
    return errors
  }))
}

/**
 * The hashes of every pattern in a local patterns file.
 * @param text - the patterns file's text, one pattern per line.
 * @param salt - the salt to hash with.
 * @returns the distinct hashes, sorted.
 * @throws Error naming the first invalid line by number; the message never repeats the line.
 */
export function hashPatterns(text: string, salt: string): string[] {
  const hashes = new Set<string>()
  text.split('\n').forEach((line, index) => {
    try {
      const canonical = canonicalPattern(line)
      if (canonical !== undefined) hashes.add(hashCanonical(salt, canonical))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`line ${String(index + 1)}: ${reason}`)
    }
  })
  return [...hashes].sort()
}

/**
 * Regenerate a hashes file from a local patterns file and write it.
 * @param patternsPath - the local patterns file.
 * @param hashesPath - the hashes file to write.
 * @param salt - the new salt, lowercase hexadecimal of at least 128 bits.
 * @returns the number of hashed patterns written.
 * @throws Error when the patterns file does not exist or a line is invalid.
 */
export function rehash(patternsPath: string, hashesPath: string, salt: string): number {
  if (!existsSync(patternsPath)) throw new Error(`no local patterns file at ${patternsPath}`)
  const hashes = hashPatterns(readFileSync(patternsPath, 'utf8'), salt)
  const file: HashesFile = { $comment: 'Salted SHA-256 hashes of the personal-data patterns; regenerate with --rehash.', algorithm: 'sha256', salt, hashes }
  writeFileSync(hashesPath, `${JSON.stringify(file, null, 2)}\n`)
  return hashes.length
}

/**
 * The added lines of a `git diff --unified=0 --no-prefix` output, grouped into runs. A run is the `+` lines of one hunk,
 * which are consecutive in the new file. Headers are read only before a hunk, so an added line whose text begins with
 * `++` is still an added line.
 * @param diff - the diff's text.
 * @returns one run per hunk that adds lines, each line named `path:line` and carrying the text it adds.
 */
export function addedRuns(diff: string): Source[][] {
  const runs: Source[][] = []
  let path = ''
  let line = 0
  let inHunk = false
  let run: Source[] | undefined
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff ')) {
      inHunk = false
      run = undefined
    } else if (text.startsWith('@@')) {
      inHunk = true
      line = hunkStart(text)
      run = undefined
    } else if (!inHunk) {
      if (text.startsWith('+++ ')) path = text.slice('+++ '.length)
    } else if (text.startsWith('+')) {
      if (run === undefined) {
        run = []
        runs.push(run)
      }
      run.push({ where: `${path}:${String(line)}`, text: text.slice(1), patterns: true })
      line += 1
    }
  }
  return runs
}

/**
 * The first line of a hunk in the new file.
 * @param header - a `@@ -a,b +c,d @@` header line.
 * @returns c, the new file's first line of the hunk.
 */
function hunkStart(header: string): number {
  return Number(/^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(header)?.[1] ?? '0')
}

/**
 * The output of `git diff --unified=0` with the options the gate reads. The options keep the output independent of the
 * user's diff configuration: no external diff, no textconv, no colour and no path prefixes.
 * @param root - the repository root.
 * @param args - the arguments after `diff`, such as `--cached` or a revision range.
 * @returns the diff's text.
 */
function diffText(root: string, args: readonly string[]): string {
  return git(root, ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', ...args])
}

/**
 * The lines of one whole file, as one run, or none when the file is binary.
 * @param root - the repository root.
 * @param path - a repository-relative path.
 * @returns the file's lines, each named `path:line`; empty for a binary file.
 */
function wholeFileRuns(root: string, path: string): Source[][] {
  const text = readFileSync(join(root, path), 'utf8')
  if (text.includes('\0')) return []
  return [text.split('\n').map((line, index) => ({ where: `${path}:${String(index + 1)}`, text: line, patterns: true }))]
}

/**
 * The runs a commit contributes: its Author and Committer identities, each as a run of one line, and its message as one
 * run for the postal-address check. A Signed-off-by line of the message also takes the pattern check.
 * @param commit - a commit of the range.
 * @returns the runs of that commit.
 */
function commitRuns(commit: RangeCommit): Source[][] {
  const short = commit.sha.slice(0, 10)
  const identity = (role: string, who: Identity): Source[] => [{ where: `commit ${short} ${role}`, text: `${who.name} <${who.email}>`, patterns: true }]
  const message: Source[] = commit.message.split('\n').map((text, index) => ({
    where: `commit ${short} message:${String(index + 1)}`,
    text,
    patterns: text.startsWith('Signed-off-by:'),
  }))
  return [identity('author', commit.author), identity('committer', commit.committer), message]
}

/**
 * The runs a check reads. With paths or a base, these are the lines the staged changes add to the paths, the lines the
 * range adds and the commit lines of the range. With neither, they are the whole files that differ from the pinned
 * upstream commit.
 * @param root - the repository root.
 * @param paths - the staged paths the runner passed; empty when none were given.
 * @param base - the revision the range starts after, or undefined when no range is given.
 * @returns the runs of lines to check.
 */
function scanRuns(root: string, paths: readonly string[], base: string | undefined): Source[][] {
  if (paths.length === 0 && base === undefined) {
    return regularFiles(root, scanTarget(root, []).paths).flatMap(path => wholeFileRuns(root, path))
  }
  const runs: Source[][] = []
  if (paths.length > 0) runs.push(...addedRuns(diffText(root, ['--cached', '--', ...paths])))
  if (base !== undefined) {
    runs.push(...addedRuns(diffText(root, [`${base}...HEAD`, '--'])))
    for (const commit of rangeCommits(root, base)) runs.push(...commitRuns(commit))
  }
  return runs
}

/**
 * Generate a fresh salt.
 * @returns 128 random bits, as lowercase hexadecimal.
 */
function freshSalt(): string {
  return randomBytes(16).toString('hex')
}

/**
 * The local patterns file of the current user.
 * @returns `~/.config/delo/personal-data.txt` under the home directory.
 */
export function localPatternsPath(): string {
  return join(homedir(), '.config', 'delo', 'personal-data.txt')
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { base: { type: 'string' }, rehash: { type: 'boolean', default: false } },
    strict: true,
  })
  const root = repositoryRoot(process.cwd())
  if (values.rehash) {
    const patterns = localPatternsPath()
    if (!existsSync(patterns)) {
      console.error(`gates:personal-data: no local patterns file at ${patterns}; nothing to hash`)
      return 1
    }
    const count = rehash(patterns, join(root, HASHES_PATH), freshSalt())
    console.log(`gates:personal-data: wrote ${String(count)} salted hash(es) to ${HASHES_PATH}`)
    return 0
  }
  const hashes = readHashes(join(root, HASHES_PATH))
  const runs = scanRuns(root, positionals, values.base)
  const errors = personalDataErrors(hashes, runs)
  for (const error of errors) console.error(`gates:personal-data: ${error}`)
  if (errors.length > 0) {
    console.error('gates:personal-data: refused; remove the value, or rewrite the line without the address or name')
    return 1
  }
  const checked = runs.reduce((count, run) => count + run.length, 0)
  console.log(`gates:personal-data: no personal data in the ${String(checked)} line(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
