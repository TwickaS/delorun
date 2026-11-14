/**
 * Structural detector for postal addresses. A street part is a house number, up to four words and a street word, all on
 * one line. An address shape is a street part followed by a full UK postcode, or by a US state abbreviation and ZIP code:
 * on the same line after the street word, or anywhere on the next line. The two-letter abbreviations of street words
 * count only inside that shape. The detector matches shapes only: it stores no address and no list of places.
 *
 * @module @delorun/tools/checks/gates/postal-address
 */

/**
 * A house number, up to four words and a street word, in that order on one line. Full street words and their
 * abbreviations match alike; {@link startsPostalAddress} accepts a street part only with the postcode or ZIP code that
 * completes the shape.
 */
const STREET_PART = /\b\d{1,5}[A-Za-z]?\b(?:\s+\S+){0,4}?\s+(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Close|Drive|Dr|Way|Court|Ct|Terrace|Crescent|Place|Pl|Square|Boulevard|Blvd|Gardens|Mews|Parade)\b/giu

/** A full UK postcode: the outward and inward parts separated by one space, with the GIR 0AA exception. */
const UK_POSTCODE = /\b(?:GIR 0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? \d[ABD-HJLNP-UW-Z]{2})\b/u

/** A US state abbreviation, one space, then a ZIP code with its optional four-digit extension. */
const US_STATE_ZIP = /\b[A-Z]{2} \d{5}(?:-\d{4})?\b/u

/**
 * Whether a line starts a postal address shape.
 * @param line - the line to check.
 * @param nextLine - the line after it in the same run of lines, or empty when it is the last line of the run.
 * @returns true when a street part on the line is followed by a UK postcode, or by a US state abbreviation and ZIP
 *   code, after the street word on the line or anywhere on `nextLine`.
 */
export function startsPostalAddress(line: string, nextLine = ''): boolean {
  for (const street of line.matchAll(STREET_PART)) {
    const rest = line.slice(street.index + street[0].length)
    if ([UK_POSTCODE, US_STATE_ZIP].some(tail => tail.test(rest) || tail.test(nextLine))) return true
  }
  return false
}
