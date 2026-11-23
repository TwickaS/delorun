/**
 * The site's deployment settings and the addresses it links. A change of domain or repository is a change here and
 * nowhere else.
 *
 * @module @delorun/website/config
 */

/** The site's own origin, which each page names as its canonical URL. */
export const SITE_URL = 'https://delorun.com'

/** The documentation site, which the header and the page links use. */
export const DOCS_URL = 'https://docs.delorun.com'

/** Delorun's repository. */
export const GITHUB_URL = 'https://github.com/twickas/delorun'

/** DeepSeek Harness, the project Delorun is a community fork of. */
export const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The address that answers every question about Delorun, the site and its privacy. */
export const SUPPORT_EMAIL = 'support@delorun.com'

/** The site path of the image that link previews show. */
export const OG_IMAGE_PATH = '/og.png'

/** The pages the sitemap lists besides the blog index, which it lists once an article is published. */
export const SITEMAP_PATHS: readonly string[] = ['/', '/privacy', '/notices']

/** The sender of the sign-up confirmation message: an address on the domain that Cloudflare Email Service sends for. */
export const UPDATES_EMAIL = 'updates@delorun.com'

/** The trading name that signs the site's messages. */
export const TRADING_NAME = 'Delorun'

/** The platforms the desktop app is planned for, in the order the button offers them when the visitor's is unknown. */
export const DESKTOP_PLATFORMS = ['macos', 'windows'] as const

/** One of {@link DESKTOP_PLATFORMS}. */
export type DesktopPlatform = typeof DESKTOP_PLATFORMS[number]

/**
 * The desktop app's download address for each platform. Every address is empty while the app is not released, which
 * keeps the download button unavailable; filling one in turns the button on for that platform, with the same layout.
 * An address must be `https` under one of {@link DESKTOP_DOWNLOAD_PLACES}; the button offers no other.
 */
export const DESKTOP_DOWNLOADS: Readonly<Record<DesktopPlatform, string>> = {
  macos: '',
  windows: '',
}

/** Where a desktop download may be served from: the release host, and the project's own releases on GitHub. */
export const DESKTOP_DOWNLOAD_PLACES = [
  { host: 'releases.delorun.com', path: '/' },
  { host: 'github.com', path: `${new URL(GITHUB_URL).pathname}/releases/download/` },
] as const

/**
 * Chunks the prerender renders in full but the browser loads on demand, by page file. The build links each chunk's
 * stylesheet from the page, so the page is styled with scripts off. `scripts/check-styles.ts` fails the build for a class
 * with no rule.
 */
export const RENDERED_CHUNK_STYLES: Readonly<Record<string, readonly string[]>> = {}
