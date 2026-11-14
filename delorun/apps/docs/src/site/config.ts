/**
 * The site's deployment settings: where the site is published and the product site it links. A change of domain is a
 * change here and nowhere else.
 *
 * @module @delorun/docs/config
 */

/** The site's own origin, which each page names as its canonical URL. */
export const SITE_URL = 'https://docs.delorun.com'

/** The product site, which the navigation bar links. */
export const PRODUCT_URL = 'https://delorun.com'

/** The site path of the static search index, which the build writes and the search dialog downloads. */
export const SEARCH_INDEX_PATH = '/search.json'
