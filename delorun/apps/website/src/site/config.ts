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
export const GITHUB_URL = 'https://github.com/Delo-Run/delorun'

/** DeepSeek Harness, the project Delorun is a community fork of. */
export const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The address that answers every question about Delorun, the site and its privacy. */
export const SUPPORT_EMAIL = 'support@delorun.com'

/** The site path of the image that link previews show. */
export const OG_IMAGE_PATH = '/og.png'

/**
 * The site path of the studio picture in the home page's hero. PLACEHOLDER: `public/hero-studio.svg` holds a plain
 * frame until the real screenshot replaces it; change this path when the screenshot has another name or type.
 */
export const HERO_IMAGE_PATH = '/hero-studio.svg'

/** The pages the sitemap lists besides the blog index, which it lists once an article is published. */
export const SITEMAP_PATHS: readonly string[] = ['/', '/privacy']

/** The sender of the sign-up confirmation message: an address on the domain that Cloudflare Email Service sends for. */
export const UPDATES_EMAIL = 'updates@delorun.com'

/** The trading name that signs the site's messages. */
export const TRADING_NAME = 'Delo Run'
