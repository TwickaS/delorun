/**
 * Structural detector for postal addresses. A line holds an address when it carries a UK postcode or a US ZIP code
 * together with a street word. The detector matches shapes only: it stores no address and no list of places.
 *
 * @module @delo/tools/checks/gates/postal-address
 */

/** A UK postcode, in the outward and inward forms the Royal Mail publishes, with the GIR 0AA exception. */
const UK_POSTCODE = /\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/u

/** A US ZIP code, with its optional four-digit extension. */
const US_ZIP = /\b\d{5}(?:-\d{4})?\b/u

/** Street words that end a UK or US street name. */
const STREET_WORD = /\b(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Close|Drive|Dr|Way|Court|Ct|Terrace|Crescent|Place|Pl|Square|Boulevard|Blvd|Gardens|Mews|Parade)\b/iu

/**
 * The lines that carry a postal address shape: a UK postcode or a US ZIP code on the same line as a street word.
 * @param text - the text to scan.
 * @returns the 1-based numbers of the lines that match, in order.
 */
export function postalAddressLines(text: string): number[] {
  return text.split('\n').flatMap((line, index) => {
    const postcode = UK_POSTCODE.test(line) || US_ZIP.test(line)
    return postcode && STREET_WORD.test(line) ? [index + 1] : []
  })
}
