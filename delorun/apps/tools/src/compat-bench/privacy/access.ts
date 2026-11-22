/**
 * The optional `dsh.access` block of a plugin's `package.json` (A553): the author's own statement of what the plugin
 * does with the things the eight markers cover. Its keys are the marker keys; each value is a short reason in plain
 * English. The bench never trusts it to hide anything: a marker the bench sees without a declaration becomes a finding.
 *
 * ```json
 * { "dsh": { "access": {
 *   "sendsOut": "Fetches the page you ask it to read from the address you give.",
 *   "actsForYou": "Runs `git` to read the repository's history."
 * } } }
 * ```
 *
 * @module @delorun/tools/compat-bench/privacy/access
 */
import { MARKER_KEYS } from './types.ts'
import type { MarkerKey } from './types.ts'

/** The longest reason the bench keeps; a longer one is cut, with a problem noted. */
export const MAX_REASON_LENGTH = 200

/** The result of reading a manifest's access block. */
export type DeclaredAccess = Readonly<{
  /** The reasons by marker. */
  declared: Readonly<Partial<Record<MarkerKey, string>>>
  /** What is wrong with the block, in plain English; empty when it is well formed or absent. */
  problems: ReadonlyArray<string>
}>

/**
 * Read `dsh.access` from a parsed `package.json`.
 * @param manifest - the parsed manifest, or anything else when it could not be read.
 * @returns the reasons, and the problems found.
 */
export function readDeclaredAccess(manifest: unknown): DeclaredAccess {
  if (typeof manifest !== 'object' || manifest === null || !('dsh' in manifest)) return { declared: {}, problems: [] }
  const dsh = manifest.dsh
  if (typeof dsh !== 'object' || dsh === null || !('access' in dsh)) return { declared: {}, problems: [] }
  const access = dsh.access
  if (typeof access !== 'object' || access === null || Array.isArray(access)) return { declared: {}, problems: ['dsh.access is not an object'] }
  const declared: Partial<Record<MarkerKey, string>> = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(access)) {
    if (!(MARKER_KEYS as readonly string[]).includes(key)) {
      problems.push(`dsh.access.${key} is not one of: ${MARKER_KEYS.join(', ')}`)
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`dsh.access.${key} needs a short reason as a string`)
      continue
    }
    const reason = value.trim().replace(/\s+/g, ' ')
    if (reason.length > MAX_REASON_LENGTH) problems.push(`dsh.access.${key} is longer than ${MAX_REASON_LENGTH} characters; the card keeps the first ${MAX_REASON_LENGTH}`)
    declared[key as MarkerKey] = reason.slice(0, MAX_REASON_LENGTH)
  }
  return { declared, problems }
}
