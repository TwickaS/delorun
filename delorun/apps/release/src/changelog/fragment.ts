/**
 * Changelog fragments: one Markdown file per thing a person can perceive, with front matter that names its area and
 * section and a body of bullet lines. A fragment is unreleased (`delorun/changelog/unreleased/`), pending
 * (`delorun/changelog/pending/`: it describes something a person cannot reach yet and names what must be wired first) or
 * released (`delorun/changelog/releases/<version>/`). The format is documented in `delorun/changelog/README.md`.
 *
 * @module @delorun/release/changelog/fragment
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRAGMENTS } from '@delorun/tools/src/check-commits.ts'
import { isFragmentPath, isPendingPath, PENDING, RELEASES_DIR } from './paths.ts'
import { compareVersions } from './version.ts'

/** The sections of the release notes, in the order they print. */
export const SECTIONS = ['Security', 'Added', 'Changed', 'Fixed', 'Removed', 'From upstream'] as const

/** One release-notes section. */
export type Section = (typeof SECTIONS)[number]

/** The areas of a person's path from stock DeepSeek Harness to Delorun, in the order they print. */
export const AREAS = ['Install and update', 'Setup', 'Studio', 'Chats and workspaces', 'Safety and privacy', 'Reach', 'Plugins', 'Commands', 'Compatibility'] as const

/** One area. */
export type Area = (typeof AREAS)[number]

/** Which folder a fragment lives in; a pending fragment also carries `waits`. */
export type FragmentKind = 'unreleased' | 'pending'

/** One parsed fragment. */
export interface Fragment {
  /** The repository-relative path of the fragment file. */
  readonly path: string
  /** The area the front matter names. */
  readonly area: Area
  /** The section the front matter names. */
  readonly section: Section
  /** The body's bullet lines, each starting with `- `. */
  readonly bullets: readonly string[]
  /** The file name of an earlier fragment whose bullets this one supersedes in the standing comparison; undefined when none. */
  readonly replaces: string | undefined
  /** What must be wired before a person can reach the feature; set on a pending fragment only. */
  readonly waits: string | undefined
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

/** The front matter fields a fragment may hold. */
const FIELDS = ['section', 'area', 'replaces', 'waits'] as const

/**
 * Read the front matter lines into fields.
 * @param lines - the lines between the two `---` lines.
 * @param errors - receives one message per malformed or repeated line.
 * @returns the field values, unquoted.
 */
function readFields(lines: readonly string[], errors: string[]): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of lines.filter(candidate => candidate.trim() !== '')) {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()
    if (colon < 0 || !/^[a-z]+$/.test(name) || value === '') {
      errors.push(`front matter line "${line}" is not \`<field>: <value>\``)
    } else if (!(FIELDS as readonly string[]).includes(name)) {
      errors.push(`front matter field "${name}" is not one of ${FIELDS.join(', ')}`)
    } else if (fields.has(name)) {
      errors.push(`front matter field "${name}" appears twice`)
    } else {
      fields.set(name, value.replace(/^"(.*)"$/, '$1'))
    }
  }
  return fields
}

/**
 * Check the front matter values against the fragment's kind.
 * @param fields - the field values.
 * @param kind - the folder the fragment lives in.
 * @param errors - receives one message per violation.
 */
function checkFields(fields: ReadonlyMap<string, string>, kind: FragmentKind, errors: string[]): void {
  const section = fields.get('section')
  const area = fields.get('area')
  const replaces = fields.get('replaces')
  if (section === undefined) errors.push('the front matter has no `section:` line')
  else if (!(SECTIONS as readonly string[]).includes(section)) errors.push(`section "${section}" is not one of ${SECTIONS.join(', ')}`)
  if (area === undefined) errors.push('the front matter has no `area:` line')
  else if (!(AREAS as readonly string[]).includes(area)) errors.push(`area "${area}" is not one of ${AREAS.join(', ')}`)
  if (replaces !== undefined && !FRAGMENT_NAME.test(replaces)) errors.push(`replaces "${replaces}" is not a fragment file name such as \`some-feature.md\``)
  if (kind === 'pending') {
    if (!fields.has('waits')) errors.push('a pending fragment needs a `waits:` line that says what must be wired before a person can reach the feature')
    if (replaces !== undefined) errors.push('a pending fragment cannot carry `replaces:`; nothing was ever released from it')
  } else if (fields.has('waits')) {
    errors.push('`waits:` belongs to a fragment in the pending folder')
  }
}

/**
 * Parse one fragment's front matter and body, and report each violation of the format.
 * @param path - the repository-relative path of the fragment, used in the file-name check.
 * @param text - the file's text.
 * @param kind - the folder the fragment lives in; `unreleased` by default, which also fits a released fragment.
 * @returns the parsed fragment, or the messages of every violation found.
 */
export function parseFragment(path: string, text: string, kind: FragmentKind = 'unreleased'): FragmentResult {
  const errors: string[] = []
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!FRAGMENT_NAME.test(name)) errors.push('the file name is not a lowercase `<slug>.md` of hyphen-separated words')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return { ok: false, errors: [...errors, 'the front matter does not open with `---` on the first line'] }
  const close = lines.indexOf('---', 1)
  if (close < 0) return { ok: false, errors: [...errors, 'the front matter does not close with `---`'] }
  const fields = readFields(lines.slice(1, close), errors)
  checkFields(fields, kind, errors)
  const body = lines.slice(close + 1).map(line => line.trimEnd()).filter(line => line !== '')
  if (body.length === 0) errors.push('the body has no bullet line')
  for (const line of body) {
    if (!/^- \S/.test(line)) {
      errors.push(`body line "${line}" is not a bullet starting with \`- \``)
      continue
    }
    for (const { pattern, kind: referenceKind } of INTERNAL_REFERENCES) {
      if (pattern.test(line)) errors.push(`body line "${line}" names ${referenceKind}; write the change in words a person using Delorun understands`)
    }
  }
  const section = fields.get('section')
  const area = fields.get('area')
  if (errors.length > 0 || section === undefined || area === undefined) return { ok: false, errors }
  return { ok: true, fragment: { path, area: area as Area, section: section as Section, bullets: body, replaces: fields.get('replaces'), waits: fields.get('waits') } }
}

/**
 * The entries of a folder, or none when the folder does not exist.
 * @param folder - the absolute folder path.
 * @returns the entries with their kinds, unsorted.
 * @throws Error when the folder cannot be read for a reason other than being absent.
 */
function entriesOf(folder: string): { readonly name: string; readonly directory: boolean }[] {
  try {
    return readdirSync(folder, { withFileTypes: true }).map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * The fragment files in the unreleased folder of a repository, in name order.
 * @param root - the repository root.
 * @returns the repository-relative paths; empty when the folder does not exist.
 */
export function fragmentPaths(root: string): string[] {
  return entriesOf(join(root, FRAGMENTS)).map(entry => `${FRAGMENTS}${entry.name}`).filter(isFragmentPath).sort()
}

/**
 * The fragment files in the pending folder of a repository, in name order.
 * @param root - the repository root.
 * @returns the repository-relative paths; empty when the folder does not exist.
 */
export function pendingPaths(root: string): string[] {
  return entriesOf(join(root, PENDING)).map(entry => `${PENDING}${entry.name}`).filter(isPendingPath).sort()
}

/**
 * The fragment files that earlier assemblies moved under `releases/<version>/`, oldest version first.
 * @param root - the repository root.
 * @returns the repository-relative paths, ordered by version and then by name; empty when nothing was released.
 */
export function releasedPaths(root: string): string[] {
  const versions = entriesOf(join(root, RELEASES_DIR)).filter(entry => entry.directory).map(entry => entry.name).sort(compareVersions)
  return versions.flatMap(version => entriesOf(join(root, RELEASES_DIR, version)).filter(entry => !entry.directory && entry.name.endsWith('.md')).map(entry => `${RELEASES_DIR}/${version}/${entry.name}`).sort())
}

/**
 * Parse fragment files.
 * @param root - the repository root.
 * @param paths - the repository-relative fragment paths.
 * @param kind - the folder the fragments live in.
 * @returns the parsed fragments in path order, and one message per violation, each prefixed by its path.
 */
export function readFragments(root: string, paths: readonly string[], kind: FragmentKind = 'unreleased'): { readonly fragments: Fragment[]; readonly errors: string[] } {
  const fragments: Fragment[] = []
  const errors: string[] = []
  for (const path of paths) {
    const result = parseFragment(path, readFileSync(join(root, path), 'utf8'), kind)
    if (result.ok) fragments.push(result.fragment)
    else errors.push(...result.errors.map(error => `${path}: ${error}`))
  }
  return { fragments, errors }
}
