/**
 * Path classes the changelog gate and the assembly share: product files, which need a changelog entry, and changelog
 * fragments, which carry one.
 *
 * @module @delo/release/changelog/paths
 */
import { FRAGMENTS } from '@delo/tools/src/check-commits.ts'

/** Path prefixes whose changes never need a fragment. Markdown files anywhere are documentation and never need one. */
const NON_PRODUCT_PREFIXES = [
  'delo/docs/',
  'docs/',
  '.agents/',
  'delo/apps/tools/',
  'delo/apps/release/',
  '.github/',
  'delo/changelog/',
] as const

/** The README basenames of the fragment folder, which describe the format and never count as a fragment. */
const FOLDER_README = /^README(?:\.zh)?\.md$/

/**
 * Whether a change to a path is a product change, one that a commit must record in the changelog.
 * @param path - a repository-relative path, using `/` separators.
 * @returns true for a path outside the documentation, tooling, release and changelog trees that is not Markdown.
 */
export function isProductPath(path: string): boolean {
  return !path.endsWith('.md') && !NON_PRODUCT_PREFIXES.some(prefix => path.startsWith(prefix))
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
