/**
 * The public-readiness patterns: text that names one person's machine or account, or a private planning label, and
 * must not reach a public repository. The generic classes are patterns; the particular names (a machine, a tailnet,
 * a user name) are not written in this repository: the caller reads them from a terms file kept outside it, one
 * `kind<TAB>value` per line, so the repository never holds the strings it forbids.
 *
 * @module @delorun/tools/history/public-readiness
 */
import { readFileSync } from 'node:fs'

/** One thing that matched, without the matched text. */
export interface ReadinessKind {
  /** What the match is. */
  readonly kind: string
  /** The matched text, for the replacement map only; reports never print it. */
  readonly value: string
}

/** A literal term read from the terms file. */
export interface ReadinessTerm {
  /** What the term is, such as `machine name`. */
  readonly kind: string
  /** The exact text, compared case-insensitively. */
  readonly value: string
}

/** Home-directory owners that are examples, not people. */
const NEUTRAL_OWNERS: ReadonlySet<string> = new Set([
  'user', 'users', 'runner', 'example', 'name', 'username', 'you', 'me', 'someone', 'dev', 'node', 'ubuntu', 'vagrant', 'app', 'public', 'default', 'home',
  'alice', 'bob', 'owner', 'builder', 'test', 'tester', 'ci', 'build', 'root', 'agent', 'a', 'b', 'x', 'u', 'foo', 'bar', 'person', 'who', 'dsh', 'delorun',
])

/** Generic classes of private text; each pattern has one capturing group for the identifying part. */
const GENERIC: readonly { readonly kind: string, readonly pattern: RegExp, readonly neutral?: ReadonlySet<string> }[] = [
  { kind: 'Linux home path', pattern: /(?<![\w.:/-])\/home\/([A-Za-z][\w-]*)/gu, neutral: NEUTRAL_OWNERS },
  { kind: 'macOS home path', pattern: /(?<![\w.:/-])\/Users\/([A-Za-z][\w-]*)/gu, neutral: NEUTRAL_OWNERS },
  { kind: 'WSL Windows home path', pattern: /\/mnt\/[a-z]\/Users\/([A-Za-z][\w.-]*)/gu, neutral: NEUTRAL_OWNERS },
  { kind: 'Windows home path', pattern: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z][\w.-]*)/gu, neutral: NEUTRAL_OWNERS },
  { kind: 'planning decision number', pattern: /(?<![-\w.])(A[0-9]{2,3}[a-z]?)(?![-\w])/gu },
  { kind: 'planning strategy number', pattern: /(?<![-\w.])((?:ST|PC)[0-9]{1,2})(?![-\w])/gu },
  { kind: 'planning wave', pattern: /\b([Ww]ave ?[0-9])\b/gu },
  { kind: 'planning document path', pattern: /(docs\/plans\/[\w./*-]*)/gu },
  { kind: 'planning heading', pattern: /([Ww]hat is built so far)/gu },
  { kind: 'planning name', pattern: /\b(V4\.5)\b/gu },
]

/** The public email domains and addresses a commit identity may carry. */
const PUBLIC_EMAIL = /@delorun\.com$|^noreply@anthropic\.com$|@users\.noreply\.github\.com$/u

/**
 * Read a terms file.
 * @param path - a file of `kind<TAB>value` lines; blank lines and lines starting with `#` are skipped.
 * @returns the terms.
 * @throws Error when a line has no tab or an empty value.
 */
export function readTerms(path: string): ReadinessTerm[] {
  const terms: ReadinessTerm[] = []
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const tab = line.indexOf('\t')
    if (tab < 1 || tab === line.length - 1) throw new Error(`${path}:${String(index + 1)}: a term is kind<TAB>value`)
    terms.push({ kind: line.slice(0, tab), value: line.slice(tab + 1) })
  }
  return terms
}

/**
 * Find what one line of text names.
 * @param text - one line.
 * @param terms - the literal terms to look for as well.
 * @returns each match with its kind; the same text matched twice is listed twice.
 */
export function readinessMatches(text: string, terms: readonly ReadinessTerm[] = []): ReadinessKind[] {
  const found: ReadinessKind[] = []
  for (const generic of GENERIC) {
    for (const match of text.matchAll(generic.pattern)) {
      const identifying = match[1] ?? ''
      if (generic.neutral?.has(identifying.toLowerCase())) continue
      found.push({ kind: generic.kind, value: match[0] })
    }
  }
  const lower = text.toLowerCase()
  for (const term of terms) {
    const needle = term.value.toLowerCase()
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) found.push({ kind: term.kind, value: text.slice(at, at + needle.length) })
  }
  return found
}

/**
 * Find a commit identity that is not a public one.
 * @param identity - `Name <email>`.
 * @returns the kind of the problem, or undefined when the address is a public one.
 */
export function identityProblem(identity: { readonly name: string, readonly email: string }): string | undefined {
  return PUBLIC_EMAIL.test(identity.email) ? undefined : 'non-public email address'
}
