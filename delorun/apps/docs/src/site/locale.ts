/**
 * The locales the site serves and the route prefix of each.
 *
 * @module @delorun/docs/locale
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
 * The Delorun version the pages describe: the newest version in the changelog record that the build publishes
 * (vite.config.ts).
 * @returns the version string; undefined when no version is assembled, which leaves the version line out.
 */
export function delorunVersion(): string | undefined {
  const version = import.meta.env.DELORUN_VERSION
  return version === undefined || version === '' ? undefined : version
}
