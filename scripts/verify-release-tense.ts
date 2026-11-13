/**
 * Reject release-status phrases in Delorun's English Markdown. Published text describes the released product in
 * the present tense; work that is not built belongs on the roadmap page, and dated history belongs in the plans
 * and the changelog fragments, which the gate skips.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** The one page that may describe future work. */
const roadmapPage = 'delo/docs/guide/roadmap.md'

/** Directory prefixes under `delo/` that record history or plans, not the released product. */
const excludedPrefixes = ['delo/docs/plans/', 'delo/changelog/'] as const

/** Release-status phrases, matched case-insensitively. */
export const RELEASE_STATUS_PHRASES: readonly RegExp[] = [
  /no release yet/iu,
  /first release/iu,
  /not available yet/iu,
  /coming soon/iu,
  /not yet released/iu,
  /has not been released/iu,
  /until (?:the )?(?:launch|release)\b/iu,
  /before (?:the )?(?:launch|public release|0\.1\.0)\b/iu,
]

/** One release-status phrase in a Markdown line. */
export interface ReleaseTenseViolation {
  /** Repository-relative file path. */
  file: string
  /** One-based source line. */
  line: number
  /** The matched phrase as written. */
  phrase: string
}

/**
 * Whether the gate checks a file.
 * @param file - repository-relative slash path.
 * @returns true for English Markdown under `delo/` outside the plans, the changelog and the roadmap page.
 */
export function isReleaseTenseFile(file: string): boolean {
  return file.startsWith('delo/')
    && file.endsWith('.md')
    && !file.endsWith('.zh.md')
    && file !== roadmapPage
    && !excludedPrefixes.some(prefix => file.startsWith(prefix))
}

/**
 * Locate release-status phrases in one file.
 * @param file - repository-relative slash path used in diagnostics and exclusions.
 * @param source - the file's Markdown.
 * @returns every matching phrase with its line, or none for a file the gate skips.
 */
export function findReleaseTenseViolations(file: string, source: string): ReleaseTenseViolation[] {
  if (!isReleaseTenseFile(file)) return []
  const violations: ReleaseTenseViolation[] = []
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const found = RELEASE_STATUS_PHRASES.flatMap(pattern =>
      [...line.matchAll(new RegExp(pattern, 'giu'))].map(match => ({ at: match.index, phrase: match[0] })))
    for (const { phrase } of found.toSorted((left, right) => left.at - right.at)) {
      violations.push({ file, line: index + 1, phrase })
    }
  }
  return violations
}

function trackedMarkdown(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'delo'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter(isReleaseTenseFile)
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const files = trackedMarkdown(root)
  const violations = files.flatMap(file => findReleaseTenseViolations(file, readFileSync(resolve(root, file), 'utf8')))
  if (violations.length === 0) {
    console.log(`verify-release-tense: ${String(files.length)} file(s) checked, no release-status phrases.`)
  } else {
    console.error('verify-release-tense: release-status phrases found; describe the released product in the present tense, and move future work to delo/docs/guide/roadmap.md:')
    for (const violation of violations) console.error(`  ${violation.file}:${String(violation.line)}: "${violation.phrase}"`)
    process.exitCode = 1
  }
}
