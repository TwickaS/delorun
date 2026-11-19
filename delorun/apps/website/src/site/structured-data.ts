/**
 * The structured data the home page carries for search engines: Delorun as a free, MIT-licensed developer application,
 * with the version the site was built with when one is assembled.
 *
 * @module @delorun/website/structured-data
 */
import { GITHUB_URL, SITE_URL } from './config.ts'
import { COPY } from './copy.ts'

/** A schema.org `SoftwareApplication`, as JSON-LD. */
export interface SoftwareData {
  readonly '@context': 'https://schema.org'
  readonly '@type': 'SoftwareApplication'
  readonly name: string
  readonly description: string
  readonly url: string
  readonly applicationCategory: 'DeveloperApplication'
  readonly operatingSystem: string
  readonly license: string
  readonly sameAs: string
  readonly isAccessibleForFree: true
  readonly offers: { readonly '@type': 'Offer', readonly price: '0', readonly priceCurrency: 'GBP' }
  readonly softwareVersion?: string
}

/**
 * The home page's structured data.
 * @param version - the latest assembled version, if any.
 * @returns the data, which the page serialises into a JSON-LD script.
 */
export function softwareData(version: string | undefined): SoftwareData {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: COPY.siteTitle,
    description: COPY.description,
    url: `${SITE_URL}/`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, Windows (WSL2)',
    license: `${GITHUB_URL}/blob/main/LICENSE`,
    sameAs: GITHUB_URL,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    ...version === undefined ? {} : { softwareVersion: version },
  }
}
