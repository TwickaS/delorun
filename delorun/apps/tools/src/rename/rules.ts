/**
 * The rules of the Delo to Delorun rename, as data: exception guards that mark text the rename must leave alone,
 * and an ordered list of replacements. {@link applyRules} runs them over one file's text; {@link renamePath} and
 * {@link planPathRenames} apply the same rules to path names.
 *
 * @module @delo/tools/rename/rules
 */

/** Which paths a rule reaches. A path must match `include` (when given) and must not match `exclude`. */
export interface PathFilter {
  /** When given, only paths matching this expression are reached. */
  readonly include?: RegExp
  /** Paths matching this expression are never reached. */
  readonly exclude?: RegExp
}

/** Text the rename keeps as it is: a match is never edited, and no replacement may overlap it. */
export interface GuardRule {
  /** A stable identifier, used in reports. */
  readonly id: string
  /** What the guard keeps, and why. */
  readonly description: string
  /** The text to keep; matched globally. */
  readonly pattern: RegExp
}

/** One replacement. */
export interface ReplaceRule extends PathFilter {
  /** A stable identifier, used in reports. */
  readonly id: string
  /** What the rule renames. */
  readonly description: string
  /** The text to replace; matched globally, with no capture groups. */
  readonly pattern: RegExp
  /** The replacement text. */
  readonly replacement: string
}

/** The text before an identifier word: not preceded by a letter, except after a `\n`, `\r` or `\t` escape in source. */
const WORD_START = String.raw`(?:(?<![A-Za-z])|(?<=\\[nrt]))`

/**
 * The exception guards. The domain `delo.run`, the reverse-domain labels under it, the GitHub organisation and its
 * repositories, the container registry organisation, and the organisation's name "Delo Run" are not renamed, and
 * neither is an opaque run of 40 or more base64 characters.
 */
export const GUARDS: readonly GuardRule[] = [
  { id: 'domain', description: 'the domain delo.run and every name under it (relay addresses)', pattern: /delo\.run\b/giu },
  { id: 'reverse-domain', description: 'reverse-domain labels under delo.run (run.delo.*)', pattern: /\brun\.delo\./gu },
  { id: 'github-organisation', description: 'the GitHub organisation Delo-Run and its repository paths', pattern: /\bDelo-Run(?:\/[\w.-]+)?/gu },
  { id: 'registry-organisation', description: 'the container registry organisation ghcr.io/delo-run', pattern: /ghcr\.io\/delo-run\b/gu },
  { id: 'organisation-slug', description: 'heading anchors and consistency-record keys slugged from "Delo Run ..." headings', pattern: /(?<![A-Za-z])delo-run-(?:mailbox|issuer|the-project|can-and-cannot-do)\b/gu },
  { id: 'organisation-name', description: 'the maintainer organisation\'s name "Delo Run"', pattern: /\bDelo Run\b/gu },
  { id: 'opaque-run', description: 'a run of 40 or more base64 characters without a slash (digests, keys), which may contain the letters by chance', pattern: /[A-Za-z0-9+]{40,}={0,2}/gu },
]

/**
 * The replacements, applied in order. Every rule skips text a guard covers. After the last rule no `delo` word
 * remains outside a guard, and a second pass changes nothing because each replacement ends in `run` or `RUN`,
 * which the patterns' lookaheads refuse.
 */
export const RULES: readonly ReplaceRule[] = [
  {
    id: 'run-suffixed-constant',
    description: 'upper-case names that spell the old brand with a RUN word (DELO_RUN_CALLBACK_PATH)',
    pattern: /(?<![A-Za-z])DELO_RUN_/gu,
    replacement: 'DELORUN_',
  },
  {
    id: 'run-suffixed-identifier',
    description: 'camelCase identifiers that spell the old brand with a Run word (deloRunKeyOverlapMs), but not deloRuntime',
    pattern: /(?<![A-Za-z])deloRun(?![a-z])/gu,
    replacement: 'delorun',
  },
  {
    id: 'checks-slot-name',
    description: 'the check runner\'s slot files under the temporary directory (delo-run-checks-*)',
    pattern: /(?<![A-Za-z])delo-run-checks\b/gu,
    replacement: 'delorun-checks',
  },
  {
    id: 'heading-anchor-possessive',
    description: 'the anchor of a heading with a possessive ("Delo\'s ..." slugs to "delos-...")',
    pattern: /(?<![A-Za-z])delos(?=-)/gu,
    replacement: 'deloruns',
  },
  {
    id: 'provider-id',
    description: 'the OIDC provider id delo-run in the callback route',
    pattern: /(?<=callback\/)delo-run\b/gu,
    replacement: 'delorun',
  },
  {
    id: 'lowercase',
    description: 'the lowercase word delo: scope @delo/, home .delo, file and directory names, config keys, labels, identifiers such as deloHome',
    pattern: new RegExp(`${WORD_START}delo(?![a-z])`, 'gu'),
    replacement: 'delorun',
  },
  {
    id: 'capitalised-identifier',
    description: 'Delo inside a PascalCase or camelCase identifier (DeloNotice, isDelo), in every file including Chinese pages',
    pattern: /(?<=[a-z0-9])Delo(?![a-z])|Delo(?=[A-Z0-9_])/gu,
    replacement: 'Delorun',
  },
  {
    id: 'capitalised',
    description: 'the capitalised product name Delo in English prose (Delo\'s); Chinese pages keep their prose, only identifiers and fenced blocks change',
    pattern: /Delo(?![a-z])/gu,
    replacement: 'Delorun',
    exclude: /\.zh\.md$/u,
  },
  {
    id: 'uppercase',
    description: 'the uppercase word DELO in environment variables (DELO_HOME)',
    pattern: /(?<![A-Za-z])DELO(?![A-Za-z])/gu,
    replacement: 'DELORUN',
  },
]

/**
 * Paths whose content is never edited: the lockfile (regenerated by `pnpm install`), signed release material (`delo/release/`: the production key record `delo.production-keys/1` and the allowed signers), recorded sessions (but not
 * the `snapshot.yml` that names the scenario, which must match its renamed directory), frozen archived Agent Notes,
 * and this rename tooling, whose patterns and test strings spell the old name.
 */
export const CONTENT_SKIP = /^(?:pnpm-lock\.yaml|snapshots\/(?![^]*\/snapshot\.yml$)|delo(?:run)?\/apps\/tools\/(?:src|tests)\/rename\/|\.agents\/notes\/archived\/|delo(?:run)?\/release\/)/u

/**
 * Paths whose names are never changed: archived Agent Notes are frozen (their content is skipped for the same
 * reason), and the rename tooling keeps its own names.
 */
export const PATH_SKIP = /^(?:\.agents\/notes\/archived\/)/u

/**
 * Whether a rule reaches a path.
 * @param rule - the rule, or any value carrying a path filter.
 * @param path - the repository-relative path.
 * @returns true when the path passes the include and exclude expressions.
 */
export function appliesTo(rule: PathFilter, path: string): boolean {
  if (rule.include !== undefined && !rule.include.test(path)) return false
  return rule.exclude === undefined || !rule.exclude.test(path)
}

/** A half-open range of the text. */
interface Range {
  readonly start: number
  readonly end: number
}

function guardRanges(text: string, guards: readonly GuardRule[]): Range[] {
  const ranges: Range[] = []
  for (const guard of guards) {
    for (const match of text.matchAll(guard.pattern)) ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/** The fenced code blocks of a Markdown text; an unterminated fence runs to the end of the text. */
function fencedRanges(text: string): Range[] {
  const ranges: Range[] = []
  for (const match of text.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gmu)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/** Count the guard matches in a text that still carry the old name, by guard id. */
function keptByGuard(text: string, guards: readonly GuardRule[]): Map<string, number> {
  const kept = new Map<string, number>()
  for (const guard of guards) {
    for (const match of text.matchAll(guard.pattern)) {
      if (/delo/iu.test(match[0])) kept.set(guard.id, (kept.get(guard.id) ?? 0) + 1)
    }
  }
  return kept
}

/** The outcome of running the rules over one text. */
export interface Applied {
  /** The text after every rule. */
  readonly text: string
  /** Replacements made, by rule id; rules that made none are absent. */
  readonly replaced: ReadonlyMap<string, number>
  /** Guard matches in the result that still carry the old name, by guard id; guards with none are absent. */
  readonly guarded: ReadonlyMap<string, number>
}

/**
 * Run the guards and replacements over a text.
 * @param text - the text of one file or one path.
 * @param path - the repository-relative path, for the rules' path filters.
 * @param rules - the replacements; defaults to {@link RULES}.
 * @param guards - the exception guards; defaults to {@link GUARDS}.
 * @returns the edited text with per-rule replacement counts and per-guard counts.
 */
export function applyRules(text: string, path: string, rules: readonly ReplaceRule[] = RULES, guards: readonly GuardRule[] = GUARDS): Applied {
  const replaced = new Map<string, number>()
  let current = text
  for (const rule of rules) {
    // A Chinese page keeps its prose but shares code and output blocks with its English page, so a rule that
    // skips Chinese pages still reaches their fenced blocks.
    const fencedOnly = !appliesTo(rule, path) && /\.zh\.md$/u.test(path) && appliesTo(rule.include === undefined ? {} : { include: rule.include }, path)
    if (!fencedOnly && !appliesTo(rule, path)) continue
    const ranges = guardRanges(current, guards)
    const fenced = fencedOnly ? fencedRanges(current) : []
    current = current.replace(rule.pattern, (match, offset: number) => {
      const end = offset + match.length
      if (ranges.some(range => offset < range.end && end > range.start)) return match
      if (fencedOnly && !fenced.some(range => offset >= range.start && end <= range.end)) return match
      replaced.set(rule.id, (replaced.get(rule.id) ?? 0) + 1)
      return rule.replacement
    })
  }
  return { text: current, replaced, guarded: keptByGuard(current, guards) }
}

/**
 * The new name of a repository-relative path.
 * @param path - a file or directory path.
 * @returns the path with the rules applied to every segment.
 */
export function renamePath(path: string): string {
  return applyRules(path, path).text
}

/** One rename for `git mv`. */
export interface PathRename {
  /** The current path. */
  readonly from: string
  /** The path after the rename; differs from `from` only in its last segment. */
  readonly to: string
}

/**
 * The renames that carry every tracked path to its new name, one segment at a time: each entry changes only the
 * last segment of a file or directory, deepest first, so the parents of an entry still have their old names when
 * it runs and the top-level `delo` directory moves last.
 * @param files - the tracked file paths.
 * @returns the renames, in the order to run them.
 */
export function planPathRenames(files: readonly string[]): PathRename[] {
  const paths = new Set<string>()
  for (const file of files) {
    const segments = file.split('/')
    for (let length = 1; length <= segments.length; length += 1) paths.add(segments.slice(0, length).join('/'))
  }
  const renames: PathRename[] = []
  for (const from of paths) {
    if (PATH_SKIP.test(from)) continue
    const slash = from.lastIndexOf('/')
    const parent = from.slice(0, slash + 1)
    const name = from.slice(slash + 1)
    const renamed = renamePath(name)
    if (renamed !== name) renames.push({ from, to: `${parent}${renamed}` })
  }
  return renames.sort((left, right) => right.from.split('/').length - left.from.split('/').length || left.from.localeCompare(right.from))
}
