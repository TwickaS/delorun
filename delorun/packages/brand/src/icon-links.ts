/**
 * The `<link rel="icon">` tags every page of the studio carries in its head, so one page presents the same tab icon
 * as another. The studio's `apps/web/index.html` holds them as static text (`tests/icon-links.spec.ts` keeps it equal);
 * the reach sign-in page fills them with its own content-hashed copies.
 * @module @delorun/brand/icon-links
 */

/** Where each icon file of the tab icon lives on a page. */
export interface IconLinkHrefs {
  /** The SVG for a light browser theme. */
  readonly light: string
  /** The SVG for a dark browser theme. */
  readonly dark: string
  /** The SVG for a browser that ignores `media` on `<link>`; listed first so the themed ones win where they work. */
  readonly fallback: string
  /** The multi-size `favicon.ico`, when the page's origin serves it. */
  readonly ico?: string
  /** The 32 pixel PNG favicon, for browsers that do not draw SVG tab icons. */
  readonly png?: string
  /** The 180 pixel home-screen icon iOS Safari takes from `apple-touch-icon`. */
  readonly appleTouch?: string
}

/**
 * The icon tags for a page head: a plain SVG fallback, the dark and light variants by `prefers-color-scheme`, and the ICO.
 * @param hrefs - the files' URLs on the page's origin.
 * @returns the tags, one per line, without indentation.
 */
export function iconLinkTags(hrefs: IconLinkHrefs): string {
  return [
    `<link rel="icon" type="image/svg+xml" href="${hrefs.fallback}">`,
    `<link rel="icon" type="image/svg+xml" href="${hrefs.dark}" media="(prefers-color-scheme: dark)">`,
    `<link rel="icon" type="image/svg+xml" href="${hrefs.light}" media="(prefers-color-scheme: light)">`,
    ...hrefs.ico === undefined ? [] : [`<link rel="icon" href="${hrefs.ico}" sizes="any">`],
    ...hrefs.png === undefined ? [] : [`<link rel="icon" type="image/png" sizes="32x32" href="${hrefs.png}">`],
    ...hrefs.appleTouch === undefined ? [] : [`<link rel="apple-touch-icon" href="${hrefs.appleTouch}">`],
  ].join('\n')
}
