/**
 * Reject US spellings in Delorun-owned English prose. Documentation under `delorun/` uses British English;
 * upstream's files, code, identifiers and quoted program output keep their spelling. The word list is curated:
 * only pairs with no technical ambiguity appear (`license`, `practice`, `program`, `dialog` and `artifact`
 * are absent because they are terms of art or valid in both spellings).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { isEntryPoint, trackedDelorunFiles } from './tracked-delorun-files.ts'

const root = resolve(import.meta.dirname, '..')

/** A line carrying this marker quotes program output and keeps its spelling. */
export const US_SPELLING_MARKER = '<!-- us-spelling: quoted output -->'

/** Directory prefixes under `delorun/` that record dated plans, not current prose. */
const excludedPrefixes = ['delorun/docs/plans/'] as const

/** Path segments that mark test inputs, whose text is data and not prose. */
const excludedSegments = ['/tests/', '/fixtures/', '/node_modules/'] as const

/** `-ize` stems; each takes the endings in {@link IZE_ENDINGS} and becomes the `-ise` form. */
const IZE_STEMS = [
  'authoriz', 'unauthoriz', 'analyz', 'capitaliz', 'categoriz', 'centraliz', 'characteriz', 'containeriz', 'customiz',
  'deserializ', 'emphasiz', 'finaliz', 'generaliz', 'initializ', 'reinitializ', 'uninitializ', 'localiz',
  'materializ', 'maximiz', 'memoiz', 'minimiz', 'normaliz', 'optimiz', 'organiz', 'reorganiz', 'parameteriz',
  'personaliz', 'prioritiz', 'randomiz', 'realiz', 'recogniz', 'sanitiz', 'serializ', 'specializ', 'stabiliz',
  'standardiz', 'summariz', 'synchroniz', 'tokeniz', 'utiliz', 'virtualiz', 'visualiz',
] as const

const IZE_ENDINGS = ['e', 'es', 'ed', 'ing', 'ation', 'ations', 'ational', 'er', 'ers', 'able'] as const

/** `-or` stems that become `-our` with the listed endings. */
const OR_STEMS: ReadonlyArray<readonly [stem: string, endings: readonly string[]]> = [
  ['color', ['', 's', 'ed', 'ing', 'ful', 'less']],
  ['behavior', ['', 's', 'al', 'ally']],
  ['favor', ['', 's', 'ed', 'ing', 'able', 'ite', 'ites']],
  ['honor', ['', 's', 'ed', 'ing', 'able']],
  ['labor', ['', 's', 'ed', 'ing']],
  ['neighbor', ['', 's', 'ed', 'ing', 'hood', 'hoods']],
  ['flavor', ['', 's', 'ed', 'ing']],
  ['harbor', ['', 's', 'ed', 'ing']],
  ['humor', ['', 's', 'ed']],
]

/** Pairs that follow no pattern, including single-`l` verbs that British English doubles. */
const IRREGULAR: ReadonlyArray<readonly [string, string]> = [
  ['canceled', 'cancelled'], ['canceling', 'cancelling'], ['cancelation', 'cancellation'], ['cancelations', 'cancellations'],
  ['labeled', 'labelled'], ['labeling', 'labelling'], ['modeled', 'modelled'], ['modeling', 'modelling'],
  ['traveled', 'travelled'], ['traveling', 'travelling'], ['traveler', 'traveller'], ['travelers', 'travellers'],
  ['signaled', 'signalled'], ['signaling', 'signalling'], ['tunneled', 'tunnelled'], ['tunneling', 'tunnelling'],
  ['channeled', 'channelled'], ['channeling', 'channelling'],
  ['fulfill', 'fulfil'], ['fulfills', 'fulfils'], ['fulfillment', 'fulfilment'],
  ['enroll', 'enrol'], ['enrolls', 'enrols'], ['enrollment', 'enrolment'], ['enrollments', 'enrolments'],
  ['skillful', 'skilful'], ['willful', 'wilful'],
  ['center', 'centre'], ['centers', 'centres'], ['centered', 'centred'], ['centering', 'centring'],
  ['catalog', 'catalogue'], ['catalogs', 'catalogues'],
  ['gray', 'grey'], ['grays', 'greys'],
  ['defense', 'defence'], ['defenses', 'defences'], ['offense', 'offence'], ['offenses', 'offences'], ['pretense', 'pretence'],
]

function buildPairs(): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>()
  for (const stem of IZE_STEMS) {
    for (const ending of IZE_ENDINGS) pairs.set(`${stem}${ending}`, `${stem.slice(0, -1)}s${ending}`)
  }
  for (const [stem, endings] of OR_STEMS) {
    for (const ending of endings) pairs.set(`${stem}${ending}`, `${stem.slice(0, -2)}our${ending}`)
  }
  for (const [us, gb] of IRREGULAR) pairs.set(us, gb)
  return pairs
}

/** Lower-case US spelling to its British spelling. */
export const US_TO_GB: ReadonlyMap<string, string> = buildPairs()

/** One US spelling in a line of prose. */
export interface BritishEnglishViolation {
  /** Repository-relative file path; empty for source passed without a file. */
  file: string
  /** One-based source line. */
  line: number
  /** The matched word as written. */
  word: string
  /** The British spelling, in the case of the matched word. */
  suggestion: string
}

/**
 * Whether the gate checks a file.
 * @param file - repository-relative slash path.
 * @returns true for English Markdown under `delorun/` outside the plans and test inputs.
 */
export function isBritishEnglishFile(file: string): boolean {
  return file.startsWith('delorun/')
    && file.endsWith('.md')
    && !file.endsWith('.zh.md')
    && !excludedPrefixes.some(prefix => file.startsWith(prefix))
    && !excludedSegments.some(segment => file.includes(segment))
}

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase()
  if (original.charAt(0) === original.charAt(0).toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  return replacement
}

/** Blank out spans whose text is not prose, keeping offsets so columns stay meaningful. */
function blankNonProse(line: string): string {
  const blank = (text: string): string => ' '.repeat(text.length)
  return line
    .replace(/(`+)[^`]*?\1/gu, blank)
    .replace(/\]\([^)]*\)/gu, blank)
    .replace(/^\s*\[[^\]]+\]:.*$/u, blank)
    .replace(/<[^>]*>/gu, blank)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, blank)
}

const WORD = /[A-Za-z]+/gu

function isPathLike(line: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : line.charAt(start - 1)
  const after = line.charAt(end)
  if ('_/\\@$#'.includes(before) && before !== '') return true
  if ('_/\\@'.includes(after) && after !== '') return true
  return after === '.' && /[A-Za-z0-9]/u.test(line.charAt(end + 1)) || before === '.' && /[A-Za-z0-9]/u.test(line.charAt(start - 2))
}

/** Source roots whose string literals are user-visible Delorun text. */
const SOURCE_ROOT = /^delorun\/(?:apps\/(?:cli|npm-launcher|install)|packages\/[^/]+)\/src\//u

/**
 * Whether the gate checks a file's string literals.
 * @param file - repository-relative slash path.
 * @returns true for non-test TypeScript under the Delorun CLI, launcher, installer and package `src` trees.
 */
export function isBritishEnglishSourceFile(file: string): boolean {
  return SOURCE_ROOT.test(file)
    && /\.tsx?$/u.test(file)
    && !/\.(?:spec|test)\.tsx?$/u.test(file)
    && !file.endsWith('.d.ts')
    && !excludedSegments.some(segment => file.includes(segment))
}

/**
 * Whole string literals that are wire values or HTTP header names and keep their spelling: the `catalog` adapter
 * kind and the `authorization` header and key parts. A literal that only contains one of these words is still checked.
 */
export const SOURCE_ALLOWLIST: ReadonlySet<string> = new Set(['catalog', 'authorization', 'proxy-authorization'])

/** Marker on the same line as a literal that quotes upstream or wire text and keeps its spelling. */
export const SOURCE_US_MARKER = 'us-spelling: quoted output'

/** CSS identifiers such as `color-mix` and `--focus-ring-color` name properties and functions, so they keep their spelling. */
const CSS_COLOR_IDENTIFIER = /[\w-]*-colors?\b[\w-]*|\bcolors?-[\w-]+/giu

function isNonProseLiteral(node: ts.Node): boolean {
  const parent = node.parent
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true
  if (ts.isLiteralTypeNode(parent) || ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true
  if (ts.isCaseClause(parent)) return true
  if (ts.isJsxAttribute(parent) && parent.name.getText() === 'type') return true
  return ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
}

/**
 * Locate US spellings in the string literals of a TypeScript source file.
 * @param source - the TypeScript or TSX text.
 * @param file - repository-relative path naming the diagnostics.
 * @returns violations in string, template and JSX text, skipping module specifiers, property names, type literals,
 * strict comparisons, case clauses, JSX `type` attributes, CSS `color-` identifiers, literals in {@link SOURCE_ALLOWLIST}
 * and lines carrying {@link SOURCE_US_MARKER}.
 */
export function findUsSpellingsInSource(source: string, file = ''): BritishEnglishViolation[] {
  const sourceFile = ts.createSourceFile(file || 'source.ts', source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines = source.split(/\r?\n/u)
  const violations: BritishEnglishViolation[] = []
  const visit = (node: ts.Node): void => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)
    if (literal && !isNonProseLiteral(node)) {
      const start = node.getStart(sourceFile)
      const base = sourceFile.getLineAndCharacterOfPosition(start).line
      const text = node.getText(sourceFile).replace(CSS_COLOR_IDENTIFIER, match => ' '.repeat(match.length))
      for (const found of SOURCE_ALLOWLIST.has(text.slice(1, -1)) ? [] : findUsSpellings(text, { file, markdown: false })) {
        const line = base + found.line
        if (lines[line - 1]?.includes(SOURCE_US_MARKER)) continue
        violations.push({ ...found, line })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

/**
 * Locate US spellings in prose.
 * @param source - the text to scan.
 * @param options - `file` names the diagnostics; `markdown` (default true) skips fenced blocks, inline code, link targets, HTML and URLs.
 * @returns every curated US spelling with its line and British replacement, skipping lines with {@link US_SPELLING_MARKER}.
 */
export function findUsSpellings(source: string, options: { file?: string; markdown?: boolean } = {}): BritishEnglishViolation[] {
  const { file = '', markdown = true } = options
  const violations: BritishEnglishViolation[] = []
  let fence: string | undefined
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    if (markdown) {
      const opener = /^\s*(`{3,}|~{3,})/u.exec(raw)?.[1]
      if (fence === undefined && opener !== undefined) {
        fence = opener
        continue
      }
      if (fence !== undefined) {
        if (opener !== undefined && opener.startsWith(fence.charAt(0)) && opener.length >= fence.length) fence = undefined
        continue
      }
    }
    if (raw.includes(US_SPELLING_MARKER)) continue
    const line = markdown ? blankNonProse(raw) : raw
    for (const match of line.matchAll(WORD)) {
      const word = match[0]
      const suggestion = US_TO_GB.get(word.toLowerCase())
      if (suggestion === undefined || isPathLike(line, match.index, match.index + word.length)) continue
      violations.push({ file, line: index + 1, word, suggestion: matchCase(word, suggestion) })
    }
  }
  return violations
}

if (isEntryPoint(import.meta.url)) {
  const files = trackedDelorunFiles(root, isBritishEnglishFile)
  const sources = trackedDelorunFiles(root, isBritishEnglishSourceFile)
  const violations = [
    ...files.flatMap(file => findUsSpellings(readFileSync(resolve(root, file), 'utf8'), { file })),
    ...sources.flatMap(file => findUsSpellingsInSource(readFileSync(resolve(root, file), 'utf8'), file)),
  ]
  if (violations.length === 0) {
    console.log(`verify-british-english: ${String(files.length)} prose file(s) and ${String(sources.length)} source file(s) checked, no US spellings.`)
  } else {
    console.error(`verify-british-english: Delorun prose uses British English; use the suggestion, or mark a Markdown line quoting program output with ${US_SPELLING_MARKER} (source: a // ${SOURCE_US_MARKER} comment):`)
    for (const violation of violations) console.error(`  ${violation.file}:${String(violation.line)}: "${violation.word}" -> "${violation.suggestion}"`)
    process.exitCode = 1
  }
}
