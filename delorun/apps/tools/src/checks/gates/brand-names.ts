/**
 * One name for the product: Delorun. The gate refuses an old spelling of the name, the old npm scope and an upstream's
 * name presented as Delorun's own, in the files Delorun owns (A550, A556, A561). Upstream's own files keep their names
 * until the pull request that renames what the product shows (A564), so they are not read.
 *
 * Three rules, each with the patterns it matches (the examples of the first rule are quoted with the first letter
 * spaced out; the patterns and examples of this file still read as refusals, so `brand-names.allowlist.json` lists this
 * file for `spelling` and `upstream-as-name`):
 *
 * - `spelling`: the product written as two words or joined wrongly, or the first word alone.
 *   - `D elo Run`, in any letter case, with spaces, no-break spaces or hyphens between the words, as in `D elo-Run`;
 *   - `D eloRun`, the first word and a capital R written together;
 *   - `D elo` as a word of its own, in any letter case (`D elo` next to a CJK character is a word, so a Chinese line
 *     that starts with it is refused). A hostname (`d elo.run`, the spare release host), a reverse-DNS label
 *     (`run.d elo.home`, a container label), a path segment (`/home/x/d elo/`, `d elo-review/`) and a URL to
 *     `github.com/TwickaS/...` are not a written name and pass. Lines of `BRAND_GUIDELINES*` that quote the forbidden
 *     spellings in order to forbid them (`Never write "D elo", ...`) pass by their quoted form, so that file needs no
 *     allowlist entry.
 * - `scope`: `@d elo/`; the scope is `@delorun/`.
 * - `upstream-as-name`: DeepSeek Harness (DSH) or DeepSeek presented as Delorun's name or maker. The patterns are
 *   narrow because nearly every line that names DeepSeek Harness in the tree is truthful ("stock DeepSeek Harness",
 *   "like DeepSeek Harness", "built on", "from", "compared with", "Your DeepSeek Harness folder", "Import from DSH",
 *   "the official DeepSeek route" for DeepSeek's own API), and these stay:
 *   - Delorun with the upstream name in brackets: `Delorun (DeepSeek Harness)`, `Delorun (DSH)`, also with full-width
 *     brackets;
 *   - the upstream name in front of Delorun: `DeepSeek Harness Delorun`, `DSH Delorun`, `DeepSeek Delorun`;
 *   - Delorun made by DeepSeek: `Delorun by DeepSeek`, `Delorun is made by DeepSeek` (built, developed, published,
 *     released, created, maintained, owned or run by);
 *   - Delorun said to be upstream: `Delorun is DeepSeek Harness`, `Delorun is a DeepSeek ...`, `Delorun is the
 *     official DSH`;
 *   - the upstream product called official: `official DeepSeek Harness`, `official DSH`, and `official DeepSeek`
 *     followed by build, release, app, product, client, version, fork or edition. `official DeepSeek route`, `official
 *     DeepSeek listing` and the like name DeepSeek's own API and pass.
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/brand-names.ts` exits 1 with one line per refusal. A file
 * that must keep a spelling is listed with a reason in `brand-names.allowlist.json`; the list only shrinks and starts
 * empty.
 *
 * Paths read: `delorun/**`, `.agents/skills/delorun-*`, `.agents/notes` files named `*-delorun-*`, `.github/**` (A555),
 * and the root files Delorun owns (`README*`, `BRAND_GUIDELINES*`, `CONTRIBUTING*`, `GOVERNANCE.md`, `LICENSE`).
 * Never read: the changelog files that record history (`delorun/changelog/releases/**`,
 * `delorun/changelog/changelog.json`), `delorun/upstream-patches.json`, whose reasons may quote history, this file and
 * binary files. When the pull request that renames upstream's product-visible names lands, the paths widen.
 *
 * @module @delorun/tools/checks/gates/brand-names
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { git, repositoryRoot } from '../../git.ts'

/** The allowlist's repository-relative path. */
export const ALLOWLIST_PATH = 'delorun/apps/tools/src/checks/gates/brand-names.allowlist.json'

/** The rules a line can break. */
export const RULES = ['spelling', 'scope', 'upstream-as-name'] as const

/** One rule of the gate. */
export type Rule = typeof RULES[number]

const allowlistFile = z.object({
  entries: z.array(z.object({
    path: z.string().min(1),
    rule: z.enum(RULES),
    reason: z.string().min(1),
  })),
})

/** The documented exceptions: files that keep a spelling, the rule they are exempt from and why. */
export type Allowlist = z.infer<typeof allowlistFile>

/** One refusal. */
export interface Finding {
  readonly rule: Rule
  readonly line: number
  readonly message: string
}

/** The paths Delorun owns and the gate reads (A564). */
const READ = [
  /^delorun\//,
  /^\.agents\/skills\/delorun-[^/]+\//,
  /^\.agents\/notes\/(?:[^/]+\/)*[^/]*-delorun-[^/]*$/,
  /^\.github\//,
  /^(?:README|BRAND_GUIDELINES|CONTRIBUTING)[^/]*$/,
  /^(?:GOVERNANCE\.md|LICENSE)$/,
]

/** The paths inside the owned trees that record history and are never read. */
const NEVER_READ = [
  /^delorun\/changelog\/releases\//,
  /^delorun\/changelog\/changelog\.json$/,
  /^delorun\/upstream-patches\.json$/,
]

/** The brand guidelines, whose quoted list of forbidden spellings passes. */
const GUIDELINES = /^BRAND_GUIDELINES[^/]*$/

/** A sentence that lists forbidden names in double quotes in order to forbid them, as the guidelines do. */
const QUOTED_FORBIDDEN = /Never write (?:"[^"]*"(?:, | or )?)+/g

/** A URL to the repository's own organisation, whose repository names are not the product's. */
const OWN_URL = /github\.com\/twickas\/\S*/gi

/** The first word with the second after spaces or hyphens, in any case. */
const SPLIT_NAME = /(?<![\w./~@-])delo[\s -]+run(?![\w])/i
/** The joined form: only the capital R spells the wrong name, as `delorun` and `DELORUN` are the right one. */
const JOINED_NAME = /\bDeloRun\b/
/**
 * The first word alone, in any case. Not a name: a hostname (`delo.run`), a label or path segment (a neighbour of
 * `.`, `/`, `~`, `@`, `-`, `_` or a letter or digit), which the neighbours below leave out.
 */
const BARE_NAME = /(?<![\w./~@-])delo(?![\w/-]|\.[a-z])/i
/** The old npm scope. */
const OLD_SCOPE = /@delo\//i

/** The upstream's name in front of Delorun, or Delorun with the upstream's name in brackets. */
const UPSTREAM_BEFORE = /\b(?:DeepSeek Harness|DSH|DeepSeek) Delorun\b|\bDelorun [(（](?:the )?(?:DeepSeek|DSH)\b/
/** Delorun made, built or published by DeepSeek. */
const UPSTREAM_MAKER = /\bDelorun,? (?:by|(?:is |was )?(?:made|built|developed|published|released|created|maintained|owned|run) by)(?: the)? DeepSeek\b/
/** Delorun said to be the upstream product. */
const UPSTREAM_IS = /\bDelorun is (?:(?:a|an|the) )?(?:official )?(?:DeepSeek(?!-)|DSH(?![\w-]))/
/** The upstream product called official; `official DeepSeek` alone names DeepSeek's own API route and passes. */
const UPSTREAM_OFFICIAL = /\bofficial (?:DeepSeek Harness\b|DSH(?![\w-])|DeepSeek (?:build|release|app|product|client|version|fork|edition)\b)/

/**
 * Whether the gate reads a path.
 * @param path - the repository-relative path.
 * @returns true for a file Delorun owns that is not a record of history.
 */
export function isRead(path: string): boolean {
  return READ.some(pattern => pattern.test(path)) && !NEVER_READ.some(pattern => pattern.test(path))
}

/**
 * The refusals of one line.
 * @param line - the line's text.
 * @param path - the repository-relative path, which decides whether the guidelines' quoted list passes.
 * @returns the rules the line breaks, one finding per rule at most.
 */
function ruleFindings(line: string, path: string): Rule[] {
  const checked = (GUIDELINES.test(path) ? line.replace(QUOTED_FORBIDDEN, '') : line).replace(OWN_URL, '')
  const found: Rule[] = []
  if (SPLIT_NAME.test(checked) || JOINED_NAME.test(checked) || BARE_NAME.test(checked)) found.push('spelling')
  if (OLD_SCOPE.test(checked)) found.push('scope')
  if ([UPSTREAM_BEFORE, UPSTREAM_MAKER, UPSTREAM_IS, UPSTREAM_OFFICIAL].some(pattern => pattern.test(checked))) found.push('upstream-as-name')
  return found
}

const MESSAGES: Readonly<Record<Rule, string>> = {
  spelling: 'an old spelling of the name; the product is always "Delorun"',
  scope: 'the old npm scope; the scope is @delorun/',
  'upstream-as-name': 'DeepSeek Harness or DeepSeek presented as the name or maker of Delorun; say what Delorun is built on, in truthful words',
}

/**
 * The refusals of one file's text.
 * @param path - the repository-relative path.
 * @param text - the file's text.
 * @returns one finding per line and rule that break a rule.
 */
export function lineFindings(path: string, text: string): Finding[] {
  return text.split('\n').flatMap((line, index) => ruleFindings(line, path).map((rule): Finding => ({ rule, line: index + 1, message: MESSAGES[rule] })))
}

/**
 * Read the allowlist.
 * @param path - the absolute path of the allowlist file.
 * @returns the documented exceptions.
 * @throws Error when the file is not JSON or does not match the schema, an entry without a reason included.
 */
export function readAllowlist(path: string): Allowlist {
  return allowlistFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * The refusals of one file after the allowlist.
 * @param path - the repository-relative path.
 * @param text - the file's text.
 * @param allowlist - the documented exceptions.
 * @returns one message per refusal; empty for a path the gate does not read.
 */
export function fileErrors(path: string, text: string, allowlist: Allowlist): string[] {
  if (!isRead(path)) return []
  const exempt = new Set<Rule>(allowlist.entries.filter(entry => entry.path === path).map(entry => entry.rule))
  return lineFindings(path, text).filter(finding => !exempt.has(finding.rule)).map(finding => `${path}:${String(finding.line)}: ${finding.message}`)
}

async function main(): Promise<number> {
  const root = repositoryRoot(process.cwd())
  const allowlist = readAllowlist(join(root, ALLOWLIST_PATH))
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(isRead)
  let read = 0
  const errors = paths.flatMap(path => {
    const bytes = readFileSync(join(root, path))
    if (bytes.includes(0)) return []
    read += 1
    return fileErrors(path, bytes.toString('utf8'), allowlist)
  })
  for (const error of errors) console.error(`gates:brand-names: ${error}`)
  if (errors.length > 0) {
    console.error('gates:brand-names: refused; the product is Delorun, the scope is @delorun/ and upstream is named only for what it is')
    return 1
  }
  console.log(`gates:brand-names: no old name in the ${String(read)} file(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
