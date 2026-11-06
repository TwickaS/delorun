/**
 * Changelog fragments: one Markdown file per perceptible change, with front matter that names its section and a body of
 * bullet lines. The format is documented in `delo/changelog/unreleased/README.md`.
 *
 * @module @delo/release/changelog/fragment
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FRAGMENTS } from '@delo/tools/src/check-commits.ts'
import { isFragmentPath } from './paths.ts'

/** The sections of the release notes, in the order they print. */
export const SECTIONS = ['Security', 'Added', 'Changed', 'Fixed', 'Removed', 'From upstream'] as const

/** One release-notes section. */
export type Section = (typeof SECTIONS)[number]

/** One parsed fragment. */
export interface Fragment {
  /** The repository-relative path of the fragment file. */
  readonly path: string
  /** The section the front matter names. */
  readonly section: Section
  /** The body's bullet lines, each starting with `- `. */
  readonly bullets: readonly string[]
}

/** The outcome of parsing one fragment: its parsed form, or one message per violation. */
export type FragmentResult = { readonly ok: true; readonly fragment: Fragment } | { readonly ok: false; readonly errors: readonly string[] }

/** A lowercase slug of words separated by hyphens, with the `.md` extension. */
const FRAGMENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Body text that names an internal identifier rather than a change people can perceive. */
const INTERNAL_REFERENCES: readonly { readonly pattern: RegExp; readonly kind: string }[] = [
  { pattern: /#\d+/, kind: 'an issue or pull request number' },
  { pattern: /\bWP\d/, kind: 'a work-package name' },
  { pattern: /\b[ACD]\d{1,3}\b/, kind: 'a decision or contract identifier' },
]

/**
 * Parse one fragment's front matter and body, and report each violation of the format.
 * @param path - the repository-relative path of the fragment, used in the file-name check.
 * @param text - the file's text.
 * @returns the parsed fragment, or the messages of every violation found.
 */
export function parseFragment(path: string, text: string): FragmentResult {
  const errors: string[] = []
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!FRAGMENT_NAME.test(name)) errors.push('the file name is not a lowercase `<slug>.md` of hyphen-separated words')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return { ok: false, errors: [...errors, 'the front matter does not open with `---` on the first line'] }
  const close = lines.indexOf('---', 1)
  if (close < 0) return { ok: false, errors: [...errors, 'the front matter does not close with `---`'] }
  const keys = lines.slice(1, close).filter(line => line.trim() !== '')
  const field = keys.length === 1 ? /^section:[ \t]*(.+?)[ \t]*$/.exec(keys[0] ?? '') : null
  if (field === null) errors.push('the front matter must hold exactly one `section:` line and no other field')
  const section = field === null ? undefined : field[1]?.replace(/^"(.*)"$/, '$1')
  if (section !== undefined && !(SECTIONS as readonly string[]).includes(section)) {
    errors.push(`section "${section}" is not one of ${SECTIONS.join(', ')}`)
  }
  const body = lines.slice(close + 1).map(line => line.trimEnd()).filter(line => line !== '')
  if (body.length === 0) errors.push('the body has no bullet line')
  for (const line of body) {
    if (!/^- \S/.test(line)) {
      errors.push(`body line "${line}" is not a bullet starting with \`- \``)
      continue
    }
    for (const { pattern, kind } of INTERNAL_REFERENCES) {
      if (pattern.test(line)) errors.push(`body line "${line}" names ${kind}; write the change in words a person using Delo understands`)
    }
  }
  if (errors.length > 0 || section === undefined || !(SECTIONS as readonly string[]).includes(section)) return { ok: false, errors }
  return { ok: true, fragment: { path, section: section as Section, bullets: body } }
}

/**
 * The fragment files in the unreleased folder of a repository, in name order.
 * @param root - the repository root.
 * @returns the repository-relative paths; empty when the folder does not exist.
 */
export function fragmentPaths(root: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(root, FRAGMENTS))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return names.map(name => `${FRAGMENTS}${name}`).filter(isFragmentPath).sort()
}
