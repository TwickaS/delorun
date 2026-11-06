/**
 * Path classes the changelog gate and the assembly share: product files, which need a changelog entry, and changelog
 * fragments, which carry one.
 *
 * @module @delo/release/changelog/paths
 */
import { FRAGMENTS } from '@delo/tools/src/check-commits.ts'

/** Path prefixes whose changes never need a fragment; documentation files anywhere never need one, as DOCUMENTATION_SUFFIXES names. */
const NON_PRODUCT_PREFIXES = [
  'delo/docs/',
  'docs/',
  '.agents/',
  'delo/apps/tools/',
  'delo/apps/release/',
  '.github/',
  'delo/changelog/',
] as const

/** File suffixes of documentation: Markdown, and the bilingual pairing records that sit beside it. */
const DOCUMENTATION_SUFFIXES = ['.md', '.i18n.yaml'] as const

/** The README basenames of the fragment folder, which describe the format and never count as a fragment. */
const FOLDER_README = /^README(?:\.zh)?\.md$/

/**
 * Whether a change to a path is a product change, one that a commit must record in the changelog.
 * @param path - a repository-relative path, using `/` separators.
 * @returns true for a path outside the documentation, tooling, release and changelog trees that is neither Markdown
 * nor a pairing record.
 */
export function isProductPath(path: string): boolean {
  return !DOCUMENTATION_SUFFIXES.some(suffix => path.endsWith(suffix)) && !NON_PRODUCT_PREFIXES.some(prefix => path.startsWith(prefix))
}

/**
 * Whether a path is a changelog fragment: a Markdown file directly in the unreleased folder, other than its READMEs.
 * @param path - a repository-relative path, using `/` separators.
 * @returns true when the path names a fragment file.
 */
export function isFragmentPath(path: string): boolean {
  if (!path.startsWith(FRAGMENTS) || !path.endsWith('.md')) return false
  const name = path.slice(FRAGMENTS.length)
  return !name.includes('/') && !FOLDER_README.test(name)
}
