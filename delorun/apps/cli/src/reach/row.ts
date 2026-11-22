/**
 * The `delorun-reach` row of a CLI profile by profile name: the profile's patch file for `delorun reach` and the start.
 * The row's fields, reading and writing are `@delorun/setup-apply`'s.
 *
 * @module @delorun/cli/reach/row
 */
import { join } from 'node:path'
import { readReachRowAt, writeReachRowAt, type TailscalePrivateRow } from '@delorun/setup-apply'
import { profileDirectory } from '../profile.ts'

/**
 * The profile's patch file.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the path of its `cordis.patch.yml`.
 */
export function profilePatchPath(home: string, profile: string): string {
  return join(profileDirectory(home, profile), 'cordis.patch.yml')
}

/**
 * Read the Tailscale private option from the profile's own patch.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the option, or `REACH_OFF` when the profile sets none.
 */
export function readReachRow(home: string, profile: string): TailscalePrivateRow {
  return readReachRowAt(profilePatchPath(home, profile))
}

/**
 * Write the Tailscale private option into the profile's own patch, with the C16 switch on.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param option - the option.
 */
export function writeReachRow(home: string, profile: string, option: TailscalePrivateRow): void {
  writeReachRowAt(profilePatchPath(home, profile), option)
}
