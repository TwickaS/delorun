/**
 * One source for Delorun's brand: no brand colour literal, no named typeface in a `font-family` and no second copy of the
 * hex mark in the Delorun packages and sites outside `delorun/packages/brand`. Colours, fonts and the mark are written
 * once, in the brand package; everything else reads its custom properties, its fonts or its `Mark`.
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/brand-drift.ts` exits 1 with one line per refusal. A file
 * that must keep a literal is listed with a reason in `brand-drift.allowlist.json`; the list only shrinks.
 *
 * @module @delorun/tools/checks/gates/brand-drift
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { git, repositoryRoot } from '../../git.ts'

/** The allowlist's repository-relative path. */
export const ALLOWLIST_PATH = 'delorun/apps/tools/src/checks/gates/brand-drift.allowlist.json'

const allowlistFile = z.object({
  entries: z.array(z.object({
    path: z.string(),
    rule: z.enum(['colour', 'font', 'mark']),
    reason: z.string().min(1),
  })),
})

/** The documented exceptions: files that keep a literal, the rule they are exempt from and why. */
export type Allowlist = z.infer<typeof allowlistFile>

/** The rules a line can break. */
export type Rule = 'colour' | 'font' | 'mark'

/** One refusal. */
export interface Finding {
  readonly rule: Rule
  readonly line: number
  readonly message: string
}

/** The brand colours, matched in any letter case. */
const COLOUR = /#(?:E5734A|B84A1B)\b/i
/** The start of the nut's path and of the hole's arc, which only a copy of the mark contains. */
const MARK = /M16 2\.5L27\.7|A6\.6 6\.6 0 1 0 9\.4 16/
/** A `font-family` declaration whose value names a typeface in quotes. */
const FONT = /font-family\s*:[^;{}]*['"]/i

/** The source trees the gate reads, including the sign-in page's assets; the brand package is the one place the literals live. */
const SCANNED = /^delorun\/(?:packages\/(?!brand\/)[^/]+\/src\/|apps\/(?:website|docs)\/(?:src|public|scripts)\/|packages\/site-design\/|packages\/home-auth\/assets\/)/
const EXTENSIONS = /\.(?:css|ts|tsx|svg|html)$/

/**
 * Whether the gate reads a path.
 * @param path - the repository-relative path.
 * @returns true for a source file of a Delorun package or site that is not the brand package.
 */
export function isScanned(path: string): boolean {
  return SCANNED.test(path) && EXTENSIONS.test(path)
}

/**
 * The refusals of one file's text.
 * @param text - the file's text.
 * @returns the lines that hold a brand colour, a named typeface in `font-family` or a copy of the mark.
 */
export function lineFindings(text: string): Finding[] {
  return text.split('\n').flatMap((line, index): Finding[] => {
    const found: Finding[] = []
    const at = index + 1
    if (COLOUR.test(line)) found.push({ rule: 'colour', line: at, message: 'a brand colour literal; read `--dl-accent` or `--dl-accent-text`, or import BRAND_COLOURS from @delorun/brand/tokens' })
    if (FONT.test(line)) found.push({ rule: 'font', line: at, message: 'a named typeface in font-family; use `var(--dl-font-sans)` or `var(--dl-font-mono)`' })
    if (MARK.test(line)) found.push({ rule: 'mark', line: at, message: 'a copy of the hex mark; import `Mark` or `MARK` from @delorun/brand/mark' })
    return found
  })
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
 * The refusals of one file after the allowlist.
 * @param path - the repository-relative path.
 * @param text - the file's text.
 * @param allowlist - the documented exceptions.
 * @returns one message per refusal; empty for a path the gate does not read.
 */
export function fileErrors(path: string, text: string, allowlist: Allowlist): string[] {
  if (!isScanned(path)) return []
  const exempt = new Set(allowlist.entries.filter(entry => entry.path === path).map(entry => entry.rule))
  return lineFindings(text).filter(finding => !exempt.has(finding.rule)).map(finding => `${path}:${String(finding.line)}: ${finding.message}`)
}

async function main(): Promise<number> {
  const root = repositoryRoot(process.cwd())
  const allowlist = readAllowlist(join(root, ALLOWLIST_PATH))
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(isScanned)
  const errors = paths.flatMap(path => fileErrors(path, readFileSync(join(root, path), 'utf8'), allowlist))
  for (const error of errors) console.error(`gates:brand-drift: ${error}`)
  if (errors.length > 0) {
    console.error('gates:brand-drift: refused; the brand package owns colours, typefaces and the mark')
    return 1
  }
  console.log(`gates:brand-drift: no brand literal outside @delorun/brand in the ${String(paths.length)} file(s) checked`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
