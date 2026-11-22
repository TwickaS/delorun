/** The version guard: the bundled studio client works only with homes inside the range its release declares (L158). */

import { gtr, ltr, satisfies, valid } from 'semver'

/**
 * The homes this app release's bundled client supports: its own release line and the one before it. The line starts at
 * the release the desktop app targets (the one after 0.1.0-preview.3, A585); the range moves with each app release.
 * A home older than the range lacks routes the client calls; a home newer may have changed the wire format.
 */
export const SUPPORTED_HOME_RANGE = '>=0.1.0-preview.4 <0.2.0-0'

/** The outcome of checking a home's version. */
export type VersionVerdict =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unreadable'; readonly range: string }
  | { readonly kind: 'older'; readonly version: string; readonly range: string }
  | { readonly kind: 'newer'; readonly version: string; readonly range: string }

/**
 * Compare a home's version with the supported range.
 * @param version - The version `delorun status --json` reports for the running home.
 * @param range - Supported range; this app release's by default.
 * @returns `supported`; `unreadable` when the version is not a version number; `older` (offer to update the home) or
 *   `newer` (offer to update the app), each naming both versions.
 */
export function checkHomeVersion(version: string, range: string = SUPPORTED_HOME_RANGE): VersionVerdict {
  if (valid(version) === null) return { kind: 'unreadable', range }
  const options = { includePrerelease: true }
  if (satisfies(version, range, options)) return { kind: 'supported' }
  if (ltr(version, range, options)) return { kind: 'older', version, range }
  return gtr(version, range, options) ? { kind: 'newer', version, range } : { kind: 'unreadable', range }
}
