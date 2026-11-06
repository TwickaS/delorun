/**
 * The locales the site serves and the route prefix of each.
 *
 * @module @delo/docs/locale
 */

/** A served locale. */
export type Locale = 'en' | 'zh'

/**
 * The route prefix of a locale: none for English, `/zh` for Chinese.
 * @param locale - the locale.
 * @returns the prefix, with no trailing slash.
 */
export function prefixOf(locale: Locale): string {
  return locale === 'zh' ? '/zh' : ''
}

/**
 * The Delo version the pages describe, from the release tooling's package.json, which the build reads into
 * `DELO_VERSION` (next.config.mjs).
 * @returns the version string.
 * @throws Error when the build did not set `DELO_VERSION`.
 */
export function deloVersion(): string {
  const version = process.env.DELO_VERSION
  if (version === undefined || version === '') throw new Error('docs-site: DELO_VERSION is unset; build through next.config.mjs')
  return version
}
