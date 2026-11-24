/**
 * The design-system gate: a Delorun surface renders every primitive the brand package replaces with the brand
 * component, and imports no upstream primitive that the brand package replaces. It reads the `src` directories of the
 * packages under `delorun/packages`, except the brand package's own sources, and the upstream files
 * `delorun/upstream-patches.json` lists, because Delorun has taken responsibility for those. It refuses an import of
 * `Button`, `Modal`, `Pill` or `SegmentedTabs` from `@deepseek-ai/dsh-client-ui-primitives`, and a raw `<a href>` in a
 * Delorun client source. Tests and scripts are not shipped surfaces and are not read.
 *
 * The brand package is exempt because `delorun/packages/brand/src/upstream.ts` re-exports upstream's `Button`,
 * `Input`, `Modal`, `Pill` and `Switch` as `#upstream`, the seam every brand component composes through. The
 * primitives package's own sources are exempt because they are where those primitives are defined.
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/design-system.ts` exits 1 with one line per refusal. A
 * file that must keep an upstream primitive is listed with a reason in `design-system.allowlist.json`; the list is a
 * debt register that only shrinks, and each migration deletes the entries for the files it migrates.
 *
 * @module @delorun/tools/checks/gates/design-system
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { git, repositoryRoot } from '../../git.ts'

/** The allowlist's repository-relative path. */
export const ALLOWLIST_PATH = 'delorun/apps/tools/src/checks/gates/design-system.allowlist.json'

/** The divergence ledger's repository-relative path, whose listed files the gate reads. */
export const LEDGER_PATH = 'delorun/upstream-patches.json'

const allowlistFile = z.object({
  entries: z.array(z.object({
    path: z.string(),
    rule: z.enum(['button', 'modal', 'pill', 'tabs', 'link']),
    reason: z.string().min(1),
  })),
})

/** The documented exceptions: files that keep an upstream primitive, the rule they are exempt from and why. */
export type Allowlist = z.infer<typeof allowlistFile>

/** The rules a file can break. */
export type Rule = 'button' | 'modal' | 'pill' | 'tabs' | 'link'

/** One refusal. */
export interface Finding {
  /** The rule the line breaks. */
  readonly rule: Rule
  /** The 1-based line the offending name or element sits on. */
  readonly line: number
  /** The refusal as it prints: the rule, then what to import instead. */
  readonly message: string
}

/** The upstream package whose primitives the brand package replaces. */
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** An import or re-export of named bindings from the primitives package, its braces allowed to span lines. */
const PRIMITIVES_IMPORT = new RegExp(`^[ \\t]*(?:import|export)\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${PRIMITIVES.replaceAll('/', '\\/')}['"]`, 'gm')

/** The upstream names the brand package replaces, with the rule each breaks and what to import instead. */
const REPLACED: Readonly<Record<string, { readonly rule: Rule, readonly instead: string }>> = {
  Button: { rule: 'button', instead: 'import Button from @delorun/brand' },
  Modal: { rule: 'modal', instead: 'import Dialog from @delorun/brand' },
  Pill: { rule: 'pill', instead: 'import Pill from @delorun/brand' },
  SegmentedTabs: { rule: 'tabs', instead: 'import TabList and TabPanel from @delorun/brand' },
}

/** A raw anchor that carries an `href`, which the brand's `Link` replaces. */
const RAW_ANCHOR = /<a(?=[\s>])[^>]*\bhref\b/g

/** The source files the gate reads; a stylesheet or an asset holds no import. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** Specs, fixtures and build scripts: not shipped surfaces, so not read. */
const TEST_OR_SCRIPT = /(?:^|\/)(?:tests|scripts|__tests__)\/|\.(?:spec|test|e2e)\.[cm]?[jt]sx?$/

/** Delorun's own surfaces: the packages under `delorun/packages`, except the brand package. */
const DELORUN_SOURCE = /^delorun\/packages\/(?!brand\/)[^/]+\/src\//

/** The primitives package's own sources, where the replaced primitives are defined. */
const PRIMITIVES_SOURCE = /^packages\/client\/ui-primitives\/src\//

/**
 * Whether the gate reads a path.
 * @param path - the repository-relative path.
 * @param ledger - the paths `delorun/upstream-patches.json` lists; empty reads Delorun's own surfaces only.
 * @returns true for a source file of a Delorun package other than the brand package, or for a ledger-listed upstream source file.
 */
export function isScanned(path: string, ledger: ReadonlySet<string> = new Set()): boolean {
  if (!SOURCE.test(path) || TEST_OR_SCRIPT.test(path) || PRIMITIVES_SOURCE.test(path)) return false
  return DELORUN_SOURCE.test(path) || ledger.has(path)
}

/**
 * The 1-based line an offset sits on.
 * @param text - the file's text.
 * @param offset - the offset into it.
 * @returns the line number.
 */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/**
 * The refusals of one file's text.
 * @param text - the file's text.
 * @param link - whether a raw `<a href>` is refused too, as it is in a Delorun client source and not in an upstream file.
 * @returns the lines that import a replaced primitive or, when `link` is set, hold a raw anchor, in line order.
 */
export function lineFindings(text: string, link = false): Finding[] {
  const found: Finding[] = []
  for (const match of text.matchAll(PRIMITIVES_IMPORT)) {
    const names = match[1] ?? ''
    const namesStart = (match.index ?? 0) + match[0].indexOf('{') + 1
    let cursor = 0
    for (const part of names.split(',')) {
      const at = names.indexOf(part, cursor)
      cursor = at + part.length
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
      const replaced = REPLACED[name]
      if (replaced === undefined) continue
      const offset = namesStart + at + (part.length - part.trimStart().length)
      found.push({ rule: replaced.rule, line: lineAt(text, offset), message: `${replaced.rule}: ${replaced.instead}` })
    }
  }
  if (link) {
    for (const match of text.matchAll(RAW_ANCHOR)) {
      found.push({ rule: 'link', line: lineAt(text, match.index ?? 0), message: 'link: import Link from @delorun/brand' })
    }
  }
  return found.sort((left, right) => left.line - right.line)
}

/**
 * Read the allowlist.
 * @param path - the absolute path of the allowlist file.
 * @returns the documented exceptions.
 * @throws Error when the file is not JSON or does not match the schema.
 */
export function readAllowlist(path: string): Allowlist {
  return allowlistFile.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Read the paths the divergence ledger lists.
 * @param root - the repository root.
 * @returns the repository-relative paths of the ledger's patches.
 * @throws Error when the ledger is not JSON or holds no `patches` array of paths.
 */
export function readLedgerPaths(root: string): Set<string> {
  const ledger = z.object({ patches: z.array(z.object({ path: z.string() })) }).parse(JSON.parse(readFileSync(join(root, LEDGER_PATH), 'utf8')))
  return new Set(ledger.patches.map(patch => patch.path))
}

/**
 * The refusals of one file after the allowlist.
 * @param path - the repository-relative path.
 * @param text - the file's text.
 * @param allowlist - the documented exceptions.
 * @param ledger - the paths `delorun/upstream-patches.json` lists; empty reads Delorun's own surfaces only.
 * @returns one message per refusal; empty for a path the gate does not read.
 */
export function fileErrors(path: string, text: string, allowlist: Allowlist, ledger: ReadonlySet<string> = new Set()): string[] {
  if (!isScanned(path, ledger)) return []
  const exempt = new Set<Rule>(allowlist.entries.filter(entry => entry.path === path).map(entry => entry.rule))
  return lineFindings(text, DELORUN_SOURCE.test(path))
    .filter(finding => !exempt.has(finding.rule))
    .map(finding => `${path}:${String(finding.line)}: ${finding.message}`)
}

async function main(): Promise<number> {
  const root = repositoryRoot(process.cwd())
  const allowlist = readAllowlist(join(root, ALLOWLIST_PATH))
  const ledger = readLedgerPaths(root)
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(path => isScanned(path, ledger))
  const errors = paths.flatMap(path => fileErrors(path, readFileSync(join(root, path), 'utf8'), allowlist, ledger))
  for (const error of errors) console.error(`gates:design-system: ${error}`)
  if (errors.length > 0) {
    console.error('gates:design-system: refused; a Delorun surface imports an upstream primitive that @delorun/brand replaces')
    return 1
  }
  console.log(`gates:design-system: no upstream primitive that @delorun/brand replaces in the ${String(paths.length)} file(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
