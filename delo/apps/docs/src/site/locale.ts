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
 * The locale a site path belongs to: Chinese under `/zh`, English elsewhere.
 * @param pathname - the site path.
 * @returns the locale.
 */
export function localeOfPath(pathname: string): Locale {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en'
}

/**
 * The `lang` and `hreflang` value of a locale.
 * @param locale - the locale.
 * @returns `en` or `zh-Hans`.
 */
export function htmlLangOf(locale: Locale): string {
  return locale === 'zh' ? 'zh-Hans' : 'en'
}

/**
 * The Delo version the pages describe, which the build reads from the release tooling's package.json (vite.config.ts).
 * @returns the version string.
 * @throws Error when the build did not set `DELO_VERSION`.
 */
export function deloVersion(): string {
  const version = import.meta.env.DELO_VERSION
  if (version === undefined || version === '') throw new Error('docs-site: DELO_VERSION is unset; build through vite.config.ts')
  return version
}
